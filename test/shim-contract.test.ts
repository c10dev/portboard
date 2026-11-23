// The contract between the plugin's Node processes and the Go binary (shim/): the same cases (test/fixtures/shim-contract/)
// run here against claude-plugin/bin/mcp.mjs and claude-plugin/hooks/port-nudge.ts, and in shim/main_test.go against
// `portboard-shim mcp` and `portboard-shim nudge`. Both must give each expected result, so the Go binary stays a byte
// mover with the same observable behaviour. The only accepted differences are written in the data, as 'go' overrides
// with a 'split' reason (the nudge's cheap filter, the dashboard-side parse, the 4096-byte limit).
//
// Fake dashboards are plain http servers on temporary ports. The child processes get a clean environment and a temp
// HOME, never the real one. What this proves: wiring and bytes against a fake, not a live dashboard.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNet, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from './fixtures/child-env.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const MCP_BIN = join(ROOT, 'claude-plugin', 'bin', 'mcp.mjs');
const NUDGE_BIN = join(ROOT, 'claude-plugin', 'hooks', 'port-nudge.ts');
const DATA = join(ROOT, 'test', 'fixtures', 'shim-contract');
const load = <T>(file: string): T => JSON.parse(readFileSync(join(DATA, file), 'utf8')) as T;

// ---- the data ----

type Reply = { status?: number; body?: string | unknown; reply?: 'echo'; hangup?: boolean; whenMethod?: string; delayMs?: number };
interface McpCase {
  name: string;
  env?: Record<string, string>;
  daemon: { refuse?: boolean; closeAfterPing?: boolean; ping?: { status: number; body: string }; posts?: Reply[] };
  stdin: (string | { waitLines: number })[];
  expect: McpExpect & { node?: Partial<McpExpect>; go?: Partial<McpExpect> };
}
interface McpExpect {
  stdout: string[];
  exit: number;
  pings: number;
  posts: number;
  bodies?: string[];
  session?: string | null;
  pid?: string | null;
  versionLine?: boolean;
}
type Command = string | { prefix: string; padTo: number; pad: string };
interface NudgeCase {
  name: string;
  input?: { tool_name: string; tool_input: { command?: unknown }; cwd?: string; session_id?: string };
  stdin?: string | { repeat: string; times: number };
  env?: Record<string, string>;
  urlScheme?: string;
  daemon: { refuse?: boolean; status?: number; body?: unknown; delayMs?: number };
  expect: NudgeExpect & { node?: Partial<NudgeExpect>; go?: Partial<NudgeExpect> };
  split?: string;
}
interface NudgeExpect {
  context: string | null;
  requests: number;
  cwd?: string | null;
  session?: string | null;
  command?: string;
}

const mcpCases = load<{ cases: McpCase[] }>('mcp.json').cases;
const nudgeCases = load<{ cases: NudgeCase[] }>('nudge.json').cases;

// ---- helpers ----

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A port nothing listens on (nothing else can take it before the child connects, in practice). */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNet();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** The command of a nudge case: a string, or a prefix padded with `pad` to `padTo` bytes. */
function commandOf(c: Command): string {
  if (typeof c === 'string') return c;
  return c.prefix + c.pad.repeat(c.padTo - Buffer.byteLength(c.prefix));
}

function hookJson(c: NudgeCase): string {
  if (c.stdin !== undefined) return typeof c.stdin === 'string' ? c.stdin : c.stdin.repeat.repeat(c.stdin.times);
  const input = c.input!;
  const command = input.tool_input.command;
  const tool_input = command !== null && typeof command === 'object' ? { command: commandOf(command as Command) } : input.tool_input;
  return JSON.stringify({ hook_event_name: 'PreToolUse', ...input, tool_input });
}

const hookLine = (context: string | null) =>
  context === null ? '' : `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } })}\n`;

interface Fake {
  url: string;
  pings: number;
  posts: { body: string; headers: IncomingMessage['headers'] }[];
  requests: { query: URLSearchParams }[];
  close(): Promise<void>;
}

/** A fake dashboard that listens on a temporary port (or, with `refuse`, one that nothing listens on). */
async function fakeDaemon(
  handler: (req: IncomingMessage, res: ServerResponse, body: string, f: Fake, server: Server) => void,
  refuse = false,
  scheme = 'http',
): Promise<Fake> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, res, body, f, server));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const port = refuse ? await closedPort() : await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));
  const f: Fake = {
    url: `${scheme}://127.0.0.1:${port}`,
    pings: 0,
    posts: [],
    requests: [],
    close: () =>
      new Promise<void>((r) => {
        sockets.forEach((s) => s.destroy());
        if (!server.listening) return r();
        server.close(() => r());
      }),
  };
  return f;
}

