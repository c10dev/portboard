// start/list/output/stop of coding agent runs (src/core/coding-agents.ts, src/features/coding-agents.ts).
//
// Levels: the codex event stream in test/fixtures/codex-exec-events.jsonl is a capture (captured 2026-11-23 from
// codex-cli 0.159.3 `codex exec --json -s read-only`, thread id replaced); the other codex events (command_execution,
// file_change, turn.failed) are inline and not captured. Gemini is a FAKE: the CLI is not installed here and its
// stream-json field names are parsed from its docs. systemd is a fake ServiceManager; the process-mode tests run the
// real runner against a PATH shim named codex. No real codex, gemini or systemd runs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { L } from './fixtures/locale.ts';

// environment before the modules read it
const root = mkdtempSync(join(tmpdir(), 'pb-ca-'));
const home = join(root, 'home');
const stateDir = join(root, 'state');
const repos = join(root, 'repos');
const shimDir = join(root, 'shim');
for (const d of [home, stateDir, repos, shimDir]) mkdirSync(d);
for (const k of Object.keys(process.env)) if (k.startsWith('PORTBOARD_') && k !== 'PORTBOARD_LOCALE') delete process.env[k];
process.env.HOME = home;
process.env.PORTBOARD_STATE_DIR = stateDir;
process.env.PORTBOARD_REPOS_ROOT = repos;
const ORIG_PATH = process.env.PATH ?? '/usr/bin:/bin';
const SYS_PATH = `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;

const ca = await import('../src/core/coding-agents.ts');
const { setServiceManager, noServiceManager } = await import('../src/core/platform/services.ts');
const { TOOLS, callTool } = await import('../src/mcp/tools.ts');

const gitEnv = { HOME: home, PATH: SYS_PATH, GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv, stdio: 'pipe' });

const mainRepo = join(repos, 'shop');
const linked = join(root, 'wt', 'shop-feat');
mkdirSync(mainRepo, { recursive: true });
git(mainRepo, 'init');
git(mainRepo, 'commit', '--allow-empty', '-m', 'init');
git(mainRepo, 'worktree', 'add', '-b', 'feat', linked);
const linked2 = join(root, 'wt', 'shop-feat2');
git(mainRepo, 'worktree', 'add', '-b', 'feat2', linked2);

const RUNNER = fileURLToPath(new URL('../src/core/coding-agent-runner.ts', import.meta.url));
const FIXTURE = readFileSync(new URL('./fixtures/codex-exec-events.jsonl', import.meta.url), 'utf8');

// A codex stand-in: records stdin and argv next to itself, prints events, writes the -o file. Its behaviour is the
// text of <shim dir>/mode: ok | fail | sleep.
const SHIM = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = __dirname;
const argv = process.argv.slice(2);
fs.writeFileSync(path.join(dir, 'argv.json'), JSON.stringify(argv));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(dir, 'stdin.txt'), input);
  const mode = fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim();
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'x' }));
  if (mode === 'sleep') { setInterval(() => {}, 1000); return; }
  const text = 'shim answer';
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } }));
  if (mode === 'fail') { console.error('shim exploded'); process.exit(3); }
  fs.writeFileSync(argv[argv.indexOf('-o') + 1], text);
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }));
});
`;
writeFileSync(join(shimDir, 'codex'), SHIM);
chmodSync(join(shimDir, 'codex'), 0o755);
const setMode = (m: string) => writeFileSync(join(shimDir, 'mode'), m);

const runsRoot = join(stateDir, 'coding-agents');
before(() => {
  process.env.PATH = `${shimDir}:${ORIG_PATH}`;
  setServiceManager(noServiceManager());
});
after(() => {
  process.env.PATH = ORIG_PATH;
  setServiceManager(null);
  rmSync(root, { recursive: true, force: true });
});

