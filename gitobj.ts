// gitobj.ts — git object model: loose-object bytes, trees, commits, tags,
// packfile read/write, reachability. Pack READING supports OFS_DELTA and
// REF_DELTA (real git delta-compresses pushes); pack WRITING emits plain
// objects only (deltaCount 0), which every client accepts.
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, sha1Hex, ZERO_OID } from './util.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function oidOf(type: ObjType, data: Buffer): string {
  return hashObject(type, data);
}

// --- trees ------------------------------------------------------------------
export interface TreeEntry {
  mode: string;
  name: string;
  oid: Buffer; // 20 raw bytes
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('bad-tree');
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad-tree');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = Buffer.from(data.subarray(nul + 1, nul + 21));
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort: compare names byte-wise, directories as name + '/'. */
export function treeCompare(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  const ab = Buffer.from(an, 'utf8');
  const bb = Buffer.from(bn, 'utf8');
  return Buffer.compare(ab, bb);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeCompare);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(e.oid);
  }
  return Buffer.concat(parts);
}

// --- commits / tags ----------------------------------------------------------
export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(c: CommitInfo): Buffer {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
  return Buffer.from(s, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('bad-commit-tree');
  return { tree, parents, author, committer, message };
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// --- reachability ------------------------------------------------------------
export type ObjectStore = Map<string, GitObject>;

/** All oids reachable from roots (commits -> tree+parents, tags -> target). */
export function collectReachable(store: ObjectStore, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = store.get(oid);
    if (obj === undefined) throw new Error(`missing-object ${oid}`);
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid.toString('hex'));
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal). */
export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const stack: string[] = [tip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return false;
}

/**
 * Commits reachable from `tip`, with BFS distance (generations) from the tip.
 * Used for depth-limited fetches: distance 0 is the tip itself.
 */
export function commitDistances(store: ObjectStore, tips: string[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const t of tips) {
    if (t !== ZERO_OID && !dist.has(t)) {
      dist.set(t, 0);
      queue.push(t);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    const d = dist.get(oid) as number;
    const obj = store.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) {
        if (!dist.has(p)) {
          dist.set(p, d + 1);
          queue.push(p);
        }
      }
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (!dist.has(target)) {
        dist.set(target, d);
        queue.push(target);
      }
    }
  }
  return dist;
}

