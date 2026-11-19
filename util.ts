// util.ts — small shared helpers: SHA-1, pkt-line codec, base64, ids.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Git object id: SHA-1("<type> <size>\0" + bytes). */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isOid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

export function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}
export function b64decode(s: string): Buffer {
  return Buffer.from(s.replace(/\s+/g, ''), 'base64');
}
export function b64urlEncodeText(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
export function b64urlDecodeText(s: string): string {
  return Buffer.from(s, 'base64').toString('utf8');
}

// --- pkt-line ---------------------------------------------------------------
/** Encode one pkt-line: 4 lowercase hex digits of payload+4, then payload. */
export function pkt(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktLine {
  /** null for flush/delim control packets; otherwise the payload bytes. */
  data: Buffer | null;
  /** 0 = flush, 1 = delim, -1 = data packet. */
  kind: number;
}

/**
 * Parse a whole buffer into pkt-lines. Throws on malformed framing
 * (bad hex length, truncation, over-long packet). Control packets are
 * returned as {data: null, kind: 0|1}.
 */
export function parsePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pktline-truncated');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('pktline-header');
    const len = parseInt(head, 16);
    if (len === 0) {
      out.push({ data: null, kind: 0 });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ data: null, kind: 1 });
      off += 4;
      continue;
    }
    if (len === 2 || len === 3) throw new Error('pktline-header');
    if (len > 65520) throw new Error('pktline-too-long');
    if (off + len > buf.length) throw new Error('pktline-truncated');
    out.push({ data: Buffer.from(buf.subarray(off + 4, off + len)), kind: -1 });
    off += len;
  }
  return out;
}

/**
 * Split a buffer at the first flush packet: returns [linesBeforeFlush,
 * restAfterFlush]. Used for receive-pack (commands, then pack) and v0
 * upload-pack (wants, then haves).
 */
export function splitAtFlush(buf: Buffer): [PktLine[], Buffer] {
  let off = 0;
  const lines: PktLine[] = [];
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pktline-truncated');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('pktline-header');
    const len = parseInt(head, 16);
    if (len === 0) return [lines, Buffer.from(buf.subarray(off + 4))];
    if (len === 1) {
      lines.push({ data: null, kind: 1 });
      off += 4;
      continue;
    }
    if (len === 2 || len === 3 || len > 65520) throw new Error('pktline-header');
    if (off + len > buf.length) throw new Error('pktline-truncated');
    lines.push({ data: Buffer.from(buf.subarray(off + 4, off + len)), kind: -1 });
    off += len;
  }
  return [lines, Buffer.alloc(0)];
}

/** Text of data pkt-lines, each stripped of exactly one trailing \n. */
export function pktTextLines(lines: PktLine[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.data === null) continue;
    let s = l.data.toString('utf8');
    if (s.endsWith('\n')) s = s.slice(0, -1);
    out.push(s);
  }
  return out;
}
