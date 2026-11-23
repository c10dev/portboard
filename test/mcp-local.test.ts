// The thin MCP client and the dashboard's MCP route (src/mcp/thin.mjs, src/features/mcp-local.ts,
// claude-plugin/bin/mcp.mjs; docs/mcp.md).
//
// Real processes, on temporary ports, in a temp HOME with a clean environment: the dashboard (`node src/server.ts`) and the
// plugin's MCP process. Fake dashboards (plain http servers) stand in where a test needs the daemon to refuse,
// vanish or hang up. The commands the dashboard runs (ss, git, systemctl, systemd-run, tailscale, ...) are shell shims
// first on PATH: they log their argv and print canned output, so this proves wiring only, not real `ss` or systemd.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer as createHttp, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNet } from 'node:net';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { resolvePaths } from '../src/core/paths.ts';
import { parsePortCommands } from '../src/core/portcmd.ts';
import { buildRegistry } from '../src/features/registry.ts';
import type { Route } from '../src/features/types.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MCP_BIN = join(ROOT, 'claude-plugin', 'bin', 'mcp.mjs');
const SERVER = join(ROOT, 'src', 'server.ts');
const RECORDER = join(ROOT, 'test', 'fixtures', 'record-loads.ts');

const DIR = await mkdtemp(join(tmpdir(), 'pb-mcp-local-'));
const HOME = join(DIR, 'home');
const SHIM = join(DIR, 'shim');
const OUT = join(SHIM, 'out');
const CALLS = join(SHIM, 'calls.log');
const REPOS = join(DIR, 'repos');
const MAIN = join(REPOS, 'shop-web');

// ---- the shims: one script per command, logging "<cmd> <args>" and printing out/<key> ----

async function shim(cmd: string, key: string) {
  const script = `#!/bin/sh
echo "${cmd} $*" >> "${CALLS}"
k="${key}"
f="${OUT}/$k"
[ -f "$f" ] || exit 1
cat "$f"
exit 0
`;
  await writeFile(join(SHIM, 'bin', cmd), script);
  await chmod(join(SHIM, 'bin', cmd), 0o755);
}
await mkdir(join(SHIM, 'bin'), { recursive: true });
await mkdir(OUT, { recursive: true });
await mkdir(HOME, { recursive: true });
await shim('git', 'git-$(basename "$2")');
await shim('systemctl', 'systemctl-$2');
for (const c of ['ss', 'systemd-run', 'journalctl', 'tailscale', 'docker', 'ip', 'gh']) await shim(c, c);
const out = (key: string, text: string) => writeFile(join(OUT, key), text);
const calls = async (cmd: string) => (await readFile(CALLS, 'utf8').catch(() => '')).split('\n').filter((l) => l.startsWith(`${cmd} `));

const LISTEN_PORT = 4173;
await out('ss', `LISTEN 0      511        127.0.0.1:${LISTEN_PORT}        0.0.0.0:*\n`);
await out('systemd-run', '');
await mkdir(join(MAIN, '.git'), { recursive: true });
await writeFile(join(MAIN, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
await out('git-shop-web', `worktree ${MAIN}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n\n`);

const DAEMON_SESSION = 'daemon-session-must-not-leak';

// ---- helpers ----

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNet();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** A clean env (no parent variables): the shims first on PATH, a temp HOME, the suite's locale. */
function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME,
    PATH: `${join(SHIM, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
    PORTBOARD_REPOS_ROOT: REPOS,
    ...(process.env.PORTBOARD_LOCALE !== undefined ? { PORTBOARD_LOCALE: process.env.PORTBOARD_LOCALE } : {}),
    ...extra,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

interface Daemon {
  port: number;
  url: string;
  stdout(): string;
  stderr(): string;
  stop(): Promise<void>;
}
const daemons: Daemon[] = [];

async function startDaemon(extra: Record<string, string> = {}): Promise<Daemon> {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: env({ PORTBOARD_PORT: String(port), CLAUDE_CODE_SESSION_ID: DAEMON_SESSION, CLAUDE_PID: '1', ...extra }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let so = '';
  let se = '';
  child.stdout.on('data', (d) => (so += d));
  child.stderr.on('data', (d) => (se += d));
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  const d: Daemon = {
    port,
    url: `http://127.0.0.1:${port}`,
    stdout: () => so,
    stderr: () => se,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    },
  };
  daemons.push(d);
  await until('the daemon to listen', () => so.includes(`listening on http://127.0.0.1:${port}`) || (child.exitCode !== null ? Promise.reject(new Error(`daemon exited: ${se}`)) : false));
  // Warm it: the first ping of a fresh daemon can be slow (cold caller cache), and a thin-mode test must not race
  // bin/mcp.mjs's 300 ms limit. 200 for a usable daemon, 403 for a token-mode or read-only one.
  await until('the first ping answer', async () => {
    const res = await fetch(`${d.url}/api/mcp/ping`).catch(() => null);
    await res?.arrayBuffer();
    return res && (res.status === 200 || res.status === 403);
  });
  return d;
}

type Msg = Record<string, any>;

/** A plugin MCP process (claude-plugin/bin/mcp.mjs) and its JSON-RPC lines. */
class Session {
  child: ChildProcess;
  lines: string[] = [];
  stderr = '';
  loads: string | null = null;
  private replies: Msg[] = [];
  private partial = '';
  exited: Promise<number | null>;