/** Wait for a file with a deadline (polled, no fixed sleep before the check). */
async function waitFor(path: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const exitFile = (id: string) => join(runsRoot, id, 'exit.json');

// ---- 1. codex argv ----

test('codex args are exactly the documented argv, for both sandboxes, with and without a model; the prompt is not in argv', () => {
  const a = ca.codexAdapter;
  assert.deepEqual(a.args({ cwd: '/w/x', sandbox: 'read-only', lastMessageFile: '/r/last.md' }), ['exec', '--json', '--color', 'never', '-s', 'read-only', '-C', '/w/x', '-o', '/r/last.md', '-']);
  assert.deepEqual(a.args({ cwd: '/w/x', sandbox: 'workspace-write', model: 'gpt-x', lastMessageFile: '/r/last.md' }), ['exec', '--json', '--color', 'never', '-s', 'workspace-write', '-C', '/w/x', '-o', '/r/last.md', '-m', 'gpt-x', '-']);
  for (const arg of a.args({ cwd: '/w/x', sandbox: 'read-only', lastMessageFile: '/r/last.md' })) assert.doesNotMatch(arg, /bypass|yolo|approve/);
});

// ---- 2. codex parser ----

test('codex parser on the captured stream: counts, final text, usage, the config warning as last error', () => {
  const s = ca.emptySummary();
  for (const line of FIXTURE.split('\n')) ca.codexAdapter.parse(line, s);
  assert.equal(s.events, 5);
  assert.equal(s.unknownEvents, 0);
  assert.equal(s.finalText, 'PONG');
  assert.deepEqual(s.turns, { completed: 1, failed: 0 });
  assert.equal(s.usage?.input_tokens, 15468);
  assert.equal(s.usage?.output_tokens, 6);
  assert.match(s.lastError ?? '', /ignoring 3 unrecognized/);
});

test('codex parser: command_execution, file_change, turn.failed, error and unknown events (inline, not captured)', () => {
  const s = ca.emptySummary();
  const lines = [
    '{"type":"item.started","item":{"id":"a","type":"command_execution","command":"ls","status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"a","type":"command_execution","command":"ls -la","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"b","type":"file_change","changes":[{"path":"a.ts","kind":"update"},{"path":"b.ts","kind":"add"},{"path":"a.ts","kind":"update"}]}}',
    '{"type":"turn.failed","error":{"message":"boom"}}',
    '{"type":"error","message":"stream error"}',
    '{"type":"mystery"}',
    '{"type":"item.completed","item":{"id":"c","type":"hologram"}}',
    'not json',
    '{"half":',
  ];
  for (const l of lines) ca.codexAdapter.parse(l, s);
  assert.equal(s.events, 7);
  assert.equal(s.unknownEvents, 2);
  assert.equal(s.commands, 1);
  assert.deepEqual(s.filesChanged, ['a.ts', 'b.ts']);
  assert.deepEqual(s.turns, { completed: 0, failed: 1 });
  assert.equal(s.lastError, 'stream error');
  assert.deepEqual(ca.eventLines('codex', lines[1]), ['cmd: ls -la (exit 0)']);
  assert.deepEqual(ca.eventLines('codex', lines[2]), ['file: update a.ts', 'file: add b.ts', 'file: update a.ts']);
  assert.deepEqual(ca.eventLines('codex', lines[3]), ['error: boom']);
  assert.deepEqual(ca.eventLines('codex', lines[0]), []);
});

test('codex parser caps the changed files at 50 and the error at 500 characters', () => {
  const s = ca.emptySummary();
  const changes = Array.from({ length: 60 }, (_, i) => ({ path: `f${i}`, kind: 'add' }));
  ca.codexAdapter.parse(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes } }), s);
  ca.codexAdapter.parse(JSON.stringify({ type: 'error', message: 'x'.repeat(900) }), s);
  assert.equal(s.filesChanged.length, 50);
  assert.equal(s.filesChangedTruncated, true);
  assert.equal(s.lastError?.length, 500);
});

// ---- 3. gemini (fake stream) ----

test('gemini args (fake CLI, from its docs): approval mode follows the sandbox, prompt on stdin, no yolo', () => {
  const g = ca.geminiAdapter;
  assert.deepEqual(g.args({ cwd: '/w', sandbox: 'read-only', lastMessageFile: '/l' }), ['--output-format', 'stream-json', '--approval-mode', 'default']);
  assert.deepEqual(g.args({ cwd: '/w', sandbox: 'workspace-write', model: 'gem-1', lastMessageFile: '/l' }), ['--output-format', 'stream-json', '--approval-mode', 'auto_edit', '-m', 'gem-1']);
});

