// @ts-check
// The thin stdio MCP client (docs/mcp.md): the plugin's MCP process when the dashboard daemon is up. It forwards each
// JSON-RPC line to POST <PORTBOARD_URL>/api/mcp (src/features/mcp-local.ts) and prints the reply, so it never loads the
// feature modules and stays near the size of an empty Node process.
//
// Plain JavaScript on purpose: Node loads its TypeScript type stripper (about 19 MB resident) for the first .ts file,
// and this process exists to be small. Keep it free of TypeScript syntax; the types are JSDoc, checked by tsc.
//
// Imports only node: modules. When the daemon can't be reached (before a request is sent), it switches for the rest of
// the session to the in-process server of src/mcp.ts, loaded with dynamic import() at that moment (that load does use
// the type stripper, as before).
//
// Nothing but JSON-RPC lines may reach stdout.

import { createInterface } from 'node:readline';
import { request as httpRequest } from 'node:http';

const DEFAULT_URL = 'http://127.0.0.1:8790';
const CONNECT_TIMEOUT_MS = 2_000;
/** The longest tool (adoption_stats, remove_worktrees) may take this long to answer */
const REPLY_TIMEOUT_MS = 600_000;
const RETRY_AFTER_MS = 1_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const CLAUDE_PID = /^\d{1,10}$/;

/** @typedef {string | number | null} Id */
/** @typedef {{ jsonrpc: '2.0', id: Id } & ({ result: unknown } | { error: { code: number, message: string } })} Reply */
/** @typedef {(msg: unknown) => Promise<Reply | null>} Local */
/**
 * `connect`: nothing was sent (refused, unreachable, or no connection within 2 s). `lost`: the request may have run.
 * @typedef {{ kind: 'reply', status: number, body: string } | { kind: 'connect' } | { kind: 'lost', why: string }} Sent
 */

const base = (process.env.PORTBOARD_URL || DEFAULT_URL).replace(/\/+$/, '');
const endpoint = new URL(`${base}/api/mcp`);

/** @type {Record<string, string>} */
const headers = { 'X-Portboard': '1', 'Content-Type': 'application/json' };
const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
const claudePid = process.env.CLAUDE_PID;
if (sessionId && SESSION_ID.test(sessionId)) headers['X-Portboard-Session'] = sessionId;
if (claudePid && CLAUDE_PID.test(claudePid)) headers['X-Portboard-Claude-Pid'] = claudePid;
// Where the session finds its CLIs: start_coding_agent runs in the dashboard, whose own PATH may not have them.
// (printable ASCII only: any other byte would make the request itself fail)
if (process.env.PATH && process.env.PATH.length <= 4096 && /^[\x20-\x7e]+$/.test(process.env.PATH)) headers['X-Portboard-Path'] = process.env.PATH;

/** @param {Reply} msg */
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One POST on a new connection (no keep-alive: a stale pooled socket would look like a failure after sending).
 * @param {string} line
 * @returns {Promise<Sent>}
 */
async function post(line) {
  // node:https pulls in tls and crypto: only for an https PORTBOARD_URL
  const lib = endpoint.protocol === 'https:' ? (await import('node:https')).request : httpRequest;
  return new Promise((resolve) => {
    let connected = false;
    let done = false;
    /** @type {import('node:http').ClientRequest | undefined} */
    let req;
    /** @param {Sent} r */
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    /** @param {string} why */
    const fail = (why) => finish(connected ? { kind: 'lost', why } : { kind: 'connect' });
    // Until the connection is made, the timer is the 2 s connect limit; after that, the 10 min reply limit.
    let timer = setTimeout(() => {
      req?.destroy();
      fail(connected ? 'timeout' : 'connect timeout');
    }, CONNECT_TIMEOUT_MS);
    try {
      req = lib(endpoint, { method: 'POST', agent: false, headers: { ...headers, Connection: 'close', 'Content-Length': String(Buffer.byteLength(line)) } });
    } catch (err) {
      return finish({ kind: 'lost', why: /** @type {{ code?: string }} */ (err).code ?? 'bad request' });
    }
    const r = req;
    r.on('socket', (socket) => {
      const up = () => {
        connected = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          r.destroy();
          fail('timeout');
        }, REPLY_TIMEOUT_MS);
      };
      if (socket.connecting) socket.once('connect', up);
      else up();
    });
    r.on('error', (/** @type {NodeJS.ErrnoException} */ err) => fail(err.code ?? 'error'));
    r.on('response', (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (/** @type {Buffer} */ c) => chunks.push(c));
      res.on('end', () => finish({ kind: 'reply', status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (/** @type {NodeJS.ErrnoException} */ err) => fail(err.code ?? 'error'));
      res.on('aborted', () => fail('aborted'));
    });
    r.end(line);
  });
}

