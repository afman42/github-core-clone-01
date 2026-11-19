// githttp.ts — git smart HTTP: info/refs advertisements, upload-pack
// (protocol v2 ls-refs/fetch + v0 fallback), receive-pack (v0).
// Plain objects only in packs (no deltas); object bytes are stored verbatim.
import {
  collectReachable,
  commitDistances,
  isAncestor,
  oidOf,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';
import {
  pkt,
  PKT_DELIM,
  PKT_FLUSH,
  parsePktLines,
  pktTextLines,
  splitAtFlush,
  ZERO_OID,
} from './util.ts';

export interface GitReq {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  query: URLSearchParams;
}
export interface GitRes {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'makefun-forge/1.0';

function header(req: GitReq, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function jsonRes(status: number, body: unknown): GitRes {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  store.noteOwner(owner);
  const repo = store.getRepo(name);
  if (repo === undefined) return null;
  if (repo.owner !== owner) return null;
  return repo;
}

function refLinesV0(repo: Repo, caps: string): Buffer[] {
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const parts: Buffer[] = [];
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return parts;
  }
  let first = true;
  for (const [ref, oid] of refs) {
    if (first) {
      parts.push(pkt(`${oid} ${ref}\0${caps}\n`));
      first = false;
    } else {
      parts.push(pkt(`${oid} ${ref}\n`));
    }
    // Peeled annotated tags, right after their base line.
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      parts.push(pkt(`${target} ${ref}^{}\n`));
    }
  }
  return parts;
}

export function handleInfoRefs(store: Store, owner: string, name: string, service: string, req: GitReq): GitRes {
  const repo = lookupRepo(store, owner, name);
  if (repo === null) return jsonRes(404, { message: 'Not Found' });
  const v2 = header(req, 'git-protocol').includes('version=2');
  if (service === 'git-upload-pack') {
    if (v2) {
      // Smart-HTTP framing: service line, flush, then the v2 advertisement.
      const body = Buffer.concat([
        pkt('# service=git-upload-pack\n'),
        PKT_FLUSH,
        pkt('version 2\n'),
        pkt('ls-refs=unborn\n'),
        pkt('fetch=shallow filter\n'),
        pkt('object-format=sha1\n'),
        pkt(`agent=${AGENT}\n`),
        PKT_FLUSH,
      ]);
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
    }
    const caps = 'side-band-64k thin-pack ofs-delta multi_ack_detailed shallow object-format=sha1 ' +
      `symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
    const body = Buffer.concat([
      pkt('# service=git-upload-pack\n'),
      PKT_FLUSH,
      ...refLinesV0(repo, caps),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  if (service === 'git-receive-pack') {
    const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta object-format=sha1 ' +
      `symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
    const body = Buffer.concat([
      pkt('# service=git-receive-pack\n'),
      PKT_FLUSH,
      ...refLinesV0(repo, caps),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body };
  }
  return jsonRes(400, { message: 'Unknown service' });
}

// --- ls-refs (v2) -------------------------------------------------------------
function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  const include = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (wantSymrefs && include('HEAD')) {
    if (headTip !== undefined) lines.push(pkt(`${headTip} HEAD symref-target:${headRef}\n`));
    else if (wantUnborn) lines.push(pkt(`unborn HEAD symref-target:${headRef}\n`));
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    if (!include(ref)) continue;
    let line = `${oid} ${ref}`;
    if (wantPeel) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        line += ` peeled:${parseTag(obj.data).object}`;
      }
    }
    lines.push(pkt(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// --- fetch ---------------------------------------------------------------------
interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  /** Client sent `done`: negotiation is over, send the packfile at once. */
  done: boolean;
}

interface FetchPlan {
  /** Oids to send (objects, in oid order). */
  send: GitObject[];
  acks: string[];
  newShallow: string[];
  unshallow: string[];
  wantedRefs: [string, string][];
}

function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const store = repo.objects;
  // Resolve tag wants to their target commits for distance purposes.
  const wantCommits: string[] = [];
  for (const w of args.wants) {
    const obj = store.get(w);
    if (obj === undefined) continue;
    if (obj.type === 'tag') wantCommits.push(parseTag(obj.data).object);
    else if (obj.type === 'commit') wantCommits.push(w);
  }
  const distances = commitDistances(store, wantCommits);
  const maxDist = args.depth === null ? Infinity : args.depth - 1;
  const includedCommits = new Set<string>();
  const newShallow: string[] = [];
  for (const [oid, d] of distances) {
    if (d <= maxDist) {
      includedCommits.add(oid);
      if (args.depth !== null && d === maxDist) newShallow.push(oid);
    }
  }
  // Objects reachable from the included commits (commit + full tree).
  const sendOids = new Set<string>();
  const collectTree = (treeOid: string): void => {
    const obj = store.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    if (sendOids.has(treeOid)) return;
    sendOids.add(treeOid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') collectTree(e.oid.toString('hex'));
      else if (e.mode !== '160000') sendOids.add(e.oid.toString('hex'));
    }
  };
  for (const w of args.wants) {
    const obj = store.get(w);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      sendOids.add(w);
      const target = parseTag(obj.data).object;
      const tObj = store.get(target);
      if (tObj !== undefined && tObj.type === 'commit' && includedCommits.has(target)) {
        sendOids.add(target);
        collectTree(parseCommit(tObj.data).tree);
      }
    } else if (obj.type === 'commit') {
      if (includedCommits.has(w)) {
        sendOids.add(w);
        collectTree(parseCommit(obj.data).tree);
      }
    } else {
      sendOids.add(w);
    }
  }
  for (const oid of includedCommits) {
    if (sendOids.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    // A commit reachable only as an ancestor (not a direct want) still ships
    // its tree when it is inside the depth budget.
    sendOids.add(oid);
    collectTree(parseCommit(obj.data).tree);
  }
  // Subtract what the client already holds.
  let haveClosure = new Set<string>();
  try {
    haveClosure = collectReachable(store, args.haves);
  } catch {
    haveClosure = new Set<string>();
  }
  for (const oid of haveClosure) sendOids.delete(oid);
  // ACKs: haves that are ancestors-or-equal of a want.
  let wantClosure = new Set<string>();
  try {
    wantClosure = collectReachable(store, wantCommits);
  } catch {
    wantClosure = new Set<string>();
  }
  const acks = args.haves.filter((h) => wantClosure.has(h));
  const unshallow = args.shallow.filter((s) => {
    const d = distances.get(s);
    return d !== undefined && args.depth !== null && d < maxDist;
  });
  const wantedRefs: [string, string][] = [];
  for (const w of args.wants) {
    for (const [ref, oid] of repo.refs) if (oid === w) wantedRefs.push([w, ref]);
  }
  const send: GitObject[] = [];
  for (const oid of sendOids) {
    const obj = store.get(oid);
    if (obj !== undefined) send.push(obj);
  }
  return { send, acks, newShallow, unshallow, wantedRefs };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  if (pack.length === 0) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), pack])));
    return out;
  }
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = writePack(plan.send);
  const parts: Buffer[] = [];
  // Response shape, verified byte-for-byte against real git-http-backend:
  // - `done` (or no haves at all): NO acknowledgments section; the reply
  //   starts with [shallow-info] then `packfile`.
  // - haves but no `done`: an acknowledgments section first. When at least
  //   one have is an ancestor of a want, the server ACKs, says `ready`, and
  //   still sends the packfile in the same reply. When nothing is ACKed it
  //   answers NAK + flush only, and the client sends another round (with
  //   `done`). Sending an acknowledgments section after `done` makes real
  //   git die with "expected 'packfile', received 'acknowledgments'".
  if (!args.done && args.haves.length > 0) {
    parts.push(pkt('acknowledgments\n'));
    if (plan.acks.length === 0) {
      parts.push(pkt('NAK\n'));
      parts.push(PKT_FLUSH);
      return Buffer.concat(parts);
    }
    for (const a of plan.acks) parts.push(pkt(`ACK ${a}\n`));
    parts.push(pkt('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (plan.newShallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    // Reference sends shallow/unshallow lines with no trailing LF.
    for (const s of plan.newShallow) parts.push(pkt(`shallow ${s}`));
    for (const u of plan.unshallow) parts.push(pkt(`unshallow ${u}`));
    parts.push(PKT_DELIM);
  }
  parts.push(pkt('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = writePack(plan.send);
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) parts.push(pkt('NAK\n'));
  else for (const a of plan.acks) parts.push(pkt(`ACK ${a}\n`));
  for (const s of plan.newShallow) parts.push(pkt(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pkt(`unshallow ${u}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleUploadPack(store: Store, owner: string, name: string, req: GitReq): GitRes {
  const repo = lookupRepo(store, owner, name);
  if (repo === null) return jsonRes(404, { message: 'Not Found' });
  let lines;
  try {
    lines = parsePktLines(req.body);
  } catch (err) {
    return jsonRes(400, { message: `Bad pkt-line: ${err instanceof Error ? err.message : String(err)}` });
  }
  const texts = pktTextLines(lines);
  if (texts.length === 0) return jsonRes(400, { message: 'Empty upload-pack request' });
  const first = texts[0] as string;
  try {
    if (first.startsWith('command=')) {
      // Protocol v2.
      const command = first.slice('command='.length);
      const delimIdx = lines.findIndex((l) => l.kind === 1);
      const argLines = (delimIdx >= 0 ? lines.slice(delimIdx + 1) : []).filter((l) => l.data !== null);
      const args = pktTextLines(argLines);
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, args) };
      }
      if (command === 'fetch') {
        const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
        for (const a of args) {
          if (a.startsWith('want ')) fetchArgs.wants.push(a.slice(5).trim());
          else if (a.startsWith('have ')) fetchArgs.haves.push(a.slice(5).trim());
          else if (a.startsWith('shallow ')) fetchArgs.shallow.push(a.slice(8).trim());
          else if (a.startsWith('deepen ')) fetchArgs.depth = parseInt(a.slice(7).trim(), 10);
          else if (a === 'done') fetchArgs.done = true;
        }
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV2(repo, fetchArgs) };
      }
      return jsonRes(400, { message: `Unknown v2 command ${command}` });
    }
    if (first.startsWith('want ')) {
      // Protocol v0: two flush-separated sections.
      const [sec1, rest] = splitAtFlush(req.body);
      const [sec2] = splitAtFlush(rest);
      const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
      for (const t of pktTextLines(sec1)) {
        if (t.startsWith('want ')) fetchArgs.wants.push(t.slice(5).split(' ')[0] as string);
        else if (t.startsWith('shallow ')) fetchArgs.shallow.push(t.slice(8).trim());
        else if (t.startsWith('deepen ')) fetchArgs.depth = parseInt(t.slice(7).trim(), 10);
      }
      for (const t of pktTextLines(sec2)) {
        if (t.startsWith('have ')) fetchArgs.haves.push(t.slice(5).trim());
        else if (t === 'done') fetchArgs.done = true;
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV0(repo, fetchArgs) };
    }
    return jsonRes(400, { message: 'Unrecognised upload-pack request' });
  } catch (err) {
    return jsonRes(400, { message: `Upload-pack failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// --- receive-pack ---------------------------------------------------------------
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, name: string, req: GitReq): GitRes {
  const repo = lookupRepo(store, owner, name);
  if (repo === null) return jsonRes(404, { message: 'Not Found' });
  let commands: PushCommand[] = [];
  let packBuf: Buffer = Buffer.alloc(0);
  let sideband = false;
  try {
    const [cmdLines, rest] = splitAtFlush(req.body);
    packBuf = rest;
    for (const line of pktTextLines(cmdLines)) {
      const nul = line.indexOf('\0');
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      const caps = nul >= 0 ? line.slice(nul + 1) : '';
      if (caps.includes('side-band-64k')) sideband = true;
      const parts = clean.split(' ');
      if (parts.length < 3) throw new Error('bad-command');
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  } catch (err) {
    return jsonRes(400, { message: `Bad receive-pack request: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (commands.length === 0) return jsonRes(400, { message: 'No commands' });
  // Unpack first; a corrupt pack refuses everything with `unpack <detail>`.
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = '';
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack) {
    try {
      const pack = packBuf.length === 0 ? { objects: [] as GitObject[] } : readPack(packBuf);
      for (const obj of pack.objects) {
        const oid = oidOf(obj.type, obj.data);
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  if (unpackOk) {
    report.push('unpack ok');
  } else {
    report.push(`unpack ${unpackDetail}`);
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) report.push(`ng ${cmd.ref} cannot delete non-existent ref`);
      else if (cmd.oldOid !== current) report.push(`ng ${cmd.ref} old value mismatch`);
      else {
        repo.refs.delete(cmd.ref);
        report.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        report.push(`ng ${cmd.ref} already exists`);
      } else if (repo.objects.get(cmd.newOid) === undefined) {
        report.push(`ng ${cmd.ref} missing object`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    // Update.
    if (current === undefined) {
      report.push(`ng ${cmd.ref} cannot update non-existent ref`);
    } else if (cmd.oldOid !== current) {
      report.push(`ng ${cmd.ref} old value mismatch`);
    } else if (cmd.newOid === cmd.oldOid) {
      report.push(`ok ${cmd.ref}`);
    } else if (cmd.ref.startsWith('refs/tags/')) {
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}`);
    } else if (!isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) {
      report.push(`ng ${cmd.ref} non-fast-forward`);
    } else {
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}`);
    }
  }
  const reportBytes = Buffer.concat(report.map((l) => pkt(`${l}\n`)));
  let body: Buffer;
  if (sideband) {
    body = Buffer.concat([...sidebandPackets(reportBytes), PKT_FLUSH]);
  } else {
    body = Buffer.concat([reportBytes, PKT_FLUSH]);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}