test('gemini parser on a synthetic stream (fake): deltas append, tool_use counts, result sets final text and usage', () => {
  const s = ca.emptySummary();
  const lines = [
    '{"type":"init","session_id":"s"}',
    '{"type":"message","role":"user","content":"hi"}',
    '{"type":"message","role":"assistant","content":"Hel","delta":true}',
    '{"type":"message","role":"assistant","content":"lo","delta":true}',
    '{"type":"tool_use","tool_name":"read_file"}',
    '{"type":"tool_result","status":"success"}',
    '{"type":"error","message":"warn"}',
    '{"type":"result","status":"success","stats":{"total_tokens":10,"models":{"m":{"tokens":4}}}}',
    '{"type":"surprise"}',
  ];
  for (const l of lines) ca.geminiAdapter.parse(l, s);
  assert.equal(s.finalText, 'Hello');
  assert.equal(s.commands, 1);
  assert.equal(s.lastError, 'warn');
  assert.equal(s.unknownEvents, 1);
  assert.deepEqual(s.turns, { completed: 1, failed: 0 });
  assert.equal(s.usage?.total_tokens, 10);
  assert.equal(s.usage?.['models.m.tokens'], 4);
  ca.geminiAdapter.parse('{"type":"result","response":"Final."}', s);
  assert.equal(s.finalText, 'Final.');
  assert.deepEqual(ca.eventLines('gemini', lines[4]), ['tool: read_file']);
  assert.deepEqual(ca.eventLines('gemini', lines[2]), []);
  ca.geminiAdapter.parse('{"type":"message","role":"assistant","content":"whole"}', s);
  assert.equal(s.finalText, 'whole');
});

// ---- 4. validation ----

test('start validation: every bad argument is a 400 and nothing is written', async () => {
  const ok = { kind: 'codex', path: linked, prompt: 'hi' } as const;
  const cases: [string, Record<string, unknown>][] = [
    ['bad kind', { ...ok, kind: 'rm' }],
    ['empty prompt', { ...ok, prompt: '   ' }],
    ['oversized prompt', { ...ok, prompt: 'x'.repeat(100_001) }],
    ['bad sandbox', { ...ok, sandbox: 'danger-full-access' }],
    ['bad model', { ...ok, model: 'a b; rm' }],
    ['timeout 0', { ...ok, timeoutMinutes: 0 }],
    ['timeout 241', { ...ok, timeoutMinutes: 241 }],
    ['timeout fraction', { ...ok, timeoutMinutes: 1.5 }],
    ['no path', { ...ok, path: undefined }],
  ];
  for (const [name, req] of cases) {
    const r = await ca.startCodingAgent(req as never, {});
    assert.equal(r.status, 400, name);
    assert.equal(r.ok, false, name);
  }
  const unknown = await ca.startCodingAgent({ ...ok, path: '/home/dev/projects/nowhere' }, {});
  assert.equal(unknown.status, 400);
  assert.equal(unknown.message, L('Portboard가 아는 워크트리가 아니에요', 'Not a worktree Portboard knows'));
  const main = await ca.startCodingAgent({ ...ok, path: mainRepo, sandbox: 'workspace-write' }, {});
  assert.equal(main.status, 400);
  assert.match(main.message, /workspace-write/);
  assert.equal(existsSync(runsRoot), false, 'no run folder for a refused start');
});

test('run ids: only ca-<10 hex> becomes a path', async () => {
  assert.match(ca.newId(), ca.ID_RE);
  for (const bad of ['../x', 'ca-../../etc', 'ca-ABCDEF0123', 'ca-0123456789a', '']) assert.equal(ca.ID_RE.test(bad), false, bad);
  assert.equal((await ca.stopCodingAgent('../x')).status, 400);
  assert.equal((await ca.codingAgentOutput('../x')).status, 400);
  assert.equal((await ca.codingAgentOutput('ca-0123456789')).status, 404);
  assert.equal((await ca.stopCodingAgent('ca-0123456789')).status, 404);
  assert.deepEqual(await ca.listCodingAgents({ id: '../x' }), { runs: [] });
});

