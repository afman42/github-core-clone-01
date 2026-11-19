// rest.ts — GitHub REST v3 under /api/v3. All routes from the REST spec:
// repos CRUD + pagination, branches, commits, contents, labels, issues +
// comments, pulls + files + squash merge, git/refs, meta, user.
import { buildCommit, mergeBase, oidOf, parseCommit } from './gitobj.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { b64decode, b64encode, isOid } from './util.ts';

export interface RestCtx {
  method: string;
  segments: string[]; // path segments after /api/v3, decoded, empties removed
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  host: string; // Host header, for absolute pagination URLs
}
export interface RestRes {
  status: number;
  json: unknown; // null => no body (204)
  headers?: Record<string, string>;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): RestRes {
  return { status, json, headers };
}
function err(status: number, message: string): RestRes {
  return { status, json: { message } };
}
function parseBody(ctx: RestCtx): { value: Record<string, unknown> | null; invalid: boolean } {
  if (ctx.body.length === 0) return { value: {}, invalid: false };
  try {
    const v = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return { value: v as Record<string, unknown>, invalid: false };
    return { value: {}, invalid: false };
  } catch {
    return { value: null, invalid: true };
  }
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function isoOfSeq(seq: number): string {
  return new Date((1700000000 + seq) * 1000).toISOString();
}

// --- serializers ---------------------------------------------------------------
export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOfSeq(0),
    updated_at: isoOfSeq(repo.seq),
    pushed_at: isoOfSeq(repo.seq),
    language: null,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { name, color: l?.color ?? 'ededed', description: l?.description ?? '' };
    }),
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: isoOfSeq(issue.seq),
    updated_at: isoOfSeq(issue.seq),
    closed_at: issue.state === 'closed' ? isoOfSeq(issue.seq) : null,
    comments: issue.comments.length,
  };
}

function commitMessageOf(store: Store, repo: Repo, sha: string): string {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return '';
  const msg = parseCommit(obj.data).message;
  return msg.endsWith('\n') ? msg.slice(0, -1) : msg;
}

function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const c = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const author = c !== null ? c.author : '';
  const m = author.match(/^(.*) <(.*)> (\d+) \+0000$/);
  const date = m !== null ? new Date(Number(m[3]) * 1000).toISOString() : isoOfSeq(1);
  return {
    sha,
    commit: {
      message: commitMessageOf(store, repo, sha),
      author: { name: m !== null ? m[1] : '', email: m !== null ? m[2] : '', date },
      committer: { name: m !== null ? m[1] : '', email: m !== null ? m[2] : '', date },
    },
    author: { login: repo.owner },
    parents: (c?.parents ?? []).map((p) => ({ sha: p })),
  };
}

function pullJson(store: Store, repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: store.pullGlobalId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}`, user: { login: repo.owner } },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}`, user: { login: repo.owner } },
    merged: pr.merged,
    merged_at: pr.merged ? pr.mergedAt : null,
    merge_commit_sha: pr.merged ? pr.mergeCommitSha : null,
    mergeable: pr.merged ? false : !mergeConflicts(store, repo, pr),
    draft: false,
    created_at: isoOfSeq(pr.seq),
    updated_at: isoOfSeq(pr.seq),
    closed_at: pr.state === 'closed' ? isoOfSeq(pr.seq) : null,
  };
}

// --- file-map diff / merge -------------------------------------------------------
function diffFiles(
  base: Map<string, Buffer>,
  head: Map<string, Buffer>,
): { changed: Map<string, Buffer>; deleted: Set<string> } {
  const changed = new Map<string, Buffer>();
  const deleted = new Set<string>();
  for (const [path, bytes] of head) {
    const b = base.get(path);
    if (b === undefined || !b.equals(bytes)) changed.set(path, bytes);
  }
  for (const path of base.keys()) if (!head.has(path)) deleted.add(path);
  return { changed, deleted };
}

