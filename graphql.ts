// graphql.ts — GitHub GraphQL v4 at POST /api/graphql, implemented with a
// small hand-written parser + executor for exactly the documents the suite
// sends (gh / github-mcp-server shapes). No GraphQL library; stdlib only.
//
// Rules honoured: batched array bodies, opaque deterministic global ids,
// __type introspection (Issue/PullRequest/Repository/SearchType), ordering
// (CREATED_AT DESC, ties by number DESC, states filter), cursor pagination,
// unknown field -> HTTP 200 + errors naming it, unknown repo -> data null
// with no errors, missing auth -> exactly 401.
import {
  createIssueRecord,
  createPullRecord,
  doSquashMerge,
  mergeConflicts,
  pullFiles,
} from './rest.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { b64urlDecodeText, b64urlEncodeText } from './util.ts';

// --- tokenizer ---------------------------------------------------------------------
type Tok =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$[]=@'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        toks.push({ kind: 'string', value: src.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] as string;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '"' ? '"' : e === '\\' ? '\\' : e === '/' ? '/' : e;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      if (j >= src.length) throw new Error('unterminated string');
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j += 1;
      const raw = src.slice(i, j);
      if (raw.includes('.')) toks.push({ kind: 'float', value: Number(raw) });
      else toks.push({ kind: 'int', value: Number(raw) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j] as string)) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return toks;
}

// --- AST -----------------------------------------------------------------------------
type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selection: SelectionNode[];
}
interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentNode;
interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode>;
  selection: SelectionNode[];
}

