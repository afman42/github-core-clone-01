// mcp.ts — Model Context Protocol at POST /mcp (JSON-RPC 2.0 Streamable HTTP).
// Modern era 2026-07-28 via `server/discover`, legacy era via `initialize` +
// `notifications/initialized`. Shares the same Store as REST/GraphQL/git.
//
// Contract details honoured:
// - discover result: supportedVersions ["2026-07-28"], capabilities.tools = {}
//   (an object, never a boolean), serverInfo in both result.serverInfo and
//   result._meta["io.modelcontextprotocol/serverInfo"].
// - tools/list byte-identical across calls (single module-level TOOLS array).
// - Six canonical tools, canonical property names, `required` a subset of the
//   suite's semantic args (title + owner/repo required on create_issue).
// - Unknown tool -> -32602; missing required args -> -32602 (or isError);
//   non-JSON body -> HTTP 400 with -32700 and the id recovered from the raw
//   text when present; unknown method -> -32601. Ids echoed verbatim.
// - Auth is enforced by app.ts before this handler runs (401, no auth header).
import { createIssueRecord, createPullRecord, doSquashMerge } from './rest.ts';
import type { Repo, Store } from './store.ts';

export interface McpRes {
  status: number;
  json: unknown | null; // null => empty body
}

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// --- tool definitions (single source; tools/list returns this exact array) -------
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        default_branch: { type: 'string', description: 'Default branch name.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name "owner/repo".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, all.' },
        per_page: { type: 'integer', description: 'Results per page.' },
        page: { type: 'integer', description: 'Page number.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'head', 'base', 'title'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
        merge_method: { type: 'string', description: 'Merge method (squash).' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

const TOOL_BY_NAME = new Map<string, (typeof TOOLS)[number]>(TOOLS.map((t) => [t.name, t]));

// --- argument helpers ---------------------------------------------------------------
function normKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Resolve a semantic argument from the call's arguments, trying canonical
 *  names and the suite's synonyms (normalized). */
function arg(args: Record<string, unknown>, names: string[]): unknown {
  const byNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(args)) {
    const n = normKey(k);
    if (!byNorm.has(n)) byNorm.set(n, v);
  }
  for (const name of names) {
    const v = byNorm.get(normKey(name));
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function argStr(args: Record<string, unknown>, names: string[]): string {
  const v = arg(args, names);
  return typeof v === 'string' ? v : v === undefined ? '' : String(v);
}

function argInt(args: Record<string, unknown>, names: string[]): number | undefined {
  const v = arg(args, names);
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return undefined;
}

/** Split owner/repo out of a full_name when the separate fields are absent. */
function ownerRepo(args: Record<string, unknown>, store: Store): { owner: string; repo: string } {
  let owner = argStr(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  let repo = argStr(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0] as string;
      if (repo === '') repo = parts[1] as string;
    }
  }
  if (owner === '') owner = store.viewerLogin();
  return { owner, repo };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    created_at: new Date(1700000000 * 1000).toISOString(),
    updated_at: new Date(1700000000 * 1000).toISOString(),
  };
}

function toolResult(data: unknown): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function rpcError(id: unknown, code: number, message: string): McpRes {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpRes {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } };
}