// --- packfiles ---------------------------------------------------------------
function encodeVarintHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size >>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Write a pack v2 with plain objects only, in oid-sorted order. */
export function writePack(objects: GitObject[]): Buffer {
  const entries: { oid: string; type: ObjType; data: Buffer }[] = objects.map((o) => ({
    oid: oidOf(o.type, o.data),
    type: o.type,
    data: o.data,
  }));
  entries.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const e of entries) {
    parts.push(encodeVarintHeader(TYPE_CODES[e.type] as number, e.data.length));
    parts.push(deflateSync(e.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

export interface ReadPackResult {
  objects: GitObject[];
}

/** Apply a git delta stream to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta-varint');
      const b = delta[pos] as number;
      pos += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) return v;
      if (shift > 56) throw new Error('delta-varint');
    }
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta-base-size');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) { offset = delta[pos] as number; pos += 1; }
      if ((op & 0x02) !== 0) { offset |= (delta[pos] as number) << 8; pos += 1; }
      if ((op & 0x04) !== 0) { offset |= (delta[pos] as number) << 16; pos += 1; }
      if ((op & 0x08) !== 0) { offset |= (delta[pos] as number) << 24; pos += 1; }
      if ((op & 0x10) !== 0) { size = delta[pos] as number; pos += 1; }
      if ((op & 0x20) !== 0) { size |= (delta[pos] as number) << 8; pos += 1; }
      if ((op & 0x40) !== 0) { size |= (delta[pos] as number) << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta-copy-range');
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op > 0) {
      if (pos + op > delta.length) throw new Error('delta-insert-range');
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      outLen += op;
    } else {
      throw new Error('delta-op-0');
    }
  }
  const result = Buffer.concat(out, outLen);
  if (result.length !== resultSize) throw new Error('delta-result-size');
  return result;
}

/**
 * Read a packfile, resolving OFS_DELTA / REF_DELTA chains (including bases
 * that live in `external`, e.g. objects the server already stores, for thin
 * packs). Returns the fully-resolved objects; delta results are real objects
 * whose SHA is content-derived, so storing them verbatim is byte-exact.
 */
export function readPack(buf: Buffer, external?: Map<string, GitObject>): ReadPackResult {
  if (buf.length < 32) throw new Error('pack-too-short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack-magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const expect = sha1Hex(buf.subarray(0, trailerStart));
  if (buf.subarray(trailerStart).toString('hex') !== expect) throw new Error('pack-checksum');
  interface RawEntry {
    start: number;
    typeCode: number;
    data: Buffer; // inflated bytes (delta stream for delta entries)
    baseOfs?: number; // OFS_DELTA: absolute file offset of the base entry
    baseOid?: string; // REF_DELTA: oid of the base object
  }
  const raw: RawEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    if (off >= trailerStart) throw new Error('pack-truncated');
    const start = off;
    const first = buf[off] as number;
    off += 1;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let b = first;
    while ((b & 0x80) !== 0) {
      if (off >= trailerStart) throw new Error('pack-truncated');
      b = buf[off] as number;
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
      if (shift > 64) throw new Error('pack-corrupt');
    }
    if (typeCode !== 1 && typeCode !== 2 && typeCode !== 3 && typeCode !== 4 && typeCode !== 6 && typeCode !== 7) {
      throw new Error('pack-type');
    }
    const entry: RawEntry = { start, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      // OFS_DELTA: offset varint (base = start - offset).
      if (off >= trailerStart) throw new Error('pack-truncated');
      b = buf[off] as number;
      off += 1;
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        if (off >= trailerStart) throw new Error('pack-truncated');
        b = buf[off] as number;
        off += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      entry.baseOfs = start - offset;
    } else if (typeCode === 7) {
      if (off + 20 > trailerStart) throw new Error('pack-truncated');
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    // inflateSync({info:true}) returns {buffer, engine}; engine.bytesWritten
    // is the number of input bytes the zlib stream consumed, so `off` can
    // advance exactly past this entry. Trailing bytes are not consumed.
    const inflated = inflateSync(buf.subarray(off, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const data = Buffer.from(inflated.buffer);
    if (data.length !== size) throw new Error('pack-size');
    off += inflated.engine.bytesWritten;
    entry.data = data;
    raw.push(entry);
  }
  if (off !== trailerStart) throw new Error('pack-trailing');
  // Resolve: plain objects first, then deltas in dependency order.
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  if (external !== undefined) for (const [oid, obj] of external) byOid.set(oid, obj);
  const objects: GitObject[] = [];
  const pending: RawEntry[] = [];
  for (const e of raw) {
    if (e.typeCode >= 1 && e.typeCode <= 4) {
      const type = CODE_TYPES[e.typeCode] as ObjType;
      const obj: GitObject = { type, data: e.data };
      const oid = oidOf(type, e.data);
      byOffset.set(e.start, obj);
      byOid.set(oid, obj);
      objects.push(obj);
    } else {
      pending.push(e);
    }
  }
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const e = pending[i] as RawEntry;
      let base: GitObject | undefined;
      if (e.baseOfs !== undefined) base = byOffset.get(e.baseOfs);
      else if (e.baseOid !== undefined) base = byOid.get(e.baseOid);
      if (base === undefined) continue;
      const result = applyDelta(base.data, e.data);
      const obj: GitObject = { type: base.type, data: result };
      const oid = oidOf(base.type, result);
      byOffset.set(e.start, obj);
      byOid.set(oid, obj);
      objects.push(obj);
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length > 0) throw new Error('pack-delta-unresolved');
  return { objects };
}
