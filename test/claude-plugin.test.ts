// The Claude Code plugin package (c10dev/portboard#41) and its port-nudge hook (#42): the manifests point at files
// that exist, the hook adds context only (never a permission decision), stays silent on everything else, and gives up
// within its timeout when Portboard is slow or down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disabled, hookOutput, nudge, TIMEOUT_MS } from '../claude-plugin/hooks/port-nudge.ts';
import { portboardHome } from '../claude-plugin/hooks/home.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const PLUGIN = join(ROOT, 'claude-plugin');
const json = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

test('marketplace → plugin → hooks, MCP server and skill all resolve inside claude-plugin/', () => {
  const m = json('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'portboard');
  assert.deepEqual(m.plugins.map((p: { name: string; source: string }) => [p.name, p.source]), [['portboard', './claude-plugin']]);
  const plugin = json('claude-plugin/.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'portboard');
  assert.equal(plugin.version, m.plugins[0].version);

  const hooks = json('claude-plugin/hooks/hooks.json').hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['CwdChanged', 'PreToolUse', 'SessionEnd', 'SessionStart']);
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash');
  const files = (s: string) => [...s.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g)].map((m) => m[1]);
  for (const ev of Object.values(hooks) as { hooks: { command: string }[] }[][]) {
    for (const h of ev[0].hooks) {
      // through the node locator, which passes silently when node is missing
      assert.match(h.command, /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/run\.sh" --hook "/, h.command);
      assert.equal(files(h.command).length, 2, h.command);
      for (const f of files(h.command)) assert.ok(existsSync(join(PLUGIN, f)), f);
    }
  }
  const mcp = json('claude-plugin/.mcp.json').mcpServers;
  assert.deepEqual(Object.keys(mcp), ['portboard']);
  assert.equal(mcp.portboard.command, 'sh');
  assert.deepEqual(mcp.portboard.args.flatMap(files), ['bin/run.sh', 'bin/mcp.ts']);
  for (const f of mcp.portboard.args.flatMap(files)) assert.ok(existsSync(join(PLUGIN, f)), f);
  const skill = readFileSync(join(PLUGIN, 'skills/dev-servers-and-ports/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: dev-servers-and-ports\ndescription: .+\n---\n/);
  for (const t of ['list_ports', 'free_port', 'reserve_port', 'start_dev_server', 'list_cleanup_candidates', 'cleanup_servers', 'stop_dev_server']) assert.ok(skill.includes(t), t);
  const where = readFileSync(join(PLUGIN, 'skills/where-to-run/SKILL.md'), 'utf8');
  assert.match(where, /^---\nname: where-to-run\ndescription: .+\n---\n/);
  for (const t of ['machine_status', 'find_worktree', 'where_to_run']) assert.ok(where.includes(t), t);
  // the slash commands: frontmatter with a description, and the one tool each runs
  for (const [cmd, tool] of [['where', 'where_to_run'], ['machines', 'machine_status'], ['wt', 'find_worktree']]) {
    const md = readFileSync(join(PLUGIN, `commands/${cmd}.md`), 'utf8');
    assert.match(md, /^---\ndescription: .+\n(argument-hint: .+\n)?---\n/, cmd);
    assert.ok(md.includes(`\`${tool}\``), cmd);
  }
  // every option the hooks read is declared, and the cross-machine hint is opt-in
  assert.deepEqual(Object.keys(plugin.userConfig).sort(), ['multi_machine_hint', 'port_nudge', 'session_port']);
  assert.equal(plugin.userConfig.multi_machine_hint.default, false);
  assert.ok(hooks.SessionStart[0].hooks.some((h: { command: string }) => h.command.includes('hooks/session-start.ts')));
});

test("session-end.ts keeps #43's agreed export", async () => {
  const m = await import('../claude-plugin/hooks/session-end.ts');
  assert.equal(typeof m.onSessionEnd, 'function');
  assert.equal(await m.onSessionEnd({ session_id: 'x', cwd: '/tmp' }, { url: 'http://127.0.0.1:9', timeoutMs: 50 } as never), undefined);
});

test('portboardHome: PORTBOARD_HOME, else a parent of the plugin, else ~/projects/portboard', () => {
  assert.equal(portboardHome({}, join(PLUGIN, 'hooks')), ROOT);
  assert.equal(portboardHome({ PORTBOARD_HOME: ROOT }, '/'), ROOT);
  assert.equal(portboardHome({ PORTBOARD_HOME: '/nonexistent' }, join(PLUGIN, 'hooks')), null);
});

test('off switches: the plugin option and PORTBOARD_NUDGE=0', () => {
  assert.equal(disabled({}), false);
  assert.equal(disabled({ CLAUDE_PLUGIN_OPTION_PORT_NUDGE: 'true' }), false);
  assert.equal(disabled({ CLAUDE_PLUGIN_OPTION_PORT_NUDGE: 'false' }), true);
  assert.equal(disabled({ PORTBOARD_NUDGE: '0' }), true);
});

test('hook output is additionalContext only: no permissionDecision, so the permission flow is untouched', () => {
  const out = JSON.parse(hookOutput('[portboard] x'));
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '[portboard] x' } });
});