  constructor(opts: { url?: string; extra?: Record<string, string>; record?: boolean } = {}) {
    const loadsFile = opts.record ? join(DIR, `loads-${Math.random().toString(36).slice(2)}.txt`) : null;
    this.loads = loadsFile;
    const e = env({ PORTBOARD_PORT: String(main.port), ...(opts.url ? { PORTBOARD_URL: opts.url } : {}), ...(loadsFile ? { PB_LOADS_FILE: loadsFile } : {}), ...opts.extra });
    this.child = spawn(process.execPath, [...(loadsFile ? ['--import', RECORDER] : []), MCP_BIN], { env: e, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.on('data', (d: Buffer) => {
      this.partial += d;
      const parts = this.partial.split('\n');
      this.partial = parts.pop() ?? '';
      for (const l of parts) {
        this.lines.push(l);
        try {
          this.replies.push(JSON.parse(l));
        } catch {
          // not JSON: lines keeps it, and the "only JSON-RPC lines" checks see it
        }
      }
    });
    this.child.stderr!.on('data', (d) => (this.stderr += d));
    this.exited = new Promise((r) => this.child.on('exit', (code) => r(code)));
    this.child.stdin!.on('error', () => {});
  }
  send(m: Msg) {
    this.child.stdin!.write(`${JSON.stringify(m)}\n`);
  }
  raw(line: string) {
    this.child.stdin!.write(`${line}\n`);
  }
  reply(id: unknown, ms = 20_000): Promise<Msg> {
    return until(`the reply to ${String(id)}`, () => this.replies.find((r) => r.id === id), ms);
  }
  async call(id: number, method: string, params?: unknown): Promise<Msg> {
    this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return this.reply(id);
  }
  async loaded(): Promise<string[]> {
    return (await readFile(this.loads!, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  }
  async close(): Promise<number | null> {
    this.child.stdin!.end();
    const code = await Promise.race([this.exited, sleep(10_000).then(() => 'hung' as const)]);
    if (code === 'hung') this.child.kill('SIGKILL');
    return code === 'hung' ? null : code;
  }
}

const sessions: Session[] = [];
const open = (opts?: ConstructorParameters<typeof Session>[0]) => {
  const s = new Session(opts);
  sessions.push(s);
  return s;
};

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } };
const toolText = (r: Msg) => r.result.content[0].text as string;

/** A plain http server standing in for the dashboard. */
interface Fake {
  port: number;
  url: string;
  pings: number;
  posts: Msg[];
  close(): Promise<void>;
}
const fakes: { close(): Promise<void> }[] = [];
async function fake(handler: (req: IncomingMessage, res: ServerResponse, body: string, f: Fake) => void, port?: number): Promise<Fake> {
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createHttp((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const route = (req.url ?? '').split('?')[0];
      // Only these two are the dashboard's: anything else (a title probe's GET /) is a 404 and is not recorded.
      if (!((req.method === 'POST' && route === '/api/mcp') || (req.method === 'GET' && route === '/api/mcp/ping'))) return void json(res, 404, { error: 'not found' });
      // Count only what the plugin sends. A Portboard on the host probes every new loopback listener with GET /.
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'POST' && path === '/api/mcp') {
        try {
          f.posts.push(JSON.parse(body));
        } catch {
          f.posts.push({ unparsed: body });
        }
      } else if (req.method === 'GET' && path === '/api/mcp/ping') f.pings++;
      handler(req, res, body, f);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const p = port ?? (await freePort());
  await new Promise<void>((r) => server.listen(p, '127.0.0.1', () => r()));
  const f: Fake = {
    port: p,
    url: `http://127.0.0.1:${p}`,
    pings: 0,
    posts: [],
    close: () =>
      new Promise<void>((r) => {
        sockets.forEach((s) => s.destroy());
        if (!server.listening) return r();
        server.close(() => r());
      }),
  };
  fakes.push(f);
  return f;
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify(body));
};
/** Answers the ping with 200, and a POST by `answer(message)` (null: 204). */
const okDaemon = (answer: (m: Msg) => Msg | null, port?: number) =>
  fake((req, res, _body, f) => {
    if (req.method === 'GET') return json(res, 200, { ok: true, version: '0.0.0' });
    const m = f.posts[f.posts.length - 1];
    const a = answer(m);
    if (a === null) {
      res.writeHead(204);
      return void res.end();
    }
    json(res, 200, a);
  }, port);

/** The dashboard's HTTP answer. A browser-like fetch with the route's own header. */
async function http(d: { url: string }, method: 'GET' | 'POST', path: string, o: { body?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${d.url}${path}`, { method, headers: o.headers, body: o.body });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the text
  }
  return { status: res.status, body, text };
}
const HDR = { 'X-Portboard': '1', 'Content-Type': 'application/json' };
const rpc = (id: number, method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

// A real preview-profile dashboard shared by most tests (its state lives under the temp HOME).
const main = await startDaemon();
// The sessions use the same state profile as this dashboard.
const PATHS = resolvePaths(env({ PORTBOARD_PORT: String(main.port) }), HOME);
const auditLines = async (path = PATHS.audit) =>
  (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Msg);

// ============================================================ 1: thin mode answers like local mode

/** Drops what changes between two runs (timestamps). */
const stable = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === 'at' || k === 'generatedAt' || k === 'checkedAt' ? undefined : x)));

test('1 thin mode: initialize, tools/list and tools/call list_ports answer like the in-process server', async () => {
  const thin = open({ url: main.url, record: true });
  const local = open({ url: main.url, extra: { PORTBOARD_MCP_MODE: 'local' }, record: true });
  const seen: Msg[][] = [];
  for (const s of [thin, local]) {
    const got: Msg[] = [];
    got.push(await s.call(1, 'initialize', INIT));
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    got.push(await s.call(2, 'tools/list'));
    got.push(await s.call(3, 'tools/call', { name: 'list_ports', arguments: { include_system: true } }));
    seen.push(got);
  }
  assert.deepEqual(stable(seen[0][0]), stable(seen[1][0]), 'initialize');
  assert.deepEqual(seen[0][1], seen[1][1], 'tools/list');
  assert.ok(seen[0][1].result.tools.length > 30);
  assert.deepEqual(stable(JSON.parse(toolText(seen[0][2]))), stable(JSON.parse(toolText(seen[1][2]))), 'list_ports');
  assert.ok(JSON.parse(toolText(seen[0][2])).ports.some((p: any) => p.port === LISTEN_PORT), 'the fixture port is in the answer');
  const thinLoads = await thin.loaded();
  assert.ok(thinLoads.some((u) => u.endsWith('/src/mcp/thin.mjs')), 'thin.mjs was loaded');
  assert.ok(!thinLoads.some((u) => u.endsWith('/src/mcp.ts')));
  const localLoads = await local.loaded();
  assert.ok(localLoads.some((u) => u.endsWith('/src/mcp.ts')) && !localLoads.some((u) => u.endsWith('/src/mcp/thin.mjs')));
  assert.equal(await thin.close(), 0);
  assert.equal(await local.close(), 0);
});

// ============================================================ 2: thin mode loads no feature module

test('2 thin mode loads no file under src/features/ or src/core/ (until it switches to in-process)', async () => {
  const thin = open({ url: main.url, record: true });
  await thin.call(1, 'initialize', INIT);
  await thin.call(2, 'tools/list');
  const loaded = await thin.loaded();
  const mine = loaded.filter((u) => u.startsWith(pathToFileUrlPrefix()));
  assert.ok(mine.length > 0, 'the recorder saw this checkout\'s files');
  assert.deepEqual(mine.filter((u) => u.includes('/src/features/') || u.includes('/src/core/')), []);
  assert.deepEqual(mine.filter((u) => u.endsWith('.ts')), [], 'no .ts file: Node never loads its type stripper');
  assert.equal(await thin.close(), 0);
});
const pathToFileUrlPrefix = () => `file://${ROOT}`.replace(/\/$/, '');

test('measure: the thin child\'s idle RSS 5 s after initialize', async (t) => {
  const thin = open({ url: main.url });
  await thin.call(1, 'initialize', INIT);
  await sleep(5_000);
  const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(thin.child.pid)], { encoding: 'utf8' }).trim());
  t.diagnostic(`thin client idle RSS: ${kb} KB`);
  console.log(`# thin client idle RSS: ${(kb / 1024).toFixed(1)} MB`);
  assert.ok(kb < 66 * 1024, `RSS ${kb} KB`); // the stripper alone would add about 19 MB
  assert.equal(await thin.close(), 0);
});

// ============================================================ 3: when the daemon is not usable, bin/mcp.mjs picks src/mcp.ts

async function pickedLocal(url: string, extra: Record<string, string> = {}) {
  const s = open({ url, extra, record: true });
  const r = await s.call(1, 'tools/list');
  assert.ok(r.result.tools.length > 30);
  const loaded = await s.loaded();
  assert.ok(loaded.some((u) => u.endsWith('/src/mcp.ts')), 'src/mcp.ts');
  assert.ok(!loaded.some((u) => u.endsWith('/src/mcp/thin.mjs')), 'not thin.mjs');
  assert.equal(await s.close(), 0);
}

test('3 no daemon, ping 404 and ping 403 each give the in-process server', async () => {
  await pickedLocal(`http://127.0.0.1:${await freePort()}`);
  const f404 = await fake((_req, res) => json(res, 404, { error: 'not found' }));
  await pickedLocal(f404.url);
  assert.equal(f404.posts.length, 0, 'nothing but the ping was sent');
  await f404.close();
  const f403 = await fake((_req, res) => json(res, 403, { error: 'owner only' }));
  await pickedLocal(f403.url);
  assert.equal(f403.posts.length, 0);
  await f403.close();
  // a daemon that does not say ok: true, and one that answers too slowly
  const odd = await fake((_req, res) => json(res, 200, { ok: false }));
  await pickedLocal(odd.url);
  await odd.close();
  const slow = await fake((_req, res) => setTimeout(() => json(res, 200, { ok: true, version: '0' }), 1_500));
  await pickedLocal(slow.url);
  await slow.close();
});

test('3 PORTBOARD_MCP_MODE=local does not ask the daemon', async () => {
  const f = await okDaemon(() => null);
  await pickedLocal(f.url, { PORTBOARD_MCP_MODE: 'local' });
  assert.equal(f.pings, 0);
  await f.close();
});

test('3 a checkout without src/mcp/thin.mjs falls back to the in-process server, with one stderr line', async () => {
  // a checkout whose src/ has mcp.ts (a link: its imports resolve in the real tree) but no mcp/thin.mjs
  const fakeHome = join(DIR, 'old-checkout');
  await mkdir(join(fakeHome, 'src'), { recursive: true });
  await symlink(join(ROOT, 'package.json'), join(fakeHome, 'package.json'));
  await symlink(join(ROOT, 'src', 'mcp.ts'), join(fakeHome, 'src', 'mcp.ts'));
  const f = await okDaemon(() => null);
  const s = open({ url: f.url, extra: { PORTBOARD_HOME: fakeHome }, record: true });
  const r = await s.call(1, 'tools/list');
  assert.ok(r.result.tools.length > 30);
  assert.match(s.stderr, /cannot start .*thin\.mjs/);
  assert.equal(f.posts.length, 0, 'the daemon got no request');
  assert.ok((await s.loaded()).some((u) => u.endsWith('/src/mcp.ts')));
  assert.equal(await s.close(), 0);
});

test('3 token mode with the token required on loopback, and a read-only install: ping is 403 and bin/mcp.mjs picks src/mcp.ts', async () => {
  const token = await startDaemon({ PORTBOARD_ACCESS_MODE: 'token', PORTBOARD_REQUIRE_TOKEN_ON_LOOPBACK: '1' });
  const ping = await http(token, 'GET', '/api/mcp/ping');
  assert.deepEqual([ping.status, ping.body.error], [403, 'owner only']);
  await pickedLocal(token.url);
  const ro = await startDaemon({ PORTBOARD_READ_ONLY: '1' });
  const pro = await http(ro, 'GET', '/api/mcp/ping');
  assert.deepEqual([pro.status, pro.body], [403, { error: 'read-only' }]);
  await pickedLocal(ro.url);
});

test('3 every daemon whose ping is 200 also takes a tools/call', async () => {
  const tokenLoopbackOk = await startDaemon({ PORTBOARD_ACCESS_MODE: 'token' });
  for (const d of [main, tokenLoopbackOk]) {
    const ping = await http(d, 'GET', '/api/mcp/ping');
    assert.equal(ping.status, 200, d.url);
    assert.equal(ping.body.ok, true);
    const call = await http(d, 'POST', '/api/mcp', { headers: HDR, body: rpc(1, 'tools/call', { name: 'list_ports', arguments: { include_system: true } }) });
    assert.equal(call.status, 200, d.url);
    assert.equal(call.body.id, 1);
  }
});

// ============================================================ 4: the daemon goes away mid-session

test('4 a refused connection is tried once more after 1 s, then the session answers in-process', async () => {
  // it comes back within the second: the retry reaches it and the session stays thin
  const port = await freePort();
  let f = await okDaemon((m) => ({ jsonrpc: '2.0', id: m.id, result: { from: 'first' } }), port);
  const s = open({ url: f.url, record: true });
  assert.equal((await s.call(1, 'ping')).result.from, 'first');
  await f.close();
  s.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  await sleep(300);
  f = await okDaemon((m) => ({ jsonrpc: '2.0', id: m.id, result: { from: 'second' } }), port);
  assert.equal((await s.reply(2)).result.from, 'second', 'the retry reached the daemon that came back');
  assert.ok(!(await s.loaded()).some((u) => u.endsWith('/src/mcp.ts')), 'still thin');
  await f.close();

  // it stays down: both requests, sent together, are answered in-process, and so is the next one
  const t0 = Date.now();
  s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_ports', arguments: { include_system: true } } });
  s.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_ports', arguments: { include_system: true } } });
  const [a, b] = [await s.reply(3), await s.reply(4)];
  assert.ok(Date.now() - t0 >= 900, 'waited about a second before giving up');
  for (const r of [a, b]) assert.ok(JSON.parse(toolText(r)).ports.some((p: any) => p.port === LISTEN_PORT), 'the fixture answer');
  const next = await s.call(5, 'tools/call', { name: 'list_ports', arguments: { include_system: true } });
  assert.ok(JSON.parse(toolText(next)).ports.some((p: any) => p.port === LISTEN_PORT));
  assert.ok((await s.loaded()).some((u) => u.endsWith('/src/features/registry.ts')), 'the in-process server was loaded');
  for (const l of s.lines) assert.equal(JSON.parse(l).jsonrpc, '2.0', `stdout carries JSON-RPC lines only: ${l}`);
  assert.equal(s.lines.length, 5);
  assert.equal(await s.close(), 0);
});

test('4 a line that is not JSON gets -32700 and is not sent to the daemon', async () => {
  const f = await okDaemon((m) => ({ jsonrpc: '2.0', id: m.id, result: {} }));
  const s = open({ url: f.url });
  await s.call(1, 'ping');
  s.raw('{not json');
  const r = await s.reply(null);
  assert.deepEqual(r.error, { code: -32700, message: 'parse error' });
  s.raw('');
  s.raw('   ');
  await s.call(2, 'ping');
  assert.equal(s.lines.length, 3, 'blank lines are skipped without an answer');
  assert.equal(f.posts.length, 2, 'only the two valid requests reached the daemon');
  assert.equal(await s.close(), 0);
  await f.close();
});

// ============================================================ 5: a request that was sent is never sent again

test('5 the daemon hangs up after a write tool was sent: one request, a -32603 for its id, the session goes on thin', async () => {
  const f = await fake((req, res, _body, self) => {
    if (req.method === 'GET') return json(res, 200, { ok: true, version: '0.0.0' });
    const m = self.posts[self.posts.length - 1];
    if (m.method === 'tools/call') return void req.socket.destroy();
    json(res, 200, { jsonrpc: '2.0', id: m.id, result: {} });
  });
  const s = open({ url: f.url, record: true });
  await s.call(1, 'initialize', INIT);
  const r = await s.call(5, 'tools/call', { name: 'restart_service', arguments: { port: 8780 } });
  assert.equal(r.error.code, -32603);
  assert.match(r.error.message, /^Portboard dashboard request failed: \S+/);
  await sleep(1_800);
  assert.equal(f.posts.filter((m) => m.method === 'tools/call').length, 1, 'not sent again');
  // a notification that fails is dropped, and the next request still goes to the daemon
  s.send({ jsonrpc: '2.0', method: 'notifications/cancelled' });
  assert.deepEqual((await s.call(6, 'ping')).result, {});
  assert.ok(!(await s.loaded()).some((u) => u.endsWith('/src/mcp.ts')), 'did not switch to in-process');
  assert.equal(await s.close(), 0);
  await f.close();
});

test('5 a 5xx, and a 403 or 404 in mid-session, are JSON-RPC errors for that id', async () => {
  for (const status of [500, 403, 404, 405]) {
    const f = await fake((req, res) => (req.method === 'GET' ? json(res, 200, { ok: true, version: '0.0.0' }) : json(res, status, { error: 'x' })));
    const s = open({ url: f.url });
    const r = await s.call(1, 'tools/list');
    assert.deepEqual(r.error, { code: -32603, message: `Portboard dashboard request failed: ${status}` });
    assert.equal(f.posts.length, 1);
    assert.equal(await s.close(), 0);
    await f.close();
  }
});

// ============================================================ 6: POST /api/mcp and the ping

test('6 POST /api/mcp: header, non-local callers, size and notifications', async () => {
  const msg = rpc(1, 'ping');
  const noHeader = await http(main, 'POST', '/api/mcp', { body: msg, headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual([noHeader.status, noHeader.body], [403, { error: 'missing X-Portboard header' }]);
  for (const h of [{ 'Tailscale-User-Login': 'someone@example.com' }, { 'Tailscale-User-Login': 'someone@example.com', 'X-Forwarded-For': '100.64.0.9' }]) {
    const via = await http(main, 'POST', '/api/mcp', { body: msg, headers: { ...HDR, ...h } });
    assert.equal(via.status, 403, JSON.stringify(h));
    const ping = await http(main, 'GET', '/api/mcp/ping', { headers: h });
    assert.equal(ping.status, 403, `ping ${JSON.stringify(h)}`);
  }
  // Over 1 MB: the router refuses the body with 400 (checked in-process below). Over the wire, readBody also destroys the
  // request's socket, so the client sees either the 400 or a closed connection, never a 2xx.
  const bigBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1_048_576) } });
  const big = await http(main, 'POST', '/api/mcp', { headers: HDR, body: bigBody }).catch(() => ({ status: 0, body: null }));
  assert.ok(big.status === 400 || big.status === 0, `status ${big.status}`);
  const bad = await http(main, 'POST', '/api/mcp', { headers: HDR, body: '{nope' });
  assert.equal(bad.status, 400);
  const note = await http(main, 'POST', '/api/mcp', { headers: HDR, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.deepEqual([note.status, note.text], [204, '']);
  // a body that is not an object: handleMessage has nothing to answer
  for (const body of ['null', '7', '[]', '[{"id":1}]', '"x"']) {
    const r = await http(main, 'POST', '/api/mcp', { headers: HDR, body });
    assert.deepEqual([r.status, r.text], [204, ''], body);
  }
  const ok = await http(main, 'POST', '/api/mcp', { headers: HDR, body: msg });
  assert.deepEqual([ok.status, ok.body], [200, { jsonrpc: '2.0', id: 1, result: {} }]);
});

test('6 a body over 1 MB is a 400 from the router', async () => {
  const { createRouter } = await import('../src/features/router.ts');
  const { mcpLocalFeature } = await import('../src/features/mcp-local.ts');
  const route = createRouter(mcpLocalFeature.routes!);
  const r = Readable.from([Buffer.alloc(1_048_577, 0x78)]) as any;
  r.method = 'POST';
  r.headers = { 'x-portboard': '1' };
  r.socket = { remoteAddress: '127.0.0.1' };
  assert.deepEqual(await route(r, new URL('http://x/api/mcp'), {} as any), { status: 400, body: { error: 'invalid JSON body' } });
});

test('6 the handler itself refuses a caller with proxy headers, even when the router would let it through', async () => {
  const { createRouter } = await import('../src/features/router.ts');
  const { mcpLocalFeature } = await import('../src/features/mcp-local.ts');
  const route = createRouter(mcpLocalFeature.routes!); // no guard: only the handler's own check is left
  const req = (method: string, headers: Record<string, string>) => {
    const r = Readable.from([Buffer.from(rpc(1, 'ping'))]) as any;
    r.method = method;
    r.headers = headers;
    r.socket = { remoteAddress: '127.0.0.1' };
    return r;
  };
  const post = await route(req('POST', { 'x-portboard': '1', 'tailscale-user-login': 'a@example.com' }), new URL('http://x/api/mcp'), {} as any);
  assert.deepEqual(post, { status: 403, body: { error: 'loopback only' } });
  const ping = await route(req('GET', { 'tailscale-user-login': 'a@example.com' }), new URL('http://x/api/mcp/ping'), {} as any);
  assert.deepEqual(ping, { status: 403, body: { error: 'loopback only' } });
});

// ============================================================ 7: auditOk

test('7 auditOk needs write: true', () => {
  const handler = async () => ({ status: 200, body: {} });
  assert.throws(() => buildRegistry([{ name: 'x', order: 1, routes: [{ method: 'GET', path: '/api/x', auditOk: false, handler } as unknown as Route] }]), /auditOk without write: true/);
  const reg = buildRegistry([{ name: 'x', order: 1, routes: [{ method: 'POST', path: '/api/x', write: true, auditOk: false, handler }] }]);
  assert.equal(reg.routes.length, 1);
});

// ============================================================ 8: the session goes to the unit, the daemon's env does not

const unitSessions = async () => (await calls('systemd-run')).map((l) => ({ id: /--setenv=CLAUDE_CODE_SESSION_ID=(\S+)/.exec(l)?.[1] ?? null, pid: /--setenv=CLAUDE_PID=(\S+)/.exec(l)?.[1] ?? null, line: l }));

test('8 start_dev_server: the unit gets the caller\'s session id, never the daemon\'s, and bad headers are dropped', async () => {
  const start = (id: number) => rpc(id, 'tools/call', { name: 'start_dev_server', arguments: { path: MAIN } });
  const before = (await unitSessions()).length;

  const valid = await http(main, 'POST', '/api/mcp', { headers: { ...HDR, 'X-Portboard-Session': 'sess-valid-0001', 'X-Portboard-Claude-Pid': '4242' }, body: start(1) });
  assert.equal(valid.status, 200);
  assert.ok(!valid.body.result.isError, toolText(valid.body));
  let runs = await unitSessions();
  assert.deepEqual([runs[before].id, runs[before].pid], ['sess-valid-0001', '4242']);

  for (const [i, headers] of [
    [2, { 'X-Portboard-Session': 'bad id!', 'X-Portboard-Claude-Pid': '12x' }],
    [3, { 'X-Portboard-Session': 'short' }],
    [4, {}],
  ] as const) {
    const r = await http(main, 'POST', '/api/mcp', { headers: { ...HDR, ...headers }, body: start(i) });
    assert.equal(r.status, 200);
    assert.ok(!r.body.result.isError, toolText(r.body));
    runs = await unitSessions();
    assert.deepEqual([runs[before + i - 1].id, runs[before + i - 1].pid], [null, null], `${JSON.stringify(headers)} is dropped`);
  }
  assert.ok(!runs.some((r) => r.line.includes(DAEMON_SESSION)), 'the daemon\'s own session id was never passed');

  // thin and in-process modes: the same session id from their own env
  const sessEnv = { CLAUDE_CODE_SESSION_ID: 'sess-thin-session-0001', CLAUDE_PID: '777' };
  const thin = open({ url: main.url, extra: sessEnv });
  await thin.call(1, 'initialize', INIT);
  const n0 = (await unitSessions()).length;
  assert.ok(!(await thin.call(2, 'tools/call', { name: 'start_dev_server', arguments: { path: MAIN } })).result.isError);
  const local = open({ url: main.url, extra: { ...sessEnv, CLAUDE_CODE_SESSION_ID: 'sess-thin-session-0001', PORTBOARD_MCP_MODE: 'local' } });
  assert.ok(!(await local.call(1, 'tools/call', { name: 'start_dev_server', arguments: { path: MAIN } })).result.isError);
  runs = await unitSessions();
  assert.deepEqual([runs[n0].id, runs[n0 + 1].id], ['sess-thin-session-0001', 'sess-thin-session-0001']);
  assert.deepEqual([runs[n0].pid, runs[n0 + 1].pid], ['777', '777']);
  assert.equal(await thin.close(), 0);
  assert.equal(await local.close(), 0);
});

// ============================================================ 9: audit

test('9 audit: one source "mcp" line per write tool; none for reads, the ping or the POST itself; a refused POST is denied', async () => {
  const thin = open({ url: main.url });
  await thin.call(1, 'initialize', INIT);
  const before = await auditLines();
  const beforeDenied = await auditLines(PATHS.audit.replace(/\.jsonl$/, '-denied.jsonl'));

  await thin.call(2, 'tools/call', { name: 'list_ports', arguments: { include_system: true } });
  await http(main, 'GET', '/api/mcp/ping');
  assert.equal((await auditLines()).length, before.length, 'a read tool and a ping leave no audit line');

  assert.ok(!(await thin.call(3, 'tools/call', { name: 'start_dev_server', arguments: { path: MAIN } })).result.isError);
  const after = await until('the audit line', async () => {
    const l = await auditLines();
    return l.length > before.length ? l : null;
  });
  const added = after.slice(before.length);
  assert.equal(added.length, 1, JSON.stringify(added));
  assert.deepEqual([added[0].source, added[0].route, added[0].result], ['mcp', 'mcp start_dev_server', 'ok']);
  assert.equal(added.filter((l) => String(l.route).includes('/api/mcp')).length, 0, 'no POST /api/mcp line');

  const refused = await http(main, 'POST', '/api/mcp', { body: rpc(1, 'ping'), headers: { ...HDR, 'Tailscale-User-Login': 'audit-check@example.com' } });
  assert.equal(refused.status, 403);
  const denied = await until('the denied line', async () => {
    const l = await auditLines(PATHS.audit.replace(/\.jsonl$/, '-denied.jsonl'));
    return l.length > beforeDenied.length ? l : null;
  });
  const d = denied.slice(beforeDenied.length);
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].route, d[0].result, d[0].status], ['POST /api/mcp', 'denied', 403]);
  assert.equal(await thin.close(), 0);
});