function send(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(body);
}

// ---- mcp ----

function mcpDaemon(spec: McpCase['daemon']): Promise<Fake> {
  return fakeDaemon((req, res, body, f, server) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/api/mcp/ping') {
      f.pings++;
      if (spec.closeAfterPing) server.close();
      const ping = spec.ping ?? { status: 404, body: '{}' };
      return send(res, ping.status, ping.body);
    }
    if (req.method !== 'POST' || path !== '/api/mcp') return send(res, 404, '{"error":"not found"}');
    f.posts.push({ body, headers: req.headers });
    let msg: { id?: unknown; method?: string } = {};
    try {
      msg = JSON.parse(body);
    } catch {
      // keep {}
    }
    const entries = spec.posts ?? [];
    const pick = entries.find((e) => e.whenMethod !== undefined && e.whenMethod === msg?.method) ?? entries.find((e) => e.whenMethod === undefined) ?? entries[entries.length - 1];
    if (!pick) return send(res, 500, '{}');
    if (pick.hangup) return void req.socket.destroy();
    if (pick.status === 204) {
      res.writeHead(204, { connection: 'close' });
      return void res.end();
    }
    if (pick.reply === 'echo') return send(res, pick.status ?? 200, JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: { echo: msg.method } }));
    send(res, pick.status ?? 200, typeof pick.body === 'string' ? pick.body : JSON.stringify(pick.body));
  }, spec.refuse === true);
}

for (const c of mcpCases) {
  test(`mcp contract (Node): ${c.name}`, async () => {
    const fake = await mcpDaemon(c.daemon);
    const { env: base, done } = await childEnv();
    try {
      const env = { ...base, PORTBOARD_URL: fake.url, PORTBOARD_HOME: ROOT, ...c.env };
      const child = spawn(process.execPath, [MCP_BIN], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.stdin.on('error', () => {});
      const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
      const lines = () => out.split('\n').filter(Boolean);
      for (const item of c.stdin) {
        if (typeof item === 'string') child.stdin.write(`${item}\n`);
        else await until(`${item.waitLines} output lines`, () => lines().length >= item.waitLines);
      }
      child.stdin.end();
      const code = await Promise.race([exited, sleep(30_000).then(() => 'hung' as const)]);
      if (code === 'hung') child.kill('SIGKILL');
      const want = { ...c.expect, ...c.expect.node };
      assert.notEqual(code, 'hung', `the process did not exit; stderr: ${err}`);
      assert.deepEqual(lines().sort(), [...want.stdout].sort(), `stdout (stderr: ${err})`);
      assert.equal(code, want.exit, 'exit code');
      if (want.versionLine !== undefined) assert.equal(/the dashboard runs version/.test(err), want.versionLine, 'the version-mismatch line on stderr');
      assert.equal(fake.pings, want.pings, 'pings the dashboard got');
      assert.equal(fake.posts.length, want.posts, 'POSTs the dashboard got');
      if (want.bodies) assert.deepEqual(fake.posts.map((p) => p.body).sort(), [...want.bodies].sort(), 'POST bodies');
      if (want.posts > 0) {
        for (const p of fake.posts) {
          assert.equal(p.headers['x-portboard'], '1');
          assert.equal(p.headers['content-type'], 'application/json');
          if ('session' in want) assert.equal(p.headers['x-portboard-session'] ?? null, want.session, 'session header');
          if ('pid' in want) assert.equal(p.headers['x-portboard-claude-pid'] ?? null, want.pid, 'claude pid header');
        }
      }
    } finally {
      await fake.close();
      await done();
    }
  });
}

// ---- nudge ----

function nudgeDaemon(spec: NudgeCase['daemon'], scheme: string): Promise<Fake> {
  return fakeDaemon(
    (req, res, _body, f) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname !== '/api/claude/port-advice') return send(res, 404, '{"error":"not found"}');
      f.requests.push({ query: u.searchParams });
      const reply = () => {
        const status = spec.status ?? 200;
        if (status === 204) {
          res.writeHead(204);
          return void res.end();
        }
        send(res, status, JSON.stringify(spec.body ?? {}));
      };
      if (spec.delayMs) setTimeout(reply, spec.delayMs).unref();
      else reply();
    },
    spec.refuse === true,
    scheme,
  );
}