function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  const text = bytes.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Files of the three-way merge base (best common ancestor of the two tips). */
function mergeBaseFiles(store: Store, repo: Repo, pr: Pull): Map<string, Buffer> {
  const baseTip = store.branchTip(repo, pr.baseRef);
  const headTip = store.branchTip(repo, pr.headRef);
  if (baseTip === undefined || headTip === undefined) return new Map();
  const mb = mergeBase(repo.objects, headTip, baseTip);
  if (mb === null) return new Map();
  const mbObj = repo.objects.get(mb);
  if (mbObj === undefined || mbObj.type !== 'commit') return new Map();
  return store.flattenTree(repo, parseCommit(mbObj.data).tree);
}

/** True when a three-way merge of this PR would conflict. */
export function mergeConflicts(store: Store, repo: Repo, pr: Pull): boolean {
  const baseTip = store.branchTip(repo, pr.baseRef);
  const headTip = store.branchTip(repo, pr.headRef);
  if (baseTip === undefined || headTip === undefined) return false;
  const baseFiles = mergeBaseFiles(store, repo, pr);
  const headObj = repo.objects.get(headTip);
  if (headObj === undefined || headObj.type !== 'commit') return false;
  const headFiles = store.flattenTree(repo, parseCommit(headObj.data).tree);
  const curObj = repo.objects.get(baseTip);
  if (curObj === undefined || curObj.type !== 'commit') return false;
  const curFiles = store.flattenTree(repo, parseCommit(curObj.data).tree);
  const { changed: headChanged } = diffFiles(baseFiles, headFiles);
  const { changed: curChanged } = diffFiles(baseFiles, curFiles);
  for (const [path, headBytes] of headChanged) {
    const curBytes = curChanged.get(path);
    if (curBytes !== undefined && !curBytes.equals(headBytes)) return true;
  }
  // A path deleted on one side and modified on the other also conflicts.
  const { deleted: headDeleted } = diffFiles(baseFiles, headFiles);
  const { deleted: curDeleted } = diffFiles(baseFiles, curFiles);
  for (const path of headDeleted) if (curChanged.has(path)) return true;
  for (const path of curDeleted) if (headChanged.has(path)) return true;
  return false;
}

export function doSquashMerge(store: Store, repo: Repo, pr: Pull): { sha: string } | null {
  if (mergeConflicts(store, repo, pr)) return null;
  const baseTip = store.branchTip(repo, pr.baseRef) as string;
  const headTip = store.branchTip(repo, pr.headRef) as string;
  const baseFiles = mergeBaseFiles(store, repo, pr);
  const headObj = repo.objects.get(headTip) as { type: string; data: Buffer };
  const headFiles = store.flattenTree(repo, parseCommit(headObj.data).tree);
  const curObj = repo.objects.get(baseTip) as { type: string; data: Buffer };
  const curFiles = store.flattenTree(repo, parseCommit(curObj.data).tree);
  const { changed, deleted } = diffFiles(baseFiles, headFiles);
  for (const [path, bytes] of changed) curFiles.set(path, bytes);
  for (const path of deleted) curFiles.delete(path);
  store.tick();
  const treeOid = store.buildTreeFromMap(repo, curFiles);
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    author: store.authorLine(),
    committer: store.authorLine(),
    message: pr.title,
  });
  const sha = oidOf('commit', commitData);
  store.putObject(repo, 'commit', commitData);
  store.setBranch(repo, pr.baseRef, sha);
  repo.seq = store.seq;
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = store.isoNow();
  pr.mergeCommitSha = sha;
  return { sha };
}