// ============================================================ 10: port-advice?command=

async function tree(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await tree(p)));
    else if (e.isFile()) files.push(p);
  }
  return files;
}

test('10 port-advice?command=: the same answer as port/cmd/tool, null for no port or a long command, and the command is never kept', async () => {
  const MARK = 'zzleakmark9';
  const command = `npm run dev -- --port 3000 # ${MARK}`;
  const [hit] = parsePortCommands(command);
  assert.deepEqual([hit.port, hit.kind], [3000, 'start']);
  const q = (o: Record<string, string>) => `/api/claude/port-advice?${new URLSearchParams(o)}`;
  const viaCommand = await http(main, 'GET', q({ command, cwd: '/tmp' }));
  const viaParts = await http(main, 'GET', q({ port: String(hit.port), cmd: hit.kind, tool: hit.tool, cwd: '/tmp' }));
  assert.equal(viaCommand.status, 200);
  assert.deepEqual(viaCommand.body, viaParts.body);
  assert.match(viaCommand.body.text, /^\[portboard\]/);
  assert.equal((await http(main, 'GET', q({ port: '3000', cmd: 'start' }))).status, 200, 'the old form still works');

  assert.deepEqual((await http(main, 'GET', q({ command: `ls ${MARK}` }))).body, { text: null });
  const long = await http(main, 'GET', q({ command: `npm run dev -- --port 3000 #${' '.repeat(4096 - 31)}${MARK}`.padEnd(4097, 'x') }));
  assert.deepEqual([long.status, long.body], [200, { text: null }]);
  const atLimit = await http(main, 'GET', q({ command: `npm run dev -- --port 3000 #${MARK}`.padEnd(4096, 'x') }));
  assert.equal(atLimit.status, 200);
  assert.match(atLimit.body.text, /^\[portboard\]/, 'a command of exactly 4096 characters is still read');

  for (const r of [viaCommand, long, atLimit]) assert.ok(!r.text.includes(MARK), 'not in the answer');
  assert.ok(!main.stdout().includes(MARK) && !main.stderr().includes(MARK), 'not in the daemon\'s output');
  for (const f of await tree(HOME)) assert.ok(!(await readFile(f, 'utf8').catch(() => '')).includes(MARK), `not in ${f}`);
});