// ---- 5. systemd launch (fake ServiceManager) ----

test('systemd: the transient unit args carry the unit, RuntimeMaxSec and the session, never the prompt; a second start is busy; stop stops the unit', async () => {
  const calls: { started: string[][]; stopped: [string, boolean | undefined][] } = { started: [], stopped: [] };
  let active = true;
  setServiceManager({
    ...noServiceManager(),
    name: 'systemd',
    unavailable: null,
    startTransient: async (args) => (calls.started.push(args), { ok: true, stdout: '', stderr: '' }),
    show: async () => ({ ok: true, stdout: `ActiveState=${active ? 'active' : 'inactive'}\n`, stderr: '' }),
    stop: async (unit, wait) => (calls.stopped.push([unit, wait]), { ok: true, stdout: '', stderr: '' }),
  });
  try {
    const secret = 'PROMPT-SECRET-TEXT';
    const r = await ca.startCodingAgent({ kind: 'codex', path: linked, prompt: secret, timeoutMinutes: 5 }, { CLAUDE_CODE_SESSION_ID: 'abcdef12-3456-7890', CLAUDE_PID: '123' });
    assert.equal(r.ok, true, r.message);
    assert.match(r.id!, ca.ID_RE);
    assert.equal(r.unit, `pb-agent-${r.id}.service`);
    const args = calls.started[0];
    assert.ok(args.includes(`--unit=pb-agent-${r.id}`));
    assert.ok(args.includes('--collect'));
    assert.ok(args.includes('--property=RuntimeMaxSec=360'));
    assert.ok(args.includes(`--property=WorkingDirectory=${linked}`));
    assert.ok(args.includes('--setenv=CLAUDE_CODE_SESSION_ID=abcdef12-3456-7890'));
    assert.ok(args.some((a) => a.startsWith('--setenv=PATH=')));
    assert.equal(args.some((a) => a.includes(secret)), false, 'the prompt is not in the unit args');
    assert.equal(args[args.indexOf('--') + 1], process.execPath);
    assert.equal(readFileSync(join(runsRoot, r.id!, 'prompt.txt'), 'utf8'), secret);
    assert.equal(statSync(join(runsRoot, r.id!, 'prompt.txt')).mode & 0o777, 0o600);
    assert.equal(statSync(join(runsRoot, r.id!)).mode & 0o777, 0o700);
    const meta = JSON.parse(readFileSync(join(runsRoot, r.id!, 'meta.json'), 'utf8'));
    assert.equal(meta.session, 'abcdef12-3456-7890');
    assert.equal(meta.promptChars, secret.length);
    assert.equal(JSON.stringify(meta).includes(secret), false);

    const again = await ca.startCodingAgent({ kind: 'codex', path: linked, prompt: 'other' }, {});
    assert.equal(again.status, 409);
    assert.ok(again.message.includes(r.id!));
    const other = await ca.startCodingAgent({ kind: 'codex', path: linked2, prompt: 'other worktree' }, {});
    assert.equal(other.ok, true, 'another worktree is free');
    assert.equal(((await ca.listCodingAgents()).runs.filter((x) => x.state === 'running')).length, 2);

    const stop = await ca.stopCodingAgent(r.id!);
    assert.equal(stop.ok, true);
    assert.deepEqual(calls.stopped, [[`pb-agent-${r.id}.service`, true]]);
    assert.ok(JSON.parse(readFileSync(join(runsRoot, r.id!, 'meta.json'), 'utf8')).stopRequestedAt);
    writeFileSync(exitFile(r.id!), JSON.stringify({ code: null, signal: 'SIGTERM', endedAt: new Date().toISOString() }));
    active = false;
    assert.equal((await ca.listCodingAgents({ id: r.id })).runs[0].state, 'stopped');
    assert.equal((await ca.stopCodingAgent(r.id!)).status, 409);
    // the other run's unit went inactive without an exit.json: the runner died
    assert.equal((await ca.listCodingAgents({ id: other.id })).runs[0].state, 'lost');
    writeFileSync(exitFile(other.id!), JSON.stringify({ code: null, signal: null, endedAt: new Date().toISOString() }));
  } finally {
    setServiceManager(noServiceManager());
  }
});