/** Files changed between a PR's base and head branches (live diff). */
export function pullFiles(store: Store, repo: Repo, pr: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseTip = store.branchTip(repo, pr.baseRef);
  const headTip = store.branchTip(repo, pr.headRef);
  if (baseTip === undefined || headTip === undefined) return [];
  const baseObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(headTip);
  if (baseObj === undefined || headObj === undefined || baseObj.type !== 'commit' || headObj.type !== 'commit') return [];
  const baseFiles = store.flattenTree(repo, parseCommit(baseObj.data).tree);
  const headFiles = store.flattenTree(repo, parseCommit(headObj.data).tree);
  const { changed, deleted } = diffFiles(baseFiles, headFiles);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const [path, bytes] of changed) {
    const old = baseFiles.get(path);
    const status = old === undefined ? 'added' : 'modified';
    const additions = countLines(bytes);
    const deletions = old === undefined ? 0 : countLines(old);
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  for (const path of deleted) {
    const old = baseFiles.get(path) as Buffer;
    const deletions = countLines(old);
    out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return out;
}

export function createIssueRecord(store: Store, repo: Repo, title: string, body: string, labels: string[]): Issue {
  const number = repo.issueCounter + 1;
  repo.issueCounter = number;
  store.tick();
  const issue: Issue = {
    id: repo.id * 2000000 + number,
    number,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq: store.seq,
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPullRecord(store: Store, repo: Repo, head: string, base: string, title: string, body: string): Pull | null {
  const headSha = store.branchTip(repo, head);
  const baseSha = store.branchTip(repo, base);
  if (headSha === undefined || baseSha === undefined) return null;
  const baseObj = repo.objects.get(baseSha);
  if (baseObj === undefined || baseObj.type !== 'commit') return null;
  const number = repo.pullCounter + 1;
  repo.pullCounter = number;
  store.tick();
  const pr: Pull = {
    id: repo.id * 2000000 + 1000000 + number,
    number,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    baseTreeOid: parseCommit(baseObj.data).tree,
    merged: false,
    mergedAt: '',
    mergeCommitSha: '',
    seq: store.seq,
  };
  repo.pulls.set(number, pr);
  return pr;
}

// --- pagination ------------------------------------------------------------------
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], query: URLSearchParams): { items: T[]; hasNext: boolean; page: number; perPage: number } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), hasNext: start + perPage < items.length, page, perPage };
}

/** Absolute `Link: <...>; rel="next"` header when another page exists. */
function nextLink(ctx: RestCtx, path: string, p: { hasNext: boolean; page: number; perPage: number }): Record<string, string> {
  if (!p.hasNext) return {};
  return { link: `<http://${ctx.host}${path}?page=${p.page + 1}&per_page=${p.perPage}>; rel="next"` };
}