for (const c of nudgeCases) {
  test(`nudge contract (Node): ${c.name}`, async () => {
    const fake = await nudgeDaemon(c.daemon, 'http');
    const { env: base, done } = await childEnv();
    try {
      const url = c.urlScheme ? fake.url.replace(/^http/, c.urlScheme) : fake.url;
      const env = { ...base, PORTBOARD_URL: url, PORTBOARD_HOME: ROOT, PORTBOARD_HOOK_TIMEOUT_MS: '10000', ...c.env };
      const child = spawn(process.execPath, [NUDGE_BIN], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.stdin.on('error', () => {});
      const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
      child.stdin.end(hookJson(c));
      const code = await Promise.race([exited, sleep(30_000).then(() => 'hung' as const)]);
      if (code === 'hung') child.kill('SIGKILL');
      const want = { ...c.expect, ...c.expect.node };
      assert.equal(code, 0, 'exit code');
      assert.equal(err, '', 'stderr');
      assert.equal(out, hookLine(want.context), 'stdout');
      assert.equal(fake.requests.length, want.requests, 'requests the dashboard got');
      const last = fake.requests[fake.requests.length - 1];
      if (last && 'cwd' in want) assert.equal(last.query.get('cwd'), want.cwd, 'cwd in the query');
      if (last && 'session' in want) assert.equal(last.query.get('session'), want.session, 'session in the query');
    } finally {
      await fake.close();
      await done();
    }
  });
}

// ---- bin/run.sh: which program a plugin command starts ----

/** The real binary, built once into a temp dir (never into the checkout). path is null, with the reason, when go is not on PATH. */
let built: Promise<{ path: string | null; why: string }> | null = null;
const buildDirs: string[] = [];
after(() => Promise.all(buildDirs.map((d) => rm(d, { recursive: true, force: true }))));
function realShim() {
  built ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pb-shim-build-'));
    buildDirs.push(dir);
    const path = join(dir, 'portboard-shim');
    const r = spawnSync('go', ['build', '-o', path, '.'], { cwd: join(ROOT, 'shim'), env: { ...process.env, CGO_ENABLED: '0' }, encoding: 'utf8' });
    if (r.error || r.status !== 0) return { path: null, why: `go is not available to build shim/ (${r.error?.message ?? r.stderr.slice(0, 200)})` };
    return { path, why: '' };
  })();
  return built;
}

/** The start of a 64-bit ELF file that no kernel runs (an unknown machine type, no program headers). */
const FOREIGN_ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(8), Buffer.from([2, 0, 0xb7, 0, 1, 0, 0, 0]), Buffer.alloc(40)]);

type ShimKind = 'none' | 'real' | 'truncated' | 'empty' | 'text-true' | 'foreign-elf';

interface RunSh {
  dir: string;
  bin: string;
  run(args: string[], env?: Record<string, string>, opts?: { script?: string; cwd?: string }): Promise<{ code: number | null; stdout: string; stderr: string }>;
  calls(): Promise<string[]>;
  done(): Promise<void>;
}