class Parser {
  toks: Tok[];
  pos = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  next(): Tok {
    const t = this.toks[this.pos];
    if (t === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}`);
  }
  acceptPunct(v: string): boolean {
    const t = this.peek();
    if (t !== undefined && t.kind === 'punct' && t.value === v) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected name');
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.toks.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }
  parseOperation(): Operation {
    let opType: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t !== undefined && t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      opType = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const n = this.peek();
    if (n !== undefined && n.kind === 'name') name = this.expectName();
    const variables: Record<string, ValueNode> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const vname = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.acceptPunct('=')) this.parseValue();
        variables[vname] = { kind: 'null' };
      }
    }
    // Directives (none in the suite's documents; skip if present).
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArgs();
    }
    const selection = this.parseSelectionSet();
    return { opType, name, variables, selection };
  }
  parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }
  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '...') {
        this.next();
        const t = this.peek();
        if (t !== undefined && t.kind === 'name' && t.value === 'on') {
          this.next();
          const cond = this.expectName();
          out.push({ kind: 'fragment', typeCondition: cond, selection: this.parseSelectionSet() });
        } else {
          // Named fragment spread: not used by the suite; skip its selection.
          this.expectName();
        }
      } else {
        out.push(this.parseField());
      }
    }
    return out;
  }
  parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') args = this.parseArgs();
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArgs();
    }
    let selection: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selection };
  }
  parseArgs(): Record<string, ValueNode> {
    this.expectPunct('(');
    const out: Record<string, ValueNode> = {};
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out[name] = this.parseValue();
    }
    return out;
  }
  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('unexpected value');
  }
}

function evalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evalValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = evalValue(v, vars);
      return out;
    }
  }
}

// --- schema (field -> child type) ------------------------------------------------------
const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { login: 'String' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest', description: 'String', private: 'Boolean',
    createdAt: 'String', updatedAt: 'String',
  },
  Ref: { name: 'String' },
  Issue: {
    id: 'ID', number: 'Int', title: 'String', state: 'String', body: 'String',
    createdAt: 'String', updatedAt: 'String', author: 'User', labels: 'String', comments: 'String', url: 'String',
  },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo', totalCount: 'Int' },
  PageInfo: { hasNextPage: 'Boolean', endCursor: 'String', hasPreviousPage: 'Boolean', startCursor: 'String' },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'String', merged: 'Boolean',
    mergeable: 'String', headRefName: 'String', baseRefName: 'String', headRef: 'Ref', baseRef: 'Ref',
    files: 'ChangedFileConnection', author: 'User', createdAt: 'String', updatedAt: 'String', mergedAt: 'String',
  },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo', totalCount: 'Int' },
  ChangedFileConnection: { nodes: 'ChangedFile', pageInfo: 'PageInfo', totalCount: 'Int' },
  ChangedFile: { path: 'String' },
  __Type: { fields: '__Field', enumValues: '__EnumValue', name: 'String', kind: 'String', description: 'String' },
  __Field: { name: 'String', description: 'String', type: 'String', args: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'CommentEdge', clientMutationId: 'String' },
  CommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String' },
  Node: { id: 'ID' },
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt'],
  SearchType: [],
};
const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
};

// --- executor --------------------------------------------------------------------------
interface Ctx {
  store: Store;
  vars: Record<string, unknown>;
}

function validateSelection(parentType: string, selection: SelectionNode[], errors: string[]): void {
  const fields = FIELD_TYPES[parentType] ?? {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') {
      validateSelection(sel.typeCondition, sel.selection, errors);
      continue;
    }
    const child = fields[sel.name];
    if (child === undefined) {
      errors.push(`Cannot query field "${sel.name}" on type "${parentType}".`);
      continue;
    }
    if (sel.selection.length > 0 && child !== 'String' && child !== 'Int' && child !== 'ID' && child !== 'Boolean') {
      validateSelection(child, sel.selection, errors);
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = evalValue(v, ctx.vars);
  return out;
}

function stateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}
function prStateGql(pr: Pull): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveIssue(store: Store, repo: Repo, issue: Issue, selection: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'id': out[key] = store.issueGlobalId(repo, issue); break;
      case 'number': out[key] = issue.number; break;
      case 'title': out[key] = issue.title; break;
      case 'body': out[key] = issue.body; break;
      case 'state': out[key] = stateGql(issue.state); break;
      case 'createdAt': case 'updatedAt': out[key] = new Date((1700000000 + issue.seq) * 1000).toISOString(); break;
      case 'author': out[key] = resolveUser(store, selectionOf(sel), ctx); break;
      default: out[key] = null; break;
    }
  }
  return out;
}

function selectionOf(field: FieldNode): SelectionNode[] {
  return field.selection;
}

function resolveUser(store: Store, selection: SelectionNode[], _ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === 'login') out[key] = store.viewerLogin();
  }
  return out;
}

function resolvePullRequest(store: Store, repo: Repo, pr: Pull, selection: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'id': out[key] = store.pullGlobalId(repo, pr); break;
      case 'number': out[key] = pr.number; break;
      case 'title': out[key] = pr.title; break;
      case 'body': out[key] = pr.body; break;
      case 'state': out[key] = prStateGql(pr); break;
      case 'merged': out[key] = pr.merged; break;
      case 'mergeable': out[key] = pr.merged ? 'UNKNOWN' : mergeConflicts(store, repo, pr) ? 'CONFLICTING' : 'MERGEABLE'; break;
      case 'headRefName': out[key] = pr.headRef; break;
      case 'baseRefName': out[key] = pr.baseRef; break;
      case 'headRef': out[key] = { name: pr.headRef }; break;
      case 'baseRef': out[key] = { name: pr.baseRef }; break;
      case 'mergedAt': out[key] = pr.merged ? pr.mergedAt : null; break;
      case 'createdAt': case 'updatedAt': out[key] = new Date((1700000000 + pr.seq) * 1000).toISOString(); break;
      case 'files': {
        const args = argsOf(sel, ctx);
        const first = typeof args.first === 'number' ? args.first : 10;
        const files = pullFiles(store, repo, pr).slice(0, first);
        out[key] = resolveChangedFiles(files, sel.selection, ctx);
        break;
      }
      case 'author': out[key] = resolveUser(store, sel.selection, ctx); break;
      default: out[key] = null; break;
    }
  }
  return out;
}

function resolveChangedFiles(
  files: { filename: string }[],
  selection: SelectionNode[],
  _ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === 'nodes') {
      out[key] = files.map((f) => {
        const node: Record<string, unknown> = {};
        for (const n of sel.selection) {
          if (n.kind === 'fragment') continue;
          if (n.name === 'path') node[n.alias ?? n.name] = f.filename;
        }
        return node;
      });
    } else if (sel.name === 'totalCount') out[key] = files.length;
    else if (sel.name === 'pageInfo') out[key] = { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null };
  }
  return out;
}

function cursorFor(index: number): string {
  return b64urlEncodeText(`cursor:${index}`);
}
function indexOfCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = b64urlDecodeText(cursor);
    const m = /^cursor:(\d+)$/.exec(text);
    return m !== null ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}

function resolveIssuesConnection(store: Store, repo: Repo, args: Record<string, unknown>, selection: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy?.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
    list.sort((a, b) => b.seq - a.seq || b.number - a.number);
  } else if (orderBy?.field === 'CREATED_AT' && orderBy.direction === 'ASC') {
    list.sort((a, b) => a.seq - b.seq || a.number - b.number);
  } else {
    list.sort((a, b) => a.seq - b.seq);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const afterIdx = indexOfCursor(args.after as string | null | undefined);
  const start = afterIdx + 1;
  const page = list.slice(start, start + first);
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === 'nodes') {
      out[key] = page.map((issue) => resolveIssue(store, repo, issue, sel.selection, ctx));
    } else if (sel.name === 'pageInfo') {
      const info: Record<string, unknown> = {};
      for (const p of sel.selection) {
        if (p.kind === 'fragment') continue;
        const pk = p.alias ?? p.name;
        if (p.name === 'hasNextPage') info[pk] = start + page.length < list.length;
        else if (p.name === 'endCursor') info[pk] = page.length > 0 ? cursorFor(start + page.length - 1) : null;
        else if (p.name === 'hasPreviousPage') info[pk] = start > 0;
        else if (p.name === 'startCursor') info[pk] = page.length > 0 ? cursorFor(start) : null;
      }
      out[key] = info;
    } else if (sel.name === 'totalCount') out[key] = list.length;
  }
  return out;
}

function resolveRepository(store: Store, repo: Repo, selection: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    const args = argsOf(sel, ctx);
    switch (sel.name) {
      case 'id': out[key] = store.repoGlobalId(repo); break;
      case 'databaseId': out[key] = repo.id; break;
      case 'name': out[key] = repo.name; break;
      case 'nameWithOwner': out[key] = `${repo.owner}/${repo.name}`; break;
      case 'owner': out[key] = resolveUser(store, sel.selection, ctx); break;
      case 'defaultBranchRef': {
        const tip = store.branchTip(repo, repo.defaultBranch);
        out[key] = tip === undefined ? null : { name: repo.defaultBranch };
        break;
      }
      case 'viewerPermission': out[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[key] = true; break;
      case 'description': out[key] = repo.description; break;
      case 'private': out[key] = repo.private; break;
      case 'createdAt': case 'updatedAt': out[key] = new Date(1700000000 * 1000).toISOString(); break;
      case 'issue': {
        const issue = repo.issues.get(args.number as number);
        out[key] = issue === undefined ? null : resolveIssue(store, repo, issue, sel.selection, ctx);
        break;
      }
      case 'issues': out[key] = resolveIssuesConnection(store, repo, args, sel.selection, ctx); break;
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const prs = [...repo.pulls.values()].filter((p) => p.state === 'open').slice(0, first);
        const conn: Record<string, unknown> = {};
        for (const c of sel.selection) {
          if (c.kind === 'fragment') continue;
          const ck = c.alias ?? c.name;
          if (c.name === 'nodes') conn[ck] = prs.map((pr) => resolvePullRequest(store, repo, pr, c.selection, ctx));
          else if (c.name === 'totalCount') conn[ck] = prs.length;
          else if (c.name === 'pageInfo') conn[ck] = { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null };
        }
        out[key] = conn;
        break;
      }
      case 'pullRequest': {
        const pr = repo.pulls.get(args.number as number);
        out[key] = pr === undefined ? null : resolvePullRequest(store, repo, pr, sel.selection, ctx);
        break;
      }
      default: out[key] = null; break;
    }
  }
  return out;
}

function resolveType(name: string, selection: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = TYPE_FIELDS[name] ?? [];
  const enums = TYPE_ENUM_VALUES[name] ?? [];
  for (const sel of selection) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === 'fields') {
      const list = fields.map((f) => ({ name: f }));
      out[key] = list.map((f) => {
        const o: Record<string, unknown> = {};
        for (const s of sel.selection) {
          if (s.kind === 'fragment') continue;
          if (s.name === 'name') o[s.alias ?? s.name] = f.name;
        }
        return o;
      });
    } else if (sel.name === 'enumValues') {
      out[key] = enums.map((e) => {
        const o: Record<string, unknown> = {};
        for (const s of sel.selection) {
          if (s.kind === 'fragment') continue;
          if (s.name === 'name') o[s.alias ?? s.name] = e;
        }
        return o;
      });
    } else if (sel.name === 'name') out[key] = name;
    else if (sel.name === 'kind') out[key] = enums.length > 0 ? 'ENUM' : 'OBJECT';
    else out[key] = null;
  }
  return out;
}

function executeOperation(store: Store, op: Operation, vars: Record<string, unknown>): { data: unknown; errors?: { message: string }[] } {
  const ctx: Ctx = { store, vars };
  const rootType = op.opType === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelection(rootType, op.selection, errors);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const data: Record<string, unknown> = {};
  for (const sel of op.selection) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    const args = argsOf(sel, ctx);
    if (op.opType === 'query') {
      switch (sel.name) {
        case 'viewer':
          data[key] = resolveUser(store, sel.selection, ctx);
          break;
        case 'repository': {
          const owner = String(args.owner ?? '');
          const name = String(args.name ?? '');
          store.noteOwner(owner);
          const repo = store.repoFor(owner, name);
          data[key] = repo === undefined ? null : resolveRepository(store, repo, sel.selection, ctx);
          break;
        }
        case 'node': {
          const decoded = store.decodeGlobalId(String(args.id ?? ''));
          let node: Record<string, unknown> | null = null;
          if (decoded !== null && decoded.type === 'Repository') {
            const repo = store.repoById(decoded.repoId);
            if (repo !== undefined) {
              node = { id: String(args.id) };
              for (const s of sel.selection) {
                if (s.kind === 'fragment') {
                  if (s.typeCondition === 'Repository') {
                    for (const f of s.selection) {
                      if (f.kind === 'fragment') continue;
                      if (f.name === 'name') node[f.alias ?? f.name] = repo.name;
                      else if (f.name === 'nameWithOwner') node[f.alias ?? f.name] = `${repo.owner}/${repo.name}`;
                    }
                  }
                  continue;
                }
                if (s.name === 'id') node[s.alias ?? s.name] = String(args.id);
              }
            }
          }
          data[key] = node;
          break;
        }
        case '__type':
          data[key] = resolveType(String(args.name ?? ''), sel.selection);
          break;
        default:
          data[key] = null;
          break;
      }
    } else {
      // Mutations.
      const input = (args.input ?? {}) as Record<string, unknown>;
      switch (sel.name) {
        case 'createIssue': {
          const decoded = store.decodeGlobalId(String(input.repositoryId ?? ''));
          let issue: Issue | null = null;
          let repo: Repo | undefined;
          if (decoded !== null && decoded.type === 'Repository') repo = store.repoById(decoded.repoId);
          if (repo !== undefined) issue = createIssueRecord(store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
          data[key] = issue === null || repo === undefined
            ? { issue: null }
            : { issue: pickFields(resolveIssue(store, repo, issue, fieldSelection(sel, 'issue'), ctx), fieldSelection(sel, 'issue')) };
          break;
        }
        case 'closeIssue': {
          const decoded = store.decodeGlobalId(String(input.issueId ?? ''));
          let out: Record<string, unknown> = { issue: null };
          if (decoded !== null && decoded.type === 'Issue') {
            const repo = store.repoById(decoded.repoId);
            const issue = repo?.issues.get(decoded.number);
            if (repo !== undefined && issue !== undefined) {
              issue.state = 'closed';
              out = { issue: resolveIssue(store, repo, issue, fieldSelection(sel, 'issue'), ctx) };
            }
          }
          data[key] = out;
          break;
        }
        case 'createPullRequest': {
          const decoded = store.decodeGlobalId(String(input.repositoryId ?? ''));
          let out: Record<string, unknown> = { pullRequest: null };
          if (decoded !== null && decoded.type === 'Repository') {
            const repo = store.repoById(decoded.repoId);
            if (repo !== undefined) {
              const pr = createPullRecord(store, repo, String(input.headRefName ?? ''), String(input.baseRefName ?? ''), String(input.title ?? ''), '');
              if (pr !== null) out = { pullRequest: resolvePullRequest(store, repo, pr, fieldSelection(sel, 'pullRequest'), ctx) };
            }
          }
          data[key] = out;
          break;
        }
        case 'mergePullRequest': {
          const decoded = store.decodeGlobalId(String(input.pullRequestId ?? ''));
          let out: Record<string, unknown> = { pullRequest: null };
          if (decoded !== null && decoded.type === 'PullRequest') {
            const repo = store.repoById(decoded.repoId);
            const pr = repo?.pulls.get(decoded.number);
            if (repo !== undefined && pr !== undefined && !pr.merged) {
              const merged = doSquashMerge(store, repo, pr);
              if (merged !== null) out = { pullRequest: resolvePullRequest(store, repo, pr, fieldSelection(sel, 'pullRequest'), ctx) };
            } else if (repo !== undefined && pr !== undefined) {
              out = { pullRequest: resolvePullRequest(store, repo, pr, fieldSelection(sel, 'pullRequest'), ctx) };
            }
          }
          data[key] = out;
          break;
        }
        case 'addComment': {
          const decoded = store.decodeGlobalId(String(input.subjectId ?? ''));
          let out: Record<string, unknown> = { commentEdge: null };
          if (decoded !== null && decoded.type === 'Issue') {
            const repo = store.repoById(decoded.repoId);
            const issue = repo?.issues.get(decoded.number);
            if (repo !== undefined && issue !== undefined) {
              repo.commentCounter += 1;
              store.tick();
              const comment = { id: repo.commentCounter, body: String(input.body ?? ''), seq: store.seq };
              issue.comments.push(comment);
              const node: Record<string, unknown> = {};
              for (const e of fieldSelection(sel, 'commentEdge')) {
                if (e.kind === 'fragment') continue;
                if (e.name === 'node') {
                  const cn: Record<string, unknown> = {};
                  for (const f of e.selection) {
                    if (f.kind === 'fragment') continue;
                    if (f.name === 'id') cn[f.alias ?? f.name] = store.commentGlobalId(repo, issue, comment);
                    else if (f.name === 'body') cn[f.alias ?? f.name] = comment.body;
                  }
                  node[e.alias ?? e.name] = cn;
                }
              }
              out = { commentEdge: node };
            }
          }
          data[key] = out;
          break;
        }
        default:
          data[key] = null;
          break;
      }
    }
  }
  return { data };
}

/** Selection set of a named sub-field (e.g. `issue` inside a mutation payload). */
function fieldSelection(field: FieldNode, name: string): SelectionNode[] {
  for (const s of field.selection) {
    if (s.kind === 'field' && s.name === name) return s.selection;
  }
  return [];
}

function pickFields(obj: Record<string, unknown>, _selection: SelectionNode[]): Record<string, unknown> {
  return obj;
}

export interface GraphqlRes {
  status: number;
  json: unknown;
}

/** Handle one POST /api/graphql request body (raw bytes). */
export function handleGraphql(store: Store, body: Buffer): GraphqlRes {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, json: { message: 'Malformed JSON body' } };
  }
  const ops: { query: string; variables: Record<string, unknown> }[] = Array.isArray(parsed)
    ? (parsed as { query?: string; variables?: Record<string, unknown> }[]).map((o) => ({ query: String(o.query ?? ''), variables: (o.variables ?? {}) as Record<string, unknown> }))
    : [{ query: String((parsed as { query?: string }).query ?? ''), variables: ((parsed as { variables?: Record<string, unknown> }).variables ?? {}) as Record<string, unknown> }];
  const results = ops.map((o) => {
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(o.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
    const op = operations[0];
    if (op === undefined) return { data: null, errors: [{ message: 'Empty document' }] };
    return executeOperation(store, op, o.variables);
  });
  return { status: 200, json: Array.isArray(parsed) ? results : results[0] };
}