test('systemd: a failing systemctl keeps the state running and says it is unknown; a failed systemd-run is a 500 with no running run', async () => {
  setServiceManager({ ...noServiceManager(), name: 'systemd', unavailable: null, startTransient: async () => ({ ok: false, stdout: '', stderr: 'Failed to connect to bus' }), show: async () => ({ ok: false, stdout: '', stderr: 'no bus' }) });
  try {
    const f = await ca.startCodingAgent({ kind: 'codex', path: linked2, prompt: 'x' }, {});
    assert.equal(f.status, 500);
    assert.match(f.message, /Failed to connect to bus/);
    const run = (await ca.listCodingAgents({ id: f.id })).runs[0];
    assert.equal(run.state, 'failed');
    assert.equal(JSON.parse(readFileSync(exitFile(f.id!), 'utf8')).launchFailed, true);
    // a run with no exit.json under a systemctl that cannot answer
    const id = ca.newId();
    const dir = join(runsRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(runsRoot, f.id!, 'meta.json'), 'utf8')), id, unit: `pb-agent-${id}.service` }));
    const u = (await ca.listCodingAgents({ id })).runs[0];
    assert.equal(u.state, 'running');
    assert.equal(u.stateUnknown, true);
  } finally {
    setServiceManager(noServiceManager());
  }
});

// ---- 6. runner end to end, process mode, PATH shim ----

test('process mode: the runner runs the shim, the prompt arrives on stdin, the final text is last.md', async () => {
  setMode('ok');
  const r = await ca.startCodingAgent({ kind: 'codex', path: linked, prompt: 'say hi\nsecond line', model: 'm-1' }, {});
  assert.equal(r.ok, true, r.message);
  assert.equal(r.unit, null);
  assert.ok(typeof r.pid === 'number' && r.pid > 1);
  await waitFor(exitFile(r.id!));
  const out = await ca.codingAgentOutput(r.id!);
  assert.equal(out.state, 'succeeded');
  assert.equal(out.final, 'shim answer');
  assert.equal(out.summary.finalText, 'shim answer');
  assert.equal(out.summary.exitCode, 0);
  assert.equal(out.stderrTail, null);
  assert.deepEqual(out.lines.map((l) => l.text), ['msg: shim answer']);
  assert.equal(readFileSync(join(shimDir, 'stdin.txt'), 'utf8'), 'say hi\nsecond line');
  const argv: string[] = JSON.parse(readFileSync(join(shimDir, 'argv.json'), 'utf8'));
  assert.deepEqual(argv.slice(0, 7), ['exec', '--json', '--color', 'never', '-s', 'read-only', '-C']);
  assert.equal(argv[7], linked);
  assert.ok(argv.includes('-m') && argv.includes('m-1'));
  assert.equal(argv.some((a) => a.includes('say hi')), false);
  assert.equal(statSync(join(runsRoot, r.id!, 'events.jsonl')).mode & 0o777, 0o600);
});

test('process mode: a CLI that exits 3 is failed, with the stderr tail', async () => {
  setMode('fail');
  const r = await ca.startCodingAgent({ kind: 'codex', path: linked, prompt: 'x' }, {});
  assert.equal(r.ok, true, r.message);
  await waitFor(exitFile(r.id!));
  const out = await ca.codingAgentOutput(r.id!);
  assert.equal(out.state, 'failed');
  assert.equal(out.summary.exitCode, 3);
  assert.match(out.stderrTail ?? '', /shim exploded/);
});

test('process mode: a missing binary is a 400 before any run exists', async () => {
  const saved = process.env.PATH;
  // only git (knownDirs runs it) is on this PATH
  const gitOnly = join(root, 'git-only');
  mkdirSync(gitOnly, { recursive: true });
  symlinkSync(execFileSync('which', ['git'], { env: { PATH: SYS_PATH } }).toString().trim(), join(gitOnly, 'git'));
  process.env.PATH = gitOnly;
  try {
    const before = (await ca.listCodingAgents()).runs.length;
    const r = await ca.startCodingAgent({ kind: 'gemini', path: linked, prompt: 'x' }, {});
    assert.equal(r.status, 400);
    assert.equal(r.message, L('이 호스트에 gemini가 없어요 (PATH에서 찾지 못했어요)', "gemini isn't installed on this host (not found on PATH)"));
    assert.equal((await ca.listCodingAgents()).runs.length, before);
  } finally {
    process.env.PATH = saved;
  }
});