// --- main handler ------------------------------------------------------------------
export function handleRest(store: Store, ctx: RestCtx): RestRes {
  const seg = ctx.segments;
  const m = ctx.method;

  // Root / meta / user.
  if (seg.length === 0) {
    if (m === 'GET') {
      return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return err(404, 'Not Found');
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    return m === 'GET' ? ok(200, { installed_version: '1.0.0' }) : err(404, 'Not Found');
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (m === 'GET') {
      const v = store.viewer();
      return ok(200, { login: v.login, id: v.id, type: 'User', name: v.name, email: v.email });
    }
    return err(404, 'Not Found');
  }
  if (seg[0] === 'user' && seg[1] === 'repos') {
    if (m === 'GET') {
      const all = [...store.repos.values()];
      const p = paginate(all, ctx.query);
      const headers: Record<string, string> = {};
      if (p.hasNext) {
        headers.link = `<http://${ctx.host}/api/v3/user/repos?page=${p.page + 1}&per_page=${p.perPage}>; rel="next"`;
      }
      return ok(200, p.items.map((r) => repoJson(store, r)), headers);
    }
    if (m === 'POST') {
      const { value: body, invalid } = parseBody(ctx);
      if (invalid) return err(400, 'Malformed JSON body');
      const name = str(body?.name);
      if (name === '') return err(422, 'name is required');
      if (store.repos.has(name)) return err(422, 'Repository already exists');
      const defBranch = str(body?.default_branch);
      const repo = store.createRepo(name, str(body?.description), bool(body?.private, false), undefined, defBranch === '' ? undefined : defBranch);
      if (repo === null) return err(422, 'Repository already exists');
      return ok(201, repoJson(store, repo));
    }
    return err(404, 'Not Found');
  }

  if (seg[0] !== 'repos' || seg.length < 3) return err(404, 'Not Found');
  const owner = decodeURIComponentSafe(seg[1] as string);
  const repoName = decodeURIComponentSafe(seg[2] as string);
  store.noteOwner(owner);
  const repo = store.repoFor(owner, repoName);
  const rest = seg.slice(3);

  // GET /repos/{o}/{r} | PATCH | DELETE
  if (rest.length === 0) {
    if (repo === undefined) return err(404, 'Not Found');
    if (m === 'GET') return ok(200, repoJson(store, repo));
    if (m === 'DELETE') {
      store.deleteRepo(repoName);
      return { status: 204, json: null };
    }
    if (m === 'PATCH') {
      const { value: body, invalid } = parseBody(ctx);
      if (invalid) return err(400, 'Malformed JSON body');
      if (body !== null) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
      }
      return ok(200, repoJson(store, repo));
    }
    return err(404, 'Not Found');
  }

  if (repo === undefined) return err(404, 'Not Found');
  const sub = rest[0] as string;

  if (sub === 'branches') {
    if (rest.length === 1 && m === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([r]) => r.startsWith('refs/heads/'))
        .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      return ok(200, list);
    }
    if (rest.length === 2 && m === 'GET') {
      const branch = decodeURIComponentSafe(rest[1] as string);
      const tip = store.branchTip(repo, branch);
      if (tip === undefined) return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha: tip }, protected: false });
    }
    return err(404, 'Not Found');
  }

  if (sub === 'commits') {
    if (m !== 'GET') return err(404, 'Not Found');
    if (rest.length === 2) {
      const sha = decodeURIComponentSafe(rest[1] as string);
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') return err(404, 'Not Found');
      return ok(200, commitJson(store, repo, sha));
    }
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    let tip = store.branchTip(repo, ref);
    if (tip === undefined && isOid(ref) && repo.objects.get(ref)?.type === 'commit') tip = ref;
    if (tip === undefined) return ok(200, []);
    const history = store.branchHistory(repo, tip);
    return ok(200, history.map((sha) => commitJson(store, repo, sha)));
  }

  if (sub === 'contents') {
    return handleContents(store, repo, ctx, rest.slice(1));
  }

  if (sub === 'git' && (rest[1] === 'refs' || rest[1] === 'ref')) {
    if (rest[1] === 'ref' && m !== 'GET') return err(404, 'Not Found');
    if (m === 'POST' && rest.length === 2) {
      const { value: body, invalid } = parseBody(ctx);
      if (invalid) return err(400, 'Malformed JSON body');
      const ref = str(body?.ref);
      const sha = str(body?.sha);
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return err(422, 'Invalid ref');
      if (!isOid(sha) || repo.objects.get(sha) === undefined) return err(404, 'Not Found');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      repo.gitVersion += 1;
      return ok(201, { ref, object: { sha }, sha, commit: { sha } });
    }
    if (m === 'GET' && rest.length === 2) {
      const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
      return ok(200, list);
    }
    if (m === 'GET' && rest.length >= 3) {
      // /git/refs/heads/<branch> (branch names may contain slashes)
      const ref = rest.slice(2).map(decodeURIComponentSafe).join('/');
      const full = `refs/${ref}`;
      const sha = repo.refs.get(full);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { ref: full, object: { sha }, sha, commit: { sha } });
    }
    return err(404, 'Not Found');
  }

  if (sub === 'labels') {
    if (m === 'POST' && rest.length === 1) {
      const { value: body, invalid } = parseBody(ctx);
      if (invalid) return err(400, 'Malformed JSON body');
      const name = str(body?.name);
      if (name === '') return err(422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing !== undefined) return ok(201, { name, color: existing.color, description: existing.description, default: false });
      const label = { name, color: str(body?.color, 'ededed'), description: str(body?.description) };
      repo.labels.set(name, label);
      return ok(201, { name, color: label.color, description: label.description, default: false });
    }
    if (m === 'GET' && rest.length === 1) {
      return ok(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description, default: false })));
    }
    return err(404, 'Not Found');
  }

  if (sub === 'issues') {
    return handleIssues(store, repo, ctx, rest.slice(1));
  }

  if (sub === 'pulls') {
    return handlePulls(store, repo, ctx, rest.slice(1));
  }

  return err(404, 'Not Found');
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// --- contents ----------------------------------------------------------------------
function handleContents(store: Store, repo: Repo, ctx: RestCtx, pathSegs: string[]): RestRes {
  const path = pathSegs.map(decodeURIComponentSafe).join('/');
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = store.branchTip(repo, ref);
  const m = ctx.method;

  if (m === 'GET') {
    if (tip === undefined) return err(404, 'Not Found');
    const tipObj = repo.objects.get(tip);
    if (tipObj === undefined || tipObj.type !== 'commit') return err(404, 'Not Found');
    const files = store.flattenTree(repo, parseCommit(tipObj.data).tree);
    if (path === '') {
      return ok(200, dirEntries(store, repo, files, ''));
    }
    const exact = files.get(path);
    if (exact !== undefined) {
      const blobSha = store.putObject(repo, 'blob', exact);
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        content: b64encode(exact),
        sha: blobSha,
        size: exact.length,
        name: path.split('/').pop() ?? path,
        path,
      });
    }
    // Directory?
    const prefix = `${path}/`;
    let isDir = false;
    for (const p of files.keys()) if (p.startsWith(prefix)) { isDir = true; break; }
    if (!isDir) return err(404, 'Not Found');
    return ok(200, dirEntries(store, repo, files, path));
  }

  if (m === 'PUT') {
    const { value: body, invalid } = parseBody(ctx);
    if (invalid) return err(400, 'Malformed JSON body');
    const contentB64 = str(body?.content);
    if (contentB64 === '') return err(422, 'content is required');
    // Branch may arrive as a body field (real GitHub API) or as a query
    // parameter (?branch= / ?ref=); body wins.
    const branch = str(body?.branch) || ctx.query.get('branch') || ref;
    const bytes = b64decode(contentB64);
    const message = str(body?.message, 'update');
    const branchTip = store.branchTip(repo, branch);
    let currentSha: string | null = null;
    if (branchTip !== undefined) {
      const tipObj = repo.objects.get(branchTip);
      if (tipObj !== undefined && tipObj.type === 'commit') {
        const files = store.flattenTree(repo, parseCommit(tipObj.data).tree);
        const cur = files.get(path);
        if (cur !== undefined) currentSha = store.putObject(repo, 'blob', cur);
      }
    }
    const givenSha = str(body?.sha);
    if (givenSha !== '' && currentSha !== null && givenSha.toLowerCase() !== currentSha.toLowerCase()) {
      return err(409, 'sha does not match the current blob');
    }
    const isCreate = currentSha === null;
    const { commitSha, blobSha } = store.commitFileChange(repo, branch, path, bytes, message);
    return ok(isCreate ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
  }

  if (m === 'DELETE') {
    const { value: body, invalid } = parseBody(ctx);
    if (invalid) return err(400, 'Malformed JSON body');
    const branch = str(body?.branch) || ctx.query.get('branch') || ref;
    const branchTip = store.branchTip(repo, branch);
    if (branchTip === undefined) return err(404, 'Not Found');
    const tipObj = repo.objects.get(branchTip);
    if (tipObj === undefined || tipObj.type !== 'commit') return err(404, 'Not Found');
    const files = store.flattenTree(repo, parseCommit(tipObj.data).tree);
    if (!files.has(path)) return err(404, 'Not Found');
    const message = str(body?.message, 'delete');
    const { commitSha } = store.commitFileChange(repo, branch, path, null, message);
    return ok(200, { commit: { sha: commitSha } });
  }
  return err(404, 'Not Found');
}