/** A plugin folder copy with a fake node that only logs what it was called with, and the binary of the given kind. null: skipped (reason in `why`). */
async function runShFixture(kind: ShimKind): Promise<{ f: RunSh | null; why: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pb-run-sh-'));
  const bin = join(dir, 'plugin', 'bin');
  const nodeDir = join(dir, 'nodebin');
  const log = join(dir, 'calls.log');
  await mkdir(bin, { recursive: true });
  await mkdir(nodeDir, { recursive: true });
  copyFileSync(join(ROOT, 'claude-plugin', 'bin', 'run.sh'), join(bin, 'run.sh'));
  const file = (name: string, body: string | Buffer) => writeFile(name, body).then(() => chmod(name, 0o755));
  await file(join(nodeDir, 'node'), `#!/bin/sh\necho "NODE $*" >> "${log}"\n`);
  const path = join(bin, 'portboard-shim');
  if (kind === 'real' || kind === 'truncated') {
    const b = await realShim();
    if (b.path === null) {
      await rm(dir, { recursive: true, force: true });
      return { f: null, why: b.why };
    }
    const bytes = readFileSync(b.path);
    await file(path, kind === 'real' ? bytes : bytes.subarray(0, 1000));
  }
  if (kind === 'empty') await file(path, '');
  if (kind === 'text-true') await file(path, 'true\n');
  if (kind === 'foreign-elf') await file(path, FOREIGN_ELF);
  const f: RunSh = {
    dir,
    bin,
    run: (args, env = {}, opts = {}) =>
      new Promise((resolve) => {
        // cwd is the temp dir: a probe that wrote a file or read the cwd would show there, not in the checkout
        const child = spawn('sh', [opts.script ?? join(bin, 'run.sh'), ...args], { cwd: opts.cwd ?? dir, env: { HOME: dir, PATH: `${nodeDir}:/usr/bin:/bin`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      }),
    calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
    done: () => rm(dir, { recursive: true, force: true }),
  };
  return { f, why: '' };
}

test('run.sh with the real binary: mcp.mjs and port-nudge.ts go to it, every other file to node', async (t) => {
  const { f, why } = await runShFixture('real');
  if (!f) return t.skip(why);
  try {
    const hookFile = join(f.dir, 'plugin', 'hooks', 'port-nudge.ts');
    // `nudge` with no input prints nothing and never starts node; node here would log a call
    const nudge = await f.run(['--hook', hookFile]);
    assert.deepEqual([nudge.code, nudge.stdout, nudge.stderr], [0, '', '']);
    // `mcp` in local mode runs `node <checkout>/src/mcp.ts`: the fake node logs that path, not bin/mcp.mjs
    const mcp = await f.run([join(f.bin, 'mcp.mjs')], { PORTBOARD_MCP_MODE: 'local', PORTBOARD_HOME: ROOT });
    assert.deepEqual([mcp.code, mcp.stderr], [0, '']);
    for (const hook of ['session-start', 'session-end', 'session-port']) assert.equal((await f.run(['--hook', join(f.dir, 'plugin', 'hooks', `${hook}.ts`)])).code, 0);
    assert.deepEqual(await f.calls(), [
      `NODE ${join(ROOT, 'src', 'mcp.ts')}`,
      `NODE ${join(f.dir, 'plugin', 'hooks', 'session-start.ts')}`,
      `NODE ${join(f.dir, 'plugin', 'hooks', 'session-end.ts')}`,
      `NODE ${join(f.dir, 'plugin', 'hooks', 'session-port.ts')}`,
    ]);
  } finally {
    await f.done();
  }
});

test('run.sh: no binary, PORTBOARD_SHIM=0, a start without a slash, or a binary that is not a working program: node, as before; a hook stays silent with exit 0', async (t) => {
  const variants: [string, ShimKind, Record<string, string>, boolean][] = [
    ['no binary', 'none', {}, false],
    ['PORTBOARD_SHIM=0', 'real', { PORTBOARD_SHIM: '0' }, false],
    ['an empty file with the exec bit', 'empty', {}, false],
    ['a text file that holds "true"', 'text-true', {}, false],
    ['a foreign ELF header', 'foreign-elf', {}, false],
    ['a real binary cut to 1000 bytes', 'truncated', {}, false],
    ['run.sh started as "sh run.sh" (no slash in $0)', 'real', {}, true],
  ];
  for (const [what, kind, env, noSlash] of variants) {
    const { f, why } = await runShFixture(kind);
    if (!f) {
      t.diagnostic(`skipped "${what}": ${why}`);
      continue;
    }
    try {
      const hookFile = join(f.dir, 'plugin', 'hooks', 'port-nudge.ts');
      const opts = noSlash ? { script: 'run.sh', cwd: f.bin } : {};
      const hook = await f.run(['--hook', hookFile], env, opts);
      assert.deepEqual([hook.code, hook.stdout, hook.stderr], [0, '', ''], `${what}: hook`);
      const mcp = await f.run([join(f.bin, 'mcp.mjs')], env, opts);
      assert.deepEqual([mcp.code, mcp.stderr], [0, ''], `${what}: mcp`);
      assert.deepEqual(await f.calls(), [`NODE ${hookFile}`, `NODE ${join(f.bin, 'mcp.mjs')}`], what);
    } finally {
      await f.done();
    }
  }
});

test('run.sh: a bad binary and no node at all: a hook passes silently, the MCP command says node was not found', async () => {
  const { f } = await runShFixture('foreign-elf');
  assert.ok(f);
  try {
    const env = { PATH: '/usr/bin:/bin' };
    const hook = await f.run(['--hook', join(f.dir, 'plugin', 'hooks', 'port-nudge.ts')], env);
    assert.deepEqual([hook.code, hook.stdout, hook.stderr], [0, '', '']);
    const mcp = await f.run([join(f.bin, 'mcp.mjs')], env);
    assert.equal(mcp.code, 1);
    assert.equal(mcp.stderr, 'portboard plugin: node not found\n');
  } finally {
    await f.done();
  }
});

test("the binary's version is the plugin's version", () => {
  const main = readFileSync(join(ROOT, 'shim', 'main.go'), 'utf8');
  const v = /^const version = "([^"]+)"$/m.exec(main)?.[1];
  assert.equal(v, JSON.parse(readFileSync(join(ROOT, 'claude-plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version);
});