// The in-process server (src/mcp.ts's setup), loaded once, by whichever request needs it first.
/** @type {Promise<Local> | null} */
let local = null;
/** @returns {Promise<Local>} */
function switchToLocal() {
  local ??= (async () => {
    // As in src/mcp.ts: anything logged by accident goes to stderr, before any module that might log is loaded.
    console.log = console.info = console.debug = console.error;
    const [{ handleMessage }, { REGISTRY }, { AuditLog }, { PATHS }] = await Promise.all([
      import('./rpc.ts'),
      import('../features/registry.ts'),
      import('../core/audit.ts'),
      import('../core/paths.ts'),
    ]);
    const core = /** @type {import('./kit.ts').Core} */ (Object.assign({}, ...REGISTRY.features.map((f) => f.mcpCore?.() ?? {})));
    const audit = new AuditLog(PATHS.audit);
    /** @type {Local} */
    return (msg) => handleMessage(/** @type {any} */ (msg), core, audit);
  })();
  return local;
}

/**
 * @param {unknown} msg
 * @returns {{ id: Id } | null}
 */
const idOf = (msg) => (msg !== null && typeof msg === 'object' && 'id' in msg ? { id: /** @type {{ id?: Id }} */ (msg).id ?? null } : null);

/**
 * @param {string} line
 * @param {unknown} msg
 * @returns {Promise<void>}
 */
async function handle(line, msg) {
  const asked = idOf(msg);
  /** @param {string} what */
  const failure = (what) => {
    if (asked) send({ jsonrpc: '2.0', id: asked.id, error: { code: -32603, message: `Portboard dashboard request failed: ${what}` } });
  };
  if (!local) {
    let sent = await post(line);
    if (sent.kind === 'connect') {
      await sleep(RETRY_AFTER_MS);
      if (!local) sent = await post(line);
    }
    if (sent.kind !== 'connect') {
      if (sent.kind === 'lost') return failure(sent.why);
      if (sent.status === 204) return;
      if (sent.status !== 200) return failure(String(sent.status));
      try {
        send(JSON.parse(sent.body));
      } catch {
        failure('bad reply');
      }
      return;
    }
  }
  // The daemon could not be reached: this request and the rest of the session are answered in this process.
  const reply = await (await switchToLocal())(msg);
  if (reply) send(reply);
}

/** @type {Set<Promise<void>>} */
const inFlight = new Set();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  /** @type {unknown} */
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  /** @type {Promise<void>} */
  const job = handle(line, msg)
    .catch((err) => {
      // Never let one request end the session; the message goes to stderr, the client gets a JSON-RPC error.
      process.stderr.write(`portboard thin client: ${err instanceof Error ? err.message : String(err)}\n`);
      const asked = idOf(msg);
      if (asked) send({ jsonrpc: '2.0', id: asked.id, error: { code: -32603, message: 'Portboard dashboard request failed: internal error' } });
    })
    .finally(() => inFlight.delete(job));
  inFlight.add(job);
});

// stdin closed: finish what was asked, then exit.
rl.on('close', async () => {
  await Promise.allSettled([...inFlight]);
  process.exit(0);
});