function dirEntries(store: Store, repo: Repo, files: Map<string, Buffer>, dir: string): unknown[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { type: 'file' | 'dir'; files: Map<string, Buffer> }>();
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      children.set(rest, { type: 'file', files: new Map([[path, bytes]]) });
    } else {
      const name = rest.slice(0, slash);
      let child = children.get(name);
      if (child === undefined) {
        child = { type: 'dir', files: new Map() };
        children.set(name, child);
      }
      child.files.set(path, bytes);
    }
  }
  const out: unknown[] = [];
  for (const [name, child] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const fullPath = dir === '' ? name : `${dir}/${name}`;
    if (child.type === 'file') {
      const bytes = [...child.files.values()][0] as Buffer;
      out.push({ type: 'file', name, path: fullPath, sha: store.putObject(repo, 'blob', bytes), size: bytes.length });
    } else {
      // Subtree sha: build the tree for this directory's files (relative paths).
      const rel = new Map<string, Buffer>();
      for (const [p, b] of child.files) rel.set(p.slice(prefix.length), b);
      const treeOid = store.buildTreeFromMap(repo, rel);
      out.push({ type: 'dir', name, path: fullPath, sha: treeOid });
    }
  }
  return out;
}

// --- issues ------------------------------------------------------------------------
function handleIssues(store: Store, repo: Repo, ctx: RestCtx, rest: string[]): RestRes {
  const m = ctx.method;
  if (rest.length === 0) {
    if (m === 'POST') {
      const { value: body, invalid } = parseBody(ctx);
      if (invalid) return err(400, 'Malformed JSON body');
      const title = str(body?.title);
      if (title === '') return err(422, 'title is required');
      const labels = Array.isArray(body?.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      for (const l of labels) if (!repo.labels.has(l)) return err(422, `Label does not exist: ${l}`);
      const issue = createIssueRecord(store, repo, title, str(body?.body), labels);
      return ok(201, issueJson(store, repo, issue));
    }
    if (m === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      const sort = ctx.query.get('sort');
      const dir = ctx.query.get('direction') ?? 'desc';
      if (sort === 'created') {
        list.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      } else {
        list.sort((a, b) => b.seq - a.seq);
      }
      const p = paginate(list, ctx.query);
      return ok(200, p.items.map((i) => issueJson(store, repo, i)), nextLink(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, p));
    }
    return err(404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (rest.length === 1) {
    if (issue === undefined) return err(404, 'Not Found');
    if (m === 'GET') return ok(200, issueJson(store, repo, issue));
    if (m === 'PATCH') {
      const { value: body, invalid } = parseBody(ctx);
      if (invalid) return err(400, 'Malformed JSON body');
      if (body !== null) {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
      }
      return ok(200, issueJson(store, repo, issue));
    }
    return err(404, 'Not Found');
  }
  if (rest[1] === 'comments') {
    if (issue === undefined) return err(404, 'Not Found');
    if (m === 'POST') {
      const { value: body, invalid } = parseBody(ctx);
      if (invalid) return err(400, 'Malformed JSON body');
      const text = str(body?.body);
      repo.commentCounter += 1;
      store.tick();
      const comment = { id: repo.commentCounter, body: text, seq: store.seq };
      issue.comments.push(comment);
      return ok(201, { id: comment.id, body: comment.body });
    }
    if (m === 'GET') {
      return ok(200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

// --- pulls -------------------------------------------------------------------------
function handlePulls(store: Store, repo: Repo, ctx: RestCtx, rest: string[]): RestRes {
  const m = ctx.method;
  if (rest.length === 0) {
    if (m === 'POST') {
      const { value: body, invalid } = parseBody(ctx);
      if (invalid) return err(400, 'Malformed JSON body');
      const head = str(body?.head);
      const base = str(body?.base);
      const pr = createPullRecord(store, repo, head, base, str(body?.title), str(body?.body));
      if (pr === null) return err(404, 'Head or base branch not found');
      return ok(201, pullJson(store, repo, pr));
    }
    if (m === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      const p = paginate(list, ctx.query);
      return ok(200, p.items.map((pr) => pullJson(store, repo, pr)), nextLink(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, p));
    }
    return err(404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pr = repo.pulls.get(number);
  if (rest.length === 1) {
    if (pr === undefined) return err(404, 'Not Found');
    if (m === 'GET') return ok(200, pullJson(store, repo, pr));
    return err(404, 'Not Found');
  }
  if (rest[1] === 'files' && m === 'GET') {
    if (pr === undefined) return err(404, 'Not Found');
    return ok(200, pullFiles(store, repo, pr));
  }
  if (rest[1] === 'merge' && m === 'GET') {
    if (pr === undefined) return err(404, 'Not Found');
    if (pr.merged) return { status: 204, json: null };
    return err(404, 'Not Found');
  }
  if (rest[1] === 'merge' && m === 'PUT') {
    if (pr === undefined) return err(404, 'Not Found');
    if (pr.merged) return err(405, 'Pull request already merged');
    const merged = doSquashMerge(store, repo, pr);
    if (merged === null) return err(405, 'Merge conflict');
    return ok(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
  }
  return err(404, 'Not Found');
}