// --- tools/call -----------------------------------------------------------------------
function callTool(store: Store, name: string, argsRaw: unknown): { errorCode?: number; errorMessage?: string; result?: Record<string, unknown> } {
  const def = TOOL_BY_NAME.get(name);
  if (def === undefined) return { errorCode: -32602, errorMessage: `Unknown tool: ${name}` };
  const args: Record<string, unknown> = argsRaw !== null && typeof argsRaw === 'object' && !Array.isArray(argsRaw)
    ? (argsRaw as Record<string, unknown>)
    : {};
  const missing = (def.inputSchema.required as string[]).filter((req) => {
    if (req === 'owner' || req === 'repo') {
      const { owner, repo } = ownerRepo(args, store);
      if (req === 'owner') return owner === '';
      return repo === '';
    }
    const v = arg(args, [req]);
    return v === undefined || v === null || v === '';
  });
  if (missing.length > 0) {
    return { errorCode: -32602, errorMessage: `Missing required arguments: ${missing.join(', ')}` };
  }
  switch (name) {
    case 'create_repo': {
      const repoName = argStr(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
      if (repoName === '') return { result: toolError('Repository name is required.') };
      const owner = argStr(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'login']);
      const desc = argStr(args, ['description', 'about', 'summary', 'body']);
      const priv = arg(args, ['private', 'is_private']);
      const defBranch = argStr(args, ['default_branch', 'defaultbranch']);
      const ownerLogin = owner === '' ? store.viewerLogin() : owner;
      if (store.repoFor(ownerLogin, repoName) !== undefined) {
        return { result: toolError(`Repository ${ownerLogin}/${repoName} already exists.`) };
      }
      const repo = store.createRepo(ownerLogin, repoName, desc, priv === true, defBranch === '' ? 'main' : defBranch);
      return { result: toolResult(repoJson(store, repo)) };
    }
    case 'get_repo': {
      const { owner, repo } = ownerRepo(args, store);
      const found = store.repoFor(owner, repo);
      if (found === undefined) return { result: toolError(`Repository ${owner}/${repo} not found.`) };
      return { result: toolResult(repoJson(store, found)) };
    }
    case 'create_issue': {
      const { owner, repo } = ownerRepo(args, store);
      const found = store.repoFor(owner, repo);
      if (found === undefined) return { result: toolError(`Repository ${owner}/${repo} not found.`) };
      const title = argStr(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
      if (title === '') return { result: toolError('Issue title is required.') };
      const body = argStr(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']);
      const labelsRaw = arg(args, ['labels']);
      const labels = Array.isArray(labelsRaw) ? labelsRaw.filter((l): l is string => typeof l === 'string') : [];
      for (const l of labels) if (!found.labels.has(l)) {
        return { result: toolError(`Label does not exist: ${l}`) };
      }
      const issue = createIssueRecord(store, found, title, body, labels);
      return {
        result: toolResult({
          id: store.issueGlobalId(found, issue),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          full_name: `${owner}/${repo}`,
          html_url: `/${owner}/${repo}/issues/${issue.number}`,
          url: `/${owner}/${repo}/issues/${issue.number}`,
        }),
      };
    }
    case 'list_issues': {
      const { owner, repo } = ownerRepo(args, store);
      const found = store.repoFor(owner, repo);
      if (found === undefined) return { result: toolError(`Repository ${owner}/${repo} not found.`) };
      const state = argStr(args, ['state', 'status']).toLowerCase();
      let list = [...found.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      const perPage = argInt(args, ['per_page', 'perpage']) ?? 30;
      const page = argInt(args, ['page']) ?? 1;
      const slice = list.slice((page - 1) * perPage, page * perPage);
      return {
        result: toolResult({
          issues: slice.map((i) => ({
            id: store.issueGlobalId(found, i),
            number: i.number,
            title: i.title,
            body: i.body,
            state: i.state,
            labels: i.labels,
            url: `/${owner}/${repo}/issues/${i.number}`,
          })),
          total_count: list.length,
        }),
      };
    }
    case 'create_pull_request': {
      const { owner, repo } = ownerRepo(args, store);
      const found = store.repoFor(owner, repo);
      if (found === undefined) return { result: toolError(`Repository ${owner}/${repo} not found.`) };
      const title = argStr(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
      const body = argStr(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']);
      const head = argStr(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
      const base = argStr(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
      const pr = createPullRecord(store, found, head, base, title, body);
      if (pr === null) return { result: toolError(`Head or base branch not found: ${head} / ${base}`) };
      return {
        result: toolResult({
          id: store.pullGlobalId(found, pr),
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          head: { ref: pr.headRef },
          head_ref: pr.headRef,
          base: { ref: pr.baseRef },
          base_ref: pr.baseRef,
          full_name: `${owner}/${repo}`,
          html_url: `/${owner}/${repo}/pull/${pr.number}`,
        }),
      };
    }
    case 'merge_pull_request': {
      const { owner, repo } = ownerRepo(args, store);
      const found = store.repoFor(owner, repo);
      if (found === undefined) return { result: toolError(`Repository ${owner}/${repo} not found.`) };
      const number = argInt(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
      if (number === undefined) return { result: toolError('Pull request number is required.') };
      const pr = found.pulls.get(number);
      if (pr === undefined) return { result: toolError(`Pull request #${number} not found.`) };
      if (pr.merged) {
        return { result: toolResult({ merged: true, number, state: 'MERGED' }) };
      }
      const merged = doSquashMerge(store, found, pr);
      if (merged === null) return { result: toolError(`Pull request #${number} has merge conflicts.`) };
      return { result: toolResult({ merged: true, number, state: 'MERGED', merge_commit_sha: merged.sha }) };
    }
    default:
      return { errorCode: -32602, errorMessage: `Unknown tool: ${name}` };
  }
}

// --- entry point ------------------------------------------------------------------------
export function handleMcp(store: Store, body: Buffer): McpRes {
  const raw = body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Recover the id from the raw text when possible (parse-error check).
    let id: unknown = null;
    const m = /"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")/.exec(raw);
    if (m !== null) {
      const v = m[1] as string;
      id = v.startsWith('"') ? JSON.parse(v) : Number(v);
    }
    return { status: 400, json: { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = parsed as Record<string, unknown>;
  const method = typeof req.method === 'string' ? req.method : '';
  const id = req.id;
  const params = req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params)
    ? (req.params as Record<string, unknown>)
    : {};

  // Notifications (no id) get no JSON-RPC response: HTTP 202, empty body.
  if (id === undefined) {
    return { status: 202, json: null };
  }

  switch (method) {
    case 'server/discover': {
      const result = {
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      };
      return rpcResult(id, result);
    }
    case 'initialize': {
      const clientVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = clientVersion === MODERN_REVISION
        ? MODERN_REVISION
        : LEGACY_REVISIONS.includes(clientVersion)
          ? clientVersion
          : '2025-11-25';
      const result = {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      };
      return rpcResult(id, result);
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const out = callTool(store, name, params.arguments);
      if (out.errorCode !== undefined) return rpcError(id, out.errorCode, out.errorMessage ?? 'Tool call failed');
      return rpcResult(id, out.result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