// ---- against a fake Portboard ----

async function fakePortboard(handler: (url: URL) => { status?: number; body?: unknown; delayMs?: number }): Promise<{ url: string; seen: URL[]; server: Server }> {
  const seen: URL[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    // the live Portboard's title probe (GET /) reaches every new loopback listener: not a request from the hook
    if (!url.pathname.startsWith('/api/')) return void res.writeHead(404).end();
    seen.push(url);
    const r = handler(url);
    setTimeout(() => {
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body ?? {}));
    }, r.delayMs ?? 0);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

const bash = (command: string, extra: object = {}) => ({ session_id: 'abc-123', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });

test('nudge: one GET with port, cmd, tool, cwd and session; returns the server text', async () => {
  const fake = await fakePortboard(() => ({ body: { text: '[portboard] 포트 5173 …' } }));
  try {
    const env = { PORTBOARD_URL: fake.url };
    assert.equal(await nudge(bash('npm run dev -- --port 5173'), { env, home: ROOT }), '[portboard] 포트 5173 …');
    assert.equal(fake.seen.length, 1);
    const u = fake.seen[0];
    assert.equal(u.pathname, '/api/claude/port-advice');
    assert.deepEqual(Object.fromEntries(u.searchParams), { port: '5173', cmd: 'start', tool: 'npm run dev', cwd: ROOT, session: 'abc-123' });

    assert.equal(await nudge(bash('fuser -k 3000/tcp'), { env, home: ROOT }), '[portboard] 포트 5173 …');
    assert.equal(fake.seen[1].searchParams.get('cmd'), 'kill');
  } finally {
    fake.server.close();
  }
});

test('nudge: silent (and no request) for other tools, ordinary commands, look-alikes, and when off', async () => {
  const fake = await fakePortboard(() => ({ body: { text: '[portboard] x' } }));
  try {
    const env = { PORTBOARD_URL: fake.url };
    for (const input of [
      bash('ls -la'),
      bash('git status'),
      bash('ssh -p 22 host'),
      bash('docker run -p 8080:80 nginx'),
      bash('npm run dev'),
      bash('git commit -m "vite --port 5173"'),
      { ...bash('vite --port 5173'), tool_name: 'Read' },
      { ...bash(''), tool_input: { command: 42 } },
      {} as never,
    ]) {
      assert.equal(await nudge(input, { env, home: ROOT }), null, JSON.stringify(input));
    }
    assert.equal(await nudge(bash('vite --port 5173'), { env: { ...env, PORTBOARD_NUDGE: '0' }, home: ROOT }), null);
    assert.equal(await nudge(bash('vite --port 5173'), { env, home: null }), null, 'no checkout: nothing to parse with');
    assert.equal(fake.seen.length, 0);
  } finally {
    fake.server.close();
  }
});

