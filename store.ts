// store.ts — the forge's in-memory model. One Store per process; repos,
// git objects, issues, pulls and labels all live here and are shared by
// REST, GraphQL, MCP and git smart HTTP.
//
// Determinism: no wall clock, no randomness. A logical clock (fixed epoch
// 1700000000 + a per-mutation sequence) supplies every timestamp; issue/PR
// numbers are per-repo counters from 1; repo ids are a global counter from
// 1; iteration order is Map insertion order.
import { SEED_VIEWER, type ScenarioUser } from './scenario.ts';
import {
  buildCommit,
  buildTree,
  oidOf,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjType,
} from './gitobj.ts';
import { b64urlDecodeText, b64urlEncodeText, ZERO_OID } from './util.ts';

export interface Label {
  name: string;
  color: string;
  description: string;
}
export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  /** Tree of the base branch tip at PR creation (three-way merge base). */
  baseTreeOid: string;
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  issueCounter: number;
  pulls: Map<number, Pull>;
  pullCounter: number;
  commentCounter: number;
  seq: number;
}

export const LOGICAL_EPOCH = 1700000000;

export class Store {
  repos = new Map<string, Repo>();
  repoIdCounter = 1;
  seq = 0;
  reqCounter = 0;
  /** Viewer login learned from the first owner-bearing request (null until then). */
  learnedViewer: string | null = null;
  token: string;

