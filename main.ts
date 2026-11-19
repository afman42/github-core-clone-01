// Entrypoint: boots the forge, registers it with the make.fun trial
// environment, and shuts it down cleanly once the trial is over.
//
// Lifecycle (agent/v1):
//   1. read the environment URL from MAKEFUN_ENV_URL
//   2. listen on an ephemeral port (never 8080 — that belongs to the env)
//   3. POST {"port": N} to <env>/register until accepted
//   4. poll GET <env>/done until it answers {"done": true}
//   5. close the server and exit 0
//
// Fatal problems print to stderr and exit 1. Transient failures while
// talking to the environment are retried with exponential backoff, because
// the environment may still be starting when we come up.

import { createApp } from './app.ts';

const ENV_NAME = 'MAKEFUN_ENV_URL';
const FIRST_WAIT_MS = 250;
const MAX_WAIT_MS = 2000;
const POLL_TIMEOUT_MS = 30_000;

function die(message: string, cause?: unknown): never {
  console.error(`[entrypoint] fatal: ${message}`);
  if (cause !== undefined) console.error(cause);
  process.exit(1);
}

function envUrl(): string {
  const raw = process.env[ENV_NAME];
  if (raw === undefined || raw.trim() === '') {
    die(`${ENV_NAME} is not set; the entrypoint has no environment to talk to`);
  }
  return raw.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextWait(current: number): number {
  return Math.min(current * 2, MAX_WAIT_MS);
}

// Register this process with the environment. 200 and 409 both count as
// registered; 400/405 mean our request breaks the contract, so we stop;
// anything else (network errors, other statuses) is retried forever.
async function register(env: string, port: number): Promise<void> {
  let wait = FIRST_WAIT_MS;
  for (;;) {
    let reply: Response;
    try {
      reply = await fetch(`${env}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch (error) {
      console.error(`[entrypoint] register failed, retrying in ${wait}ms:`, error);
      await sleep(wait);
      wait = nextWait(wait);
      continue;
    }
    if (reply.status === 200 || reply.status === 409) {
      return;
    }
    if (reply.status === 400 || reply.status === 405) {
      die(`register rejected with HTTP ${reply.status}; request breaks the contract`);
    }
    console.error(`[entrypoint] register answered HTTP ${reply.status}, retrying in ${wait}ms`);
    await sleep(wait);
    wait = nextWait(wait);
  }
}

// Long-poll the environment until it reports the trial finished. Each poll
// is abandoned after POLL_TIMEOUT_MS and retried; we never exit early.
async function waitUntilDone(env: string): Promise<void> {
  let wait = FIRST_WAIT_MS;
  for (;;) {
    let reply: Response | null = null;
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), POLL_TIMEOUT_MS);
      try {
        reply = await fetch(`${env}/done`, { signal: abort.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      console.error(`[entrypoint] done poll failed, retrying in ${wait}ms:`, error);
    }
    if (reply !== null && reply.ok) {
      const body: unknown = await reply.json().catch(() => null);
      if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) {
        return;
      }
    }
    await sleep(wait);
    wait = nextWait(wait);
  }
}

async function run(): Promise<void> {
  const env = envUrl();
  const server = createApp();

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('server did not bind a TCP port'));
      } else {
        resolve(bound.port);
      }
    });
  }).catch((error: unknown) => die('could not listen on an ephemeral port', error));

  console.error(`[entrypoint] listening on ${port}; registering with ${env}`);
  await register(env, port);
  console.error('[entrypoint] registered; waiting for the trial to finish');
  await waitUntilDone(env);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.error('[entrypoint] trial finished; shutting down');
}

run().catch((error: unknown) => die('unexpected entrypoint error', error));