// ============================================================ 11: stdin closes

test('11 stdin closes: the request in flight is answered, then the exit code is 0', async () => {
  const f = await fake((req, res, _body, self) => {
    if (req.method === 'GET') return json(res, 200, { ok: true, version: '0.0.0' });
    const m = self.posts[self.posts.length - 1];
    setTimeout(() => json(res, 200, { jsonrpc: '2.0', id: m.id, result: { slow: true } }), 600);
  });
  const s = open({ url: f.url });
  s.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'adoption_stats', arguments: {} } });
  await until('the daemon to get the request', () => f.posts.length > 0);
  s.child.stdin!.end();
  assert.equal(await s.exited, 0);
  assert.deepEqual(s.lines.map((l) => JSON.parse(l)), [{ jsonrpc: '2.0', id: 1, result: { slow: true } }]);
  await f.close();
});

// ============================================================ coding agents: the caller's PATH finds the CLI

test('start_coding_agent in thin mode looks for the CLI on the caller\'s PATH (X-Portboard-Path), not the dashboard\'s', async () => {
  const cliDir = join(DIR, 'cli-bin'); // not on the dashboard's PATH
  await mkdir(cliDir, { recursive: true });
  await chmod(cliDir, 0o755);
  await writeFile(join(cliDir, 'codex'), '#!/bin/sh\nexit 0\n');
  await chmod(join(cliDir, 'codex'), 0o755);
  // a dashboard whose PATH has no nvm folder (a real codex may sit next to this Node), as under systemd
  const agentDaemon = await startDaemon({ PATH: `${join(SHIM, 'bin')}:/usr/bin:/bin` });
  const startReq = (id: number) => rpc(id, 'tools/call', { name: 'start_coding_agent', arguments: { kind: 'codex', path: MAIN, prompt: 'hello' } });
  const run = async (headers: Record<string, string>, id: number) => {
    const r = await http(agentDaemon, 'POST', '/api/mcp', { headers: { ...HDR, ...headers }, body: startReq(id) });
    assert.equal(r.status, 200);
    return r.body.result as { isError?: boolean; content: { text: string }[] };
  };
  const sess = { 'X-Portboard-Session': 'sess-agent-0001' };

  // without the header: the dashboard's PATH has no codex
  const none = await run(sess, 1);
  assert.equal(none.isError, true, none.content[0].text);
  // relative and malformed PATHs are dropped whole (then: not installed)
  for (const bad of ['bin:relative/dir', './x', 'a'.repeat(5000), Array.from({ length: 70 }, (_, i) => `/nope${i}`).join(':')]) {
    const r = await run({ ...sess, 'X-Portboard-Path': bad }, 2);
    assert.equal(r.isError, true, bad.slice(0, 40));
  }
  const before = (await unitSessions()).length;
  // a CLI or its folder that others can write is refused ("not installed"); nothing is started
  const mk = async (name: string, dirMode: number, fileMode: number) => {
    const d = join(DIR, name);
    await mkdir(d, { recursive: true });
    await chmod(d, dirMode); // mkdir is cut by the umask
    await writeFile(join(d, 'codex'), '#!/bin/sh\nexit 0\n');
    await chmod(join(d, 'codex'), fileMode);
    return d;
  };
  // (group-writable cases depend on the host's groups: see the in-process test below)
  for (const [name, dirMode, fileMode] of [['cli-open-dir', 0o777, 0o755], ['cli-other-file', 0o755, 0o757]] as const) {
    const d = await mk(name, dirMode, fileMode);
    const r = await run({ ...sess, 'X-Portboard-Path': d }, 4);
    assert.equal(r.isError, true, name);
    assert.doesNotMatch(r.content[0].text, /already going/, `${name}: refused before a run is looked for`);
  }
  assert.equal((await unitSessions()).length, before, 'no run was started');
  // a link to a CLI that sits in a folder others can write is refused too
  const linkDir = join(DIR, 'cli-link');
  await mkdir(linkDir, { recursive: true });
  await chmod(linkDir, 0o755);
  await symlink(join(await mk('cli-open-target', 0o777, 0o755), 'codex'), join(linkDir, 'codex'));
  assert.equal((await run({ ...sess, 'X-Portboard-Path': linkDir }, 4)).isError, true, 'link into a writable folder');
  assert.equal((await unitSessions()).length, before);
  // a relative entry is skipped, an absolute one with the CLI is used
  const ok = await run({ ...sess, 'X-Portboard-Path': `relative:${cliDir}` }, 3);
  assert.ok(!ok.isError, ok.content[0].text);
  const runs = await unitSessions();
  assert.equal(runs.length, before + 1);
  assert.equal(runs[before].id, 'sess-agent-0001');
  assert.ok(runs[before].line.includes(`--setenv=PATH=${cliDir}:`), runs[before].line);
  assert.ok(!runs[before].line.includes('hello'), 'the prompt is not in the unit args');

  // through the thin client: its own PATH is sent
  // (a second dashboard: the first already has a run going in this worktree)
  const agentDaemon2 = await startDaemon({ PATH: `${join(SHIM, 'bin')}:/usr/bin:/bin` });
  const thin = open({ url: agentDaemon2.url, extra: { PATH: `${cliDir}:${env().PATH}`, CLAUDE_CODE_SESSION_ID: 'sess-agent-0002' } });
  await thin.call(1, 'initialize', INIT);
  const viaThin = await thin.call(2, 'tools/call', { name: 'start_coding_agent', arguments: { kind: 'codex', path: MAIN, prompt: 'hello' } });
  assert.ok(!viaThin.result.isError, toolText(viaThin));
  const after = await unitSessions();
  assert.equal(after[after.length - 1].id, 'sess-agent-0002');
  assert.equal(await thin.close(), 0);
});

