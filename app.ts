// app.ts — HTTP routing for the forge. One Store per server; dispatch to
// git smart HTTP, REST v3, GraphQL v4, MCP, and the two starter endpoints.
//
// Auth: every route except GET /healthz requires
// `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; missing or wrong token
// answers 401 JSON. (When the env var is unset — local dev only — any
// non-empty Bearer token is accepted.) Every reply carries a non-empty
// X-GitHub-Request-Id header (`req-<counter>`). Unknown routes are 404 JSON.
// Plain node:http, keep-alive friendly: no Connection header is ever set.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 64 * 1024 * 1024;

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function sendJson(res: ServerResponse, reqId: string, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': reqId,
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, reqId: string, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': reqId,
    ...extra,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const expectedToken = store.token;

  const authed = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const m = /^Bearer (.+)$/.exec(header);
    if (m === null) return false;
    const token = m[1] as string;
    if (expectedToken === '') return token.length > 0;
    return token === expectedToken;
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqId = store.requestId();
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}. No auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, reqId, 200, { ok: true });
      return;
    }

    void (async () => {
      try {
        // Git smart HTTP: /{owner}/{repo}.git/info/refs|git-upload-pack|git-receive-pack
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          if (!authed(req)) {
            sendJson(res, reqId, 401, { message: 'Bad credentials' });
            return;
          }
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const action = gitMatch[3] as string;
          const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          const url = new URL(req.url ?? '/', 'http://entry');
          const gitReq = { method, headers: req.headers, body, query: url.searchParams };
          const out = action === 'info/refs'
            ? handleInfoRefs(store, owner, repoName, url.searchParams.get('service') ?? '', gitReq)
            : action === 'git-upload-pack'
              ? handleUploadPack(store, owner, repoName, gitReq)
              : handleReceivePack(store, owner, repoName, gitReq);
          sendRaw(res, reqId, out.status, out.contentType, out.body);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql' && method === 'POST') {
          if (!authed(req)) {
            sendJson(res, reqId, 401, { message: 'Bad credentials' });
            return;
          }
          const body = await readBody(req);
          const out = handleGraphql(store, body);
          sendJson(res, reqId, out.status, out.json);
          return;
        }

        // MCP (Streamable HTTP). DELETE is the client's close() best-effort.
        if (path === '/mcp') {
          if (!authed(req)) {
            sendJson(res, reqId, 401, { message: 'Bad credentials' });
            return;
          }
          if (method === 'DELETE') {
            res.writeHead(202, { 'x-github-request-id': reqId, 'content-length': 0 });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, reqId, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          const out = handleMcp(store, body);
          if (out.json === null) {
            res.writeHead(out.status, { 'x-github-request-id': reqId, 'content-length': 0 });
            res.end();
            return;
          }
          sendJson(res, reqId, out.status, out.json);
          return;
        }

        // REST v3 under /api/v3.
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          if (!authed(req)) {
            sendJson(res, reqId, 401, { message: 'Bad credentials' });
            return;
          }
          if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
            sendJson(res, reqId, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
            return;
          }
          const body = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE' ? await readBody(req) : Buffer.alloc(0);
          const url = new URL(req.url ?? '/', 'http://entry');
          const segments = path
            .replace(/^\/api\/v3\/?/, '')
            .split('/')
            .filter((s) => s !== '')
            .map((s) => {
              try {
                return decodeURIComponent(s);
              } catch {
                return s;
              }
            });
          const out = handleRest(store, {
            method,
            segments,
            query: url.searchParams,
            headers: req.headers,
            body,
            host: req.headers.host ?? 'localhost',
          });
          if (out.status === 204) {
            res.writeHead(204, { 'x-github-request-id': reqId });
            res.end();
            return;
          }
          sendJson(res, reqId, out.status, out.json, out.headers ?? {});
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, reqId, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, reqId, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