test('nudge: silent when Portboard is down, errors, answers without the marker, or is slower than 300 ms', async () => {
  assert.equal(TIMEOUT_MS, 300);
  assert.equal(await nudge(bash('vite --port 5173'), { env: { PORTBOARD_URL: 'http://127.0.0.1:9' }, home: ROOT }), null, 'connection refused');
  for (const r of [{ status: 404, body: { error: 'not found' } }, { status: 500 }, { body: { text: 'no marker' } }, { body: [] }]) {
    const fake = await fakePortboard(() => r);
    try {
      assert.equal(await nudge(bash('vite --port 5173'), { env: { PORTBOARD_URL: fake.url }, home: ROOT }), null, JSON.stringify(r));
    } finally {
      fake.server.close();
    }
  }
  const slow = await fakePortboard(() => ({ body: { text: '[portboard] late' }, delayMs: 1_000 }));
  try {
    const t0 = Date.now();
    assert.equal(await nudge(bash('vite --port 5173'), { env: { PORTBOARD_URL: slow.url }, home: ROOT }), null);
    assert.ok(Date.now() - t0 < 800, `gave up after ${Date.now() - t0} ms`);
  } finally {
    slow.server.closeAllConnections();
    slow.server.close();
  }
});

function runHook(input: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', [join(PLUGIN, 'bin/run.sh'), '--hook', join(PLUGIN, 'hooks/port-nudge.ts')], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('as a command hook: PreToolUse JSON on stdin → additionalContext on stdout, exit 0; silent and exit 0 otherwise', async () => {
  const fake = await fakePortboard(() => ({ body: { text: '[portboard] 포트 3000 …' } }));
  try {
    const hit = await runHook(JSON.stringify(bash('kill $(lsof -t -i:3000)')), { PORTBOARD_URL: fake.url });
    assert.equal(hit.code, 0);
    assert.deepEqual(JSON.parse(hit.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '[portboard] 포트 3000 …' } });
    for (const input of [JSON.stringify(bash('ls')), 'not json', '']) {
      const r = await runHook(input, { PORTBOARD_URL: fake.url });
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], input);
    }
    const down = await runHook(JSON.stringify(bash('vite --port 5173')), { PORTBOARD_URL: 'http://127.0.0.1:9' });
    assert.deepEqual([down.code, down.stdout], [0, '']);
  } finally {
    fake.server.close();
  }
});

test('run.sh --hook passes silently when no node can be found; without --hook it says so', async () => {
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn('/bin/sh', [join(PLUGIN, 'bin/run.sh'), ...args], { env: { PATH: '/nonexistent', HOME: '/nonexistent' } });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      child.on('close', (code) => resolve({ code, out }));
      // run.sh can exit before reading stdin (no node found): ignore the EPIPE that races with it
      child.stdin.on('error', () => {});
      child.stdin.end('{}');
    });
  assert.deepEqual(await run(['--hook', join(PLUGIN, 'hooks/port-nudge.ts')]), { code: 0, out: '' });
  const mcp = await run([join(PLUGIN, 'bin/mcp.ts')]);
  assert.equal(mcp.code, 1);
  assert.match(mcp.out, /node not found/);
});

// ---- session-port.ts: SessionStart / CwdChanged ----