/** Run the runner by hand on a prepared folder, with the test-only timeout, and wait for exit.json. */
async function runnerOn(id: string, env: Record<string, string>): Promise<void> {
  const child = spawn(process.execPath, [RUNNER, join(runsRoot, id)], { env: { HOME: home, PATH: `${shimDir}:${SYS_PATH}`, ...env }, stdio: 'ignore' });
  await waitFor(exitFile(id));
  await new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', () => resolve())));
}

function prepare(cwd: string): string {
  const id = ca.newId();
  const dir = join(runsRoot, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const meta: import('../src/core/coding-agents.ts').RunMeta = { id, kind: 'codex', cwd, owner: 'shop@feat', sandbox: 'read-only', model: null, promptChars: 1, startedAt: new Date().toISOString(), timeoutMinutes: 30, launcher: 'process', unit: null, pid: null, stopRequestedAt: null, session: null };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  writeFileSync(join(dir, 'prompt.txt'), 'x');
  return id;
}

test('runner: the timeout stops a sleeping CLI and the run is timed-out (test-only PORTBOARD_CODING_AGENT_TIMEOUT_MS)', async () => {
  setMode('sleep');
  const id = prepare(linked);
  await runnerOn(id, { PORTBOARD_CODING_AGENT_TIMEOUT_MS: '400' });
  const exit = JSON.parse(readFileSync(exitFile(id), 'utf8'));
  assert.equal(exit.timedOut, true);
  assert.equal(exit.signal, 'SIGTERM');
  assert.equal((await ca.listCodingAgents({ id })).runs[0].state, 'timed-out');
});

test('runner: a missing binary at run time is exit code 127 with a stderr line', async () => {
  const id = prepare(linked);
  const child = spawn(process.execPath, [RUNNER, join(runsRoot, id)], { env: { HOME: home, PATH: '/nonexistent-dir' }, stdio: 'ignore' });
  await waitFor(exitFile(id));
  await new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', () => resolve())));
  assert.equal(JSON.parse(readFileSync(exitFile(id), 'utf8')).code, 127);
  assert.match(readFileSync(join(runsRoot, id, 'stderr.log'), 'utf8'), /not found on PATH/);
  const out = await ca.codingAgentOutput(id);
  assert.equal(out.state, 'failed');
  assert.match(out.stderrTail ?? '', /not found on PATH/);
});

test('process mode: stop sends SIGTERM to the runner, which stops the CLI; the run is stopped', async () => {
  setMode('sleep');
  const r = await ca.startCodingAgent({ kind: 'codex', path: linked, prompt: 'x' }, {});
  assert.equal(r.ok, true, r.message);
  // wait until the CLI is up (it writes its first event) so the stop goes through the runner's signal path
  await waitFor(join(runsRoot, r.id!, 'events.jsonl'));
  const busy = await ca.startCodingAgent({ kind: 'codex', path: linked, prompt: 'again' }, {});
  assert.equal(busy.status, 409);
  const stop = await ca.stopCodingAgent(r.id!);
  assert.equal(stop.ok, true, stop.message);
  await waitFor(exitFile(r.id!));
  assert.equal((await ca.listCodingAgents({ id: r.id })).runs[0].state, 'stopped');
  assert.equal((await ca.stopCodingAgent(r.id!)).status, 409);
});

// ---- 7. list and paging ----

test('list is newest first without prompt or final text; output pages with after, limit, next and truncated', async () => {
  const id = prepare(linked2);
  const dir = join(runsRoot, id);
  const events = [
    { type: 'thread.started', thread_id: 't' },
    ...Array.from({ length: 5 }, (_, i) => ({ type: 'item.completed', item: { id: `c${i}`, type: 'command_execution', command: `cmd ${i}`, exit_code: 0, status: 'completed' } })),
    { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'done' } },
  ];
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\npartial line {"type"');
  writeFileSync(join(dir, 'last.md'), 'done');
  writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: 0, signal: null, endedAt: new Date().toISOString() }));

  const list = await ca.listCodingAgents();
  assert.equal(list.runs[0].id, id, 'the newest run is first');
  const mine = list.runs.find((x) => x.id === id)!;
  assert.equal(mine.state, 'succeeded');
  assert.equal(mine.commands, 5);
  assert.equal('finalText' in mine, false);
  assert.equal(JSON.stringify(list).includes('prompt.txt'), false);
  assert.equal((mine as unknown as Record<string, unknown>).prompt, undefined);

  const p1 = await ca.codingAgentOutput(id, { limit: 2 });
  assert.deepEqual(p1.lines, [{ i: 1, text: 'cmd: cmd 0 (exit 0)' }, { i: 2, text: 'cmd: cmd 1 (exit 0)' }]);
  assert.equal(p1.truncated, true);
  assert.equal(p1.next, 3);
  const p2 = await ca.codingAgentOutput(id, { after: p1.next, limit: 10 });
  assert.deepEqual(p2.lines.map((l) => l.text), ['cmd: cmd 2 (exit 0)', 'cmd: cmd 3 (exit 0)', 'cmd: cmd 4 (exit 0)', 'msg: done']);
  assert.equal(p2.truncated, false);
  assert.equal(p2.next, 7);
  assert.equal(p2.final, 'done');
  assert.equal(p2.state, 'succeeded');
  const p3 = await ca.codingAgentOutput(id, { after: p2.next });
  assert.deepEqual(p3.lines, []);
  assert.equal(p3.next, 7);
  assert.equal((await ca.codingAgentOutput(id, { limit: 1000 })).lines.length, 6, 'limit is capped at 200, not an error');
});