test('trustedPath: group write is accepted only for the user\'s own private group; other write never', async () => {
  const { groupHasNoMembers, trustedPath } = await import('../src/features/mcp-local.ts');
  const gid = process.getgid!();

  // the pure lookup, on sample /etc/group text
  const text = 'root:x:0:\nme:x:1000:\nteam:x:1001:alice,bob\nlonely:*:1002:  \nbroken line\n:x:abc:\n';
  assert.equal(groupHasNoMembers(text, 1000), true, 'empty member list');
  assert.equal(groupHasNoMembers(text, 1002), true, 'blank member list');
  assert.equal(groupHasNoMembers(text, 1001), false, 'has members');
  assert.equal(groupHasNoMembers(text, 4242), false, 'gid not listed');
  assert.equal(groupHasNoMembers('', 0), false);

  // real folders: a 0775 folder with a 0775 codex, as an npm-global install under a user-private group
  const make = async (name: string, dirMode: number, fileMode: number) => {
    const d = join(DIR, name);
    await mkdir(d, { recursive: true });
    await chmod(d, dirMode);
    await writeFile(join(d, 'codex'), '#!/bin/sh\nexit 0\n');
    await chmod(join(d, 'codex'), fileMode);
    return d;
  };
  const group = await make('trust-group', 0o775, 0o775);
  assert.equal(trustedPath(group, () => false), '', 'group is not a private group: refused');
  assert.equal(trustedPath(group, (g) => g === gid), group, 'own private group: accepted');
  assert.equal(trustedPath(group, (g) => g !== gid), '', 'the lookup is asked about this process\'s gid');
  // only the file, or only the folder
  assert.equal(trustedPath(await make('trust-group-file', 0o755, 0o775), () => false), '');
  assert.equal(trustedPath(await make('trust-group-dir', 0o775, 0o755), () => false), '');
  assert.equal(trustedPath(await make('trust-group-file-ok', 0o755, 0o775), () => true), join(DIR, 'trust-group-file-ok'));
  // other write is never accepted, whatever the lookup says
  assert.equal(trustedPath(await make('trust-other-dir', 0o777, 0o755), () => true), '');
  assert.equal(trustedPath(await make('trust-other-file', 0o755, 0o757), () => true), '');
  // a plain 0755 folder with a 0755 codex needs no group at all
  const plain = await make('trust-plain', 0o755, 0o755);
  assert.equal(trustedPath(plain, () => false), plain);
  // a link: its own mode is not looked at, the target and its folder are (npm global: bin/codex -> ../lib/.../codex.js)
  const lib = await make('trust-lib', 0o775, 0o775);
  const bin = join(DIR, 'trust-bin');
  await mkdir(bin, { recursive: true });
  await chmod(bin, 0o755);
  await symlink(join(lib, 'codex'), join(bin, 'codex'));
  assert.equal(trustedPath(bin, () => false), '', 'target in a group-writable folder, group not private');
  assert.equal(trustedPath(bin, (g) => g === gid), bin, 'target and folder 0775 in the own private group');
  // entries are filtered one by one
  assert.equal(trustedPath(`${group}:${plain}`, () => false), plain);
});

// ============================================================ measurement: a long tool and other GETs

test('measure: a long tool in the daemon does not hold up other requests', async (t) => {
  // adoption_stats scans session files under HOME (none here), so this only shows the event loop stays free while
  // a tool call is in flight
  const slow = http(main, 'POST', '/api/mcp', { headers: HDR, body: rpc(9, 'tools/call', { name: 'adoption_stats', arguments: {} }) });
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await http(main, 'GET', '/api/mcp/ping');
    times.push(Date.now() - t0);
  }
  await slow;
  t.diagnostic(`GET /api/mcp/ping while adoption_stats runs: ${times.join(', ')} ms`);
  console.log(`# ping latency during adoption_stats: ${times.join(', ')} ms`);
  assert.ok(Math.max(...times) < 1000, times.join(','));
});

// One cleanup, in this order, and one failure never skips the rest: processes first (they write into DIR), then the
// listeners a failed assertion left open (they would keep the file from exiting), then the folder.
after(async () => {
  for (const s of sessions) {
    try {
      s.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  await Promise.allSettled([...daemons.map((d) => d.stop()), ...fakes.map((f) => f.close())]);
  await rm(DIR, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});