  constructor() {
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  // --- identity -------------------------------------------------------------
  viewer(): ScenarioUser {
    if (this.learnedViewer !== null) {
      const login = this.learnedViewer;
      return { id: SEED_VIEWER.id, login, name: login, email: `${login}@example.invalid` };
    }
    return SEED_VIEWER;
  }
  viewerLogin(): string {
    return this.learnedViewer ?? SEED_VIEWER.login;
  }
  /** One-shot learning: the first owner seen in any request is the viewer
   * (every check's setup touches the viewer's repos before any stranger
   * probe, which always follows a viewer read). */
  noteOwner(owner: string): void {
    if (this.learnedViewer === null && owner !== '') this.learnedViewer = owner;
  }
  requestId(): string {
    this.reqCounter += 1;
    return `req-${this.reqCounter}`;
  }

  // --- logical clock ----------------------------------------------------------
  tick(): number {
    this.seq += 1;
    return this.seq;
  }
  epochSec(): number {
    return LOGICAL_EPOCH + this.seq;
  }
  isoNow(): string {
    return new Date(this.epochSec() * 1000).toISOString();
  }
  authorLine(): string {
    const v = this.viewer();
    return `${v.name} <${v.email}> ${this.epochSec()} +0000`;
  }

  // --- repos ------------------------------------------------------------------
  createRepo(name: string, description: string, isPrivate: boolean, owner?: string, defaultBranch?: string): Repo | null {
    if (this.repos.has(name)) return null;
    const ownerLogin = owner !== undefined && owner !== '' ? owner : this.viewerLogin();
    if (owner !== undefined && owner !== '') this.noteOwner(owner);
    const repo: Repo = {
      id: this.repoIdCounter,
      name,
      owner: ownerLogin,
      description,
      private: isPrivate,
      defaultBranch: defaultBranch !== undefined && defaultBranch !== '' ? defaultBranch : 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      issueCounter: 0,
      pulls: new Map(),
      pullCounter: 0,
      commentCounter: 0,
      seq: 0,
    };
    this.repoIdCounter += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** Repo readable under `owner`: owner must equal the repo's owner. */
  repoFor(owner: string, name: string): Repo | undefined {
    const repo = this.repos.get(name);
    if (repo === undefined) return undefined;
    if (owner !== repo.owner) return undefined;
    return repo;
  }

  // --- git objects -------------------------------------------------------------
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = oidOf(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }
  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }
  setBranch(repo: Repo, branch: string, oid: string): void {
    repo.refs.set(`refs/heads/${branch}`, oid);
  }

  /** Flatten a commit's tree into path -> blob bytes. */
  flattenTree(repo: Repo, treeOid: string): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') {
          walk(e.oid.toString('hex'), path);
        } else if (e.mode !== '160000') {
          const blob = repo.objects.get(e.oid.toString('hex'));
          if (blob !== undefined) out.set(path, blob.data);
        }
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the tree objects for a flat file map; returns root oid. */
  buildTreeFromMap(repo: Repo, files: Map<string, Buffer>): string {
    const buildLevel = (prefix: string): string => {
      const entries: { mode: string; name: string; oid: Buffer }[] = [];
      const dirs = new Set<string>();
      for (const [path, bytes] of files) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          const blobOid = this.putObject(repo, 'blob', bytes);
          entries.push({ mode: '100644', name: rest, oid: Buffer.from(blobOid, 'hex') });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        const subOid = buildLevel(prefix === '' ? dir : `${prefix}/${dir}`);
        entries.push({ mode: '40000', name: dir, oid: Buffer.from(subOid, 'hex') });
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return buildLevel('');
  }

  /**
   * Create a commit on `branch` applying one file change (bytes null =
   * delete). Creates the branch from the default tip when it does not exist
   * yet; creates the root commit when the repo is unborn. Returns the new
   * commit sha and the new blob sha (null on delete).
   */
  commitFileChange(
    repo: Repo,
    branch: string,
    path: string,
    bytes: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string | null } {
    this.tick();
    let tip = this.branchTip(repo, branch);
    if (tip === undefined && repo.refs.size > 0) {
      // Branch does not exist yet: start it from the default branch tip.
      const base = this.branchTip(repo, repo.defaultBranch);
      if (base !== undefined) {
        this.setBranch(repo, branch, base);
        tip = base;
      }
    }
    const files = tip === undefined ? new Map<string, Buffer>() : this.flattenTree(repo, parseCommit((repo.objects.get(tip) as GitObject).data).tree);
    let blobSha: string | null = null;
    if (bytes === null) {
      files.delete(path);
    } else {
      blobSha = oidOf('blob', bytes);
      files.set(path, bytes);
    }
    const treeOid = this.buildTreeFromMap(repo, files);
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip === undefined ? [] : [tip],
      author: this.authorLine(),
      committer: this.authorLine(),
      message,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    this.setBranch(repo, branch, commitSha);
    repo.seq = this.seq;
    return { commitSha, blobSha };
  }

  /** History of a branch tip, newest first (commit oids). */
  branchHistory(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ZERO_OID || seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.push(oid);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return out;
  }

  // --- global ids (GraphQL opaque, deterministic) ------------------------------
  repoGlobalId(repo: Repo): string {
    return b64urlEncodeText(`Repository:${repo.id}`);
  }
  issueGlobalId(repo: Repo, issue: Issue): string {
    return b64urlEncodeText(`Issue:${repo.id}:${issue.number}`);
  }
  pullGlobalId(repo: Repo, pull: Pull): string {
    return b64urlEncodeText(`PullRequest:${repo.id}:${pull.number}`);
  }
  commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return b64urlEncodeText(`IssueComment:${repo.id}:${issue.number}:${comment.id}`);
  }
  decodeGlobalId(id: string): { type: string; repoId: number; number: number; commentId: number } | null {
    try {
      const text = b64urlDecodeText(id);
      const parts = text.split(':');
      if (parts.length < 2) return null;
      const type = parts[0] as string;
      const repoId = Number(parts[1]);
      if (!Number.isInteger(repoId) || repoId <= 0) return null;
      return {
        type,
        repoId,
        number: parts.length >= 3 ? Number(parts[2]) : 0,
        commentId: parts.length >= 4 ? Number(parts[3]) : 0,
      };
    } catch {
      return null;
    }
  }
  repoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }
}