test('session-port: SessionStart sets PORT in CLAUDE_ENV_FILE and returns the context; CwdChanged only touches the env', async () => {
  const sp = await import('../claude-plugin/hooks/session-port.ts');
  const { mkdtempSync, readFileSync: read, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'pb-envfile-'));
  const envFile = join(dir, 'env.sh');
  let port: number | null = 4100;
  const fake = await fakePortboard(() => ({ body: { owner: 'shop@x', port, text: port ? '[portboard] 4100' : null } }));
  try {
    writeFileSync(envFile, 'export FOO=1');
    const env = { PORTBOARD_URL: fake.url, CLAUDE_ENV_FILE: envFile };
    const out = await sp.run({ hook_event_name: 'SessionStart', cwd: '/w/shop', session_id: 's' }, { env });
    assert.deepEqual(JSON.parse(out!), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[portboard] 4100' } });
    assert.equal(fake.seen[0].pathname, '/api/claude/session-port');
    assert.deepEqual(Object.fromEntries(fake.seen[0].searchParams), { cwd: '/w/shop', env: '1' });
    assert.equal(read(envFile, 'utf8'), `export FOO=1\n${sp.ENV_TAG}\nexport PORT=4100\n`);

    // into a worktree without a reservation: our PORT is unset, once
    port = null;
    assert.equal(await sp.run({ hook_event_name: 'CwdChanged', cwd: '/w/other' }, { env }), null);
    await sp.run({ hook_event_name: 'CwdChanged', cwd: '/w/third' }, { env });
    assert.equal(read(envFile, 'utf8'), `export FOO=1\n${sp.ENV_TAG}\nexport PORT=4100\n${sp.ENV_TAG}\nunset PORT\n`);
  } finally {
    fake.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session-port: never unsets a PORT it did not set, silent when off, down, or for other events', async () => {
  const sp = await import('../claude-plugin/hooks/session-port.ts');
  assert.equal(sp.envLines(null, 'export PORT=3000\n'), null);
  assert.equal(sp.envLines(null, ''), null);
  assert.equal(sp.disabled({ CLAUDE_PLUGIN_OPTION_SESSION_PORT: 'false' }), true);
  assert.equal(sp.disabled({ PORTBOARD_SESSION_PORT: '0' }), true);
  assert.equal(sp.disabled({}), false);
  assert.equal(sp.TIMEOUT_MS, 500);
  assert.equal(await sp.run({ hook_event_name: 'SessionStart', cwd: '/w' }, { env: { PORTBOARD_URL: 'http://127.0.0.1:9' } }), null, 'refused');
  const fake = await fakePortboard(() => ({ body: { port: 4100, text: '[portboard] x' } }));
  try {
    const env = { PORTBOARD_URL: fake.url };
    assert.equal(await sp.run({ hook_event_name: 'PreToolUse', cwd: '/w' }, { env }), null);
    assert.equal(await sp.run({ hook_event_name: 'SessionStart', cwd: 'relative' }, { env }), null);
    assert.equal(await sp.run({ hook_event_name: 'SessionStart', cwd: '/w' }, { env: { ...env, PORTBOARD_SESSION_PORT: '0' } }), null);
    assert.equal(fake.seen.length, 0);
  } finally {
    fake.server.close();
  }
});

test('session-port: machines=1 only with the multi_machine_hint option (or PORTBOARD_MULTI_MACHINE_HINT=1)', async () => {
  const sp = await import('../claude-plugin/hooks/session-port.ts');
  assert.equal(sp.multiMachine({}), false);
  assert.equal(sp.multiMachine({ CLAUDE_PLUGIN_OPTION_MULTI_MACHINE_HINT: 'true' }), true);
  assert.equal(sp.multiMachine({ CLAUDE_PLUGIN_OPTION_MULTI_MACHINE_HINT: 'false' }), false);
  assert.equal(sp.multiMachine({ PORTBOARD_MULTI_MACHINE_HINT: '1' }), true);
  const fake = await fakePortboard(() => ({ body: { owner: 'shop@x', port: null, text: '[portboard] elsewhere' } }));
  try {
    const out = await sp.run({ hook_event_name: 'SessionStart', cwd: '/w/shop' }, { env: { PORTBOARD_URL: fake.url, CLAUDE_PLUGIN_OPTION_MULTI_MACHINE_HINT: 'true' } });
    assert.equal(JSON.parse(out!).hookSpecificOutput.additionalContext, '[portboard] elsewhere');
    assert.deepEqual(Object.fromEntries(fake.seen[0].searchParams), { cwd: '/w/shop', machines: '1' });
    await sp.run({ hook_event_name: 'SessionStart', cwd: '/w/shop' }, { env: { PORTBOARD_URL: fake.url } });
    assert.deepEqual(Object.fromEntries(fake.seen[1].searchParams), { cwd: '/w/shop' });
  } finally {
    fake.server.close();
  }
});