// ---- MCP tools ----

test('the four tools: schemas, annotations, argument checks, and the prompt stays out of the audit target', async () => {
  const by = (n: string) => TOOLS.find((t) => t.name === n)!;
  assert.deepEqual(by('start_coding_agent').annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.equal(by('list_coding_agents').annotations.readOnlyHint, true);
  assert.equal(by('coding_agent_output').annotations.readOnlyHint, true);
  assert.deepEqual(by('stop_coding_agent').annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  assert.match(by('stop_coding_agent').description, /confirm with the user/i);
  assert.deepEqual(by('start_coding_agent').inputSchema.required, ['kind', 'path', 'prompt']);

  const seen: unknown[] = [];
  const core = { startCodingAgent: async (r: unknown) => (seen.push(r), { ok: true, status: 200, message: 'm', id: 'ca-0123456789' }) } as never;
  const good = await callTool('start_coding_agent', { kind: 'codex', path: linked, prompt: 'SECRET-PROMPT', timeout_minutes: 7, sandbox: 'read-only' }, core);
  assert.equal(good.isError, undefined);
  assert.deepEqual(seen[0], { kind: 'codex', path: linked, prompt: 'SECRET-PROMPT', sandbox: 'read-only', model: undefined, timeoutMinutes: 7 });
  for (const bad of [{ kind: 'x', path: '/p', prompt: 'p' }, { kind: 'codex', prompt: 'p' }, { kind: 'codex', path: '/p' }, { kind: 'codex', path: '/p', prompt: 'p', timeout_minutes: 0 }]) {
    const r = await callTool('start_coding_agent', bad, core);
    assert.equal(r.isError, true, JSON.stringify(bad));
  }
  assert.equal((await callTool('coding_agent_output', { id: 'ca-0123456789', limit: 0 }, {} as never)).isError, true);
  assert.equal((await callTool('stop_coding_agent', {}, {} as never)).isError, true);
  const { targetOf } = await import('../src/core/audit.ts');
  const target = targetOf(null, { kind: 'codex', path: linked, prompt: 'SECRET-PROMPT' });
  assert.equal(JSON.stringify(target).includes('SECRET-PROMPT'), false);
  assert.deepEqual(target.fields, ['kind', 'prompt']);
});
