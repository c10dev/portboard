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
import { chmodSync, existsSync, readdirSync, utimesSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, symlinkSync } from 'node:fs';
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
const linked3 = join(root, 'wt', 'shop-feat3');
git(mainRepo, 'worktree', 'add', '-b', 'feat3', linked3);
const linked4 = join(root, 'wt', 'shop-100%-done');
git(mainRepo, 'worktree', 'add', '-b', 'feat4', linked4);
const linked7 = join(root, 'wt', 'shop-feat7');
git(mainRepo, 'worktree', 'add', '-b', 'feat7', linked7);
const linked8 = join(root, 'wt', 'shop-feat8');
git(mainRepo, 'worktree', 'add', '-b', 'feat8', linked8);
const linked6 = join(root, 'wt', 'shop-feat6');
git(mainRepo, 'worktree', 'add', '-b', 'feat6', linked6);
const linked5 = join(root, 'wt', 'shop-feat5');
git(mainRepo, 'worktree', 'add', '-b', 'feat5', linked5);

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
const readdirSyncSafe = (d: string): string[] => (existsSync(d) ? readdirSync(d) : []);
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
/** Make a run look started two minutes ago (past the 30 s start grace). */
function ageRun(id: string): void {
  const file = join(runsRoot, id, 'meta.json');
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  meta.startedAt = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(file, JSON.stringify(meta));
}

// ---- 1. codex argv ----

test('codex args are exactly the documented argv, for both sandboxes, with and without a model; the prompt is not in argv', () => {
  const a = ca.codexAdapter;
  assert.deepEqual(a.args({ cwd: '/w/x', sandbox: 'read-only', lastMessageFile: '/r/last.md' }), ['exec', '--json', '--color', 'never', '-s', 'read-only', '-C', '/w/x', '-o', '/r/last.md', '-']);
  assert.deepEqual(a.args({ cwd: '/w/x', sandbox: 'workspace-write', model: 'gpt-x', lastMessageFile: '/r/last.md' }), ['exec', '--json', '--color', 'never', '-s', 'workspace-write', '-C', '/w/x', '-o', '/r/last.md', '--model=gpt-x', '-']);
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

test('gemini args (fake CLI, from its docs): approval mode is always default, prompt on stdin, no yolo', () => {
  const g = ca.geminiAdapter;
  assert.deepEqual(g.args({ cwd: '/w', sandbox: 'read-only', lastMessageFile: '/l' }), ['--output-format', 'stream-json', '--approval-mode', 'default']);
  assert.deepEqual(g.args({ cwd: '/w', sandbox: 'workspace-write', model: 'gem-1', lastMessageFile: '/l' }), ['--output-format', 'stream-json', '--approval-mode', 'default', '--model=gem-1'], 'always default: gemini never gets write access');
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
    ['model that is a flag', { ...ok, model: '--yolo' }],
    ['model that is a short flag', { ...ok, model: '-m' }],
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
    assert.ok(args.includes('--property=TimeoutStopSec=15'));
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
    // the other run's unit went inactive without an exit.json: still starting for 30 s, then the runner is lost
    assert.equal((await ca.listCodingAgents({ id: other.id })).runs[0].state, 'running', 'a young run is starting, not lost');
    ageRun(other.id!);
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
  assert.ok(argv.includes('--model=m-1'));
  assert.equal(argv.some((a) => a.includes('say hi')), false);
  assert.equal(statSync(join(runsRoot, r.id!)).mode & 0o777, 0o700);
  for (const f of ['meta.json', 'prompt.txt', 'events.jsonl', 'stderr.log', 'exit.json', 'last.md']) assert.equal(statSync(join(runsRoot, r.id!, f)).mode & 0o777, 0o600, f);
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

// ---- review fixes ----

test('two parallel starts in one worktree: one starts, one is busy (lock and start grace)', async () => {
  setMode('sleep');
  const results = await Promise.all([
    ca.startCodingAgent({ kind: 'codex', path: linked3, prompt: 'a' }, {}),
    ca.startCodingAgent({ kind: 'codex', path: linked3, prompt: 'b' }, {}),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = results.find((r) => r.ok)!;
  assert.equal((await ca.listCodingAgents()).runs.filter((x) => x.cwd === linked3).length, 1, 'only one run folder');
  assert.equal(readdirSyncSafe(join(runsRoot, 'locks')).length, 0, 'the lock is released');
  // a young run with no pid yet still counts as running
  const id = prepare(linked5);
  assert.equal((await ca.listCodingAgents({ id })).runs[0].state, 'running');
  assert.equal((await ca.startCodingAgent({ kind: 'codex', path: linked5, prompt: 'c' }, {})).status, 409);
  ageRun(id);
  assert.equal((await ca.listCodingAgents({ id })).runs[0].state, 'lost');
  await waitFor(join(runsRoot, winner.id!, 'events.jsonl')); // the CLI is up: the stop goes through the runner's handler
  await ca.stopCodingAgent(winner.id!);
  await waitFor(exitFile(winner.id!));
});

test('a stale lock (older than 60 s) is removed; a fresh one blocks the start', async () => {
  const lockDir = join(runsRoot, 'locks');
  const { createHash } = await import('node:crypto');
  const lock = join(lockDir, `${createHash('sha256').update(linked5).digest('hex').slice(0, 16)}.lock`);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(lock, '');
  setMode('ok');
  assert.equal((await ca.startCodingAgent({ kind: 'codex', path: linked5, prompt: 'x' }, {})).status, 409, 'fresh lock');
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  const r = await ca.startCodingAgent({ kind: 'codex', path: linked5, prompt: 'x' }, {});
  assert.equal(r.ok, true, r.message);
  await waitFor(exitFile(r.id!));
});

test('pid reuse: a live unrelated process under a recorded pid is lost, never stopped', async () => {
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore', env: { PATH: SYS_PATH } });
  try {
    await new Promise((r) => bystander.once('spawn', r));
    const id = prepare(linked2);
    const file = join(runsRoot, id, 'meta.json');
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    Object.assign(meta, { pid: bystander.pid, pidStart: 'not-its-start-time', startedAt: new Date(Date.now() - 120_000).toISOString() });
    writeFileSync(file, JSON.stringify(meta));
    assert.equal((await ca.listCodingAgents({ id })).runs[0].state, 'lost');
    const stop = await ca.stopCodingAgent(id);
    assert.equal(stop.status, 409);
    assert.equal(bystander.exitCode, null);
    assert.doesNotThrow(() => process.kill(bystander.pid!, 0), 'the bystander is alive');
    // the real identity matches
    meta.pidStart = await ca.processStart(bystander.pid!);
    assert.ok(meta.pidStart);
    writeFileSync(file, JSON.stringify(meta));
    assert.equal((await ca.listCodingAgents({ id })).runs[0].state, 'running');
    writeFileSync(file, JSON.stringify({ ...meta, pidStart: null }));
    assert.equal((await ca.listCodingAgents({ id })).runs[0].state, 'lost', 'no recorded identity: never ours');
  } finally {
    bystander.kill('SIGKILL');
  }
});

test('process start time: Linux field 22 of /proc/<pid>/stat is read from the last ")"', async () => {
  const mine = await ca.processStart(process.pid);
  assert.match(mine ?? '', /\S/);
  assert.equal(await ca.processStart(process.pid), mine);
  assert.equal(await ca.processStart(0), null);
  assert.equal(await ca.processStart(2 ** 22 + 12345), null);
});

test('the stop request is written before the signal, and "stopped" needs the run to end because of it', async () => {
  const meta = (extra: object = {}) => ({ id: 'ca-0123456789', kind: 'codex', cwd: '/w', owner: 'a@b', sandbox: 'read-only', model: null, promptChars: 1, startedAt: '2026-01-01T00:00:00.000Z', timeoutMinutes: 1, launcher: 'process', unit: null, pid: null, stopRequestedAt: null, session: null, ...extra }) as import('../src/core/coding-agents.ts').RunMeta;
  const t0 = '2026-01-01T00:10:00.000Z';
  const before = '2026-01-01T00:09:00.000Z';
  const after = '2026-01-01T00:10:01.000Z';
  assert.equal(ca.runState(meta({ stopRequestedAt: t0 }), { code: null, signal: 'SIGTERM', endedAt: after }, false), 'stopped');
  assert.equal(ca.runState(meta({ stopRequestedAt: t0 }), { code: 0, signal: null, endedAt: after, stopped: true }, false), 'stopped');
  assert.equal(ca.runState(meta({ stopRequestedAt: t0 }), { code: 0, signal: null, endedAt: after }, false), 'succeeded', 'it finished by itself');
  assert.equal(ca.runState(meta({ stopRequestedAt: t0 }), { code: 2, signal: null, endedAt: before }, false), 'failed', 'ended before the stop');
  assert.equal(ca.runState(meta(), { code: null, signal: 'SIGTERM', endedAt: after }, false), 'failed', 'no stop was requested');
  assert.equal(ca.runState(meta(), { code: null, signal: 'SIGTERM', endedAt: after, timedOut: true }, false), 'timed-out');
  assert.equal(ca.runState(meta({ stopRequestedAt: t0 }), { code: null, signal: 'SIGTERM', endedAt: after, timedOut: true }, false), 'timed-out', 'it timed out after a stop that failed');
  // a stop that fails keeps stopRequestedAt: the state then follows the runner's exit evidence
  setServiceManager({ ...noServiceManager(), name: 'systemd', unavailable: null, startTransient: async () => ({ ok: true, stdout: '', stderr: '' }), show: async () => ({ ok: true, stdout: 'ActiveState=active\n', stderr: '' }), stop: async () => ({ ok: false, stdout: '', stderr: 'denied' }) });
  try {
    const r = await ca.startCodingAgent({ kind: 'codex', path: linked6, prompt: 'x' }, {});
    assert.equal(r.ok, true, r.message);
    const stop = await ca.stopCodingAgent(r.id!);
    assert.equal(stop.status, 500);
    const requested = JSON.parse(readFileSync(join(runsRoot, r.id!, 'meta.json'), 'utf8')).stopRequestedAt;
    assert.ok(requested, 'written before the stop call');
    assert.equal((await ca.listCodingAgents({ id: r.id })).runs[0].state, 'running', 'no exit evidence yet');
    writeFileSync(exitFile(r.id!), JSON.stringify({ code: 0, signal: null, stopped: true, endedAt: new Date(Date.now() + 1000).toISOString() }));
    assert.equal((await ca.listCodingAgents({ id: r.id })).runs[0].state, 'stopped');
  } finally {
    setServiceManager(noServiceManager());
  }
});

test('a % in a worktree path is escaped for systemd (WorkingDirectory and description)', async () => {
  const started: string[][] = [];
  setServiceManager({ ...noServiceManager(), name: 'systemd', unavailable: null, startTransient: async (a) => (started.push(a), { ok: true, stdout: '', stderr: '' }), show: async () => ({ ok: true, stdout: 'ActiveState=inactive\n', stderr: '' }) });
  try {
    const wt = join(root, 'wt', 'shop-pct');
    git(mainRepo, 'worktree', 'add', '-b', 'pct-100%', wt);
    const r = await ca.startCodingAgent({ kind: 'codex', path: wt, prompt: 'x' }, {});
    assert.equal(r.ok, true, r.message);
    assert.ok(started[0].includes(`--property=WorkingDirectory=${wt}`), 'no % in this path');
    assert.ok(started[0].some((a) => a.startsWith('--description=') && a.includes('pct-100%%')), 'the branch name in the description');
    const r2 = await ca.startCodingAgent({ kind: 'codex', path: linked4, prompt: 'x' }, {});
    assert.equal(r2.ok, true, r2.message);
    assert.ok(started[1].includes(`--property=WorkingDirectory=${linked4.replace(/%/g, '%%')}`));
    assert.ok(linked4.includes('%') && !started[1].includes(`--property=WorkingDirectory=${linked4}`));
  } finally {
    setServiceManager(noServiceManager());
  }
});

test('output paging stays stable over many events and a file past 5 MB; the summary covers the whole file', async () => {
  const id = prepare(linked2);
  ageRun(id);
  const dir = join(runsRoot, id);
  const total = 3000;
  const big = 'é'.repeat(1500); // 3000 bytes of message text per event line: the file passes 5 MB
  const one = (i: number) => JSON.stringify({ type: 'item.completed', item: { id: `c${i}`, type: 'command_execution', command: `cmd ${i} ${big}`, exit_code: 0, status: 'completed' } });
  writeFileSync(join(dir, 'events.jsonl'), Array.from({ length: total }, (_, i) => one(i)).join('\n') + '\n');
  assert.ok(statSync(join(dir, 'events.jsonl')).size > 5 * 1024 * 1024);
  writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: 0, signal: null, endedAt: new Date().toISOString() }));
  let after = 0;
  const seen: number[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const out = await ca.codingAgentOutput(id, { after, limit: 200 });
    assert.equal(out.summary.commands, total, 'the summary counts every event');
    for (const l of out.lines) seen.push(l.i);
    assert.ok(out.next >= after);
    if (!out.truncated) {
      assert.equal(out.next, total);
      break;
    }
    after = out.next;
  }
  assert.deepEqual(seen, Array.from({ length: total }, (_, i) => i), 'every event once, in order, no gap');
  assert.equal((await ca.listCodingAgents({ id })).runs[0].commands, total);
});

test('final and stderr tail are cut in bytes on a character boundary', async () => {
  const id = prepare(linked2);
  const dir = join(runsRoot, id);
  writeFileSync(join(dir, 'last.md'), '한'.repeat(10_000)); // 30 000 bytes
  writeFileSync(join(dir, 'stderr.log'), 'x' + 'é'.repeat(3000));
  writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: 1, signal: null, endedAt: new Date().toISOString() }));
  const out = await ca.codingAgentOutput(id);
  assert.equal(out.finalTruncated, true);
  assert.equal(Buffer.byteLength(out.final!), 19_998, 'whole characters only, at most 20 000 bytes');
  assert.doesNotMatch(out.final!, /\uFFFD/);
  assert.ok(Buffer.byteLength(out.stderrTail!) <= 2_000);
  assert.doesNotMatch(out.stderrTail!, /\uFFFD/);
});

test('stop is refused in a container, like start', async () => {
  const { setPlatform, detectPlatform } = await import('../src/core/platform/index.ts');
  setPlatform(detectPlatform({ PORTBOARD_CONTAINER: '1', PORTBOARD_READ_ONLY: '0' }, 'linux'));
  try {
    assert.equal((await ca.stopCodingAgent('ca-0123456789')).status, 403);
    assert.equal((await ca.startCodingAgent({ kind: 'codex', path: linked, prompt: 'x' }, {})).status, 403);
  } finally {
    setPlatform(null);
  }
});

// ---- second review ----

test('process mode, start time unreadable for a live pid: running with stateUnknown, busy, and never signalled', async () => {
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore', env: { PATH: SYS_PATH } });
  try {
    await new Promise((r) => bystander.once('spawn', r));
    const id = prepare(linked7);
    const file = join(runsRoot, id, 'meta.json');
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    Object.assign(meta, { pid: bystander.pid, pidStart: 'recorded', startedAt: new Date(Date.now() - 120_000).toISOString() });
    writeFileSync(file, JSON.stringify(meta));
    ca.setProcessStartReader(async () => null);
    try {
      const run = (await ca.listCodingAgents({ id })).runs[0];
      assert.equal(run.state, 'running');
      assert.equal(run.stateUnknown, true);
      const busy = await ca.startCodingAgent({ kind: 'codex', path: linked7, prompt: 'x' }, {});
      assert.equal(busy.status, 409);
      assert.ok(busy.message.includes(id));
      const stop = await ca.stopCodingAgent(id);
      assert.equal(stop.status, 409);
      assert.equal(stop.message, L('이 실행의 프로세스가 Portboard가 띄운 것인지 확인할 수 없어서 신호를 보내지 않아요', "Can't tell whether this run's process is still the one Portboard started, so it is not signalled"));
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).stopRequestedAt, null, 'nothing was requested');
      assert.doesNotThrow(() => process.kill(bystander.pid!, 0));
    } finally {
      ca.setProcessStartReader(null);
    }
    assert.equal((await ca.listCodingAgents({ id })).runs[0].state, 'lost', 'readable again: not the recorded process');
    // a dead pid with no readable start time is lost, not unknown
    writeFileSync(file, JSON.stringify({ ...meta, pid: 2 ** 22 + 54321 }));
    ca.setProcessStartReader(async () => null);
    try {
      assert.equal((await ca.listCodingAgents({ id })).runs[0].state, 'lost');
    } finally {
      ca.setProcessStartReader(null);
    }
  } finally {
    bystander.kill('SIGKILL');
  }
});

test('process mode: a start that cannot read the runner start time stops the runner and fails with a 500', async () => {
  setMode('sleep');
  let spawned: number | null = null;
  ca.setProcessStartReader(async (pid) => ((spawned = pid), null));
  try {
    const r = await ca.startCodingAgent({ kind: 'codex', path: linked8, prompt: 'x' }, {});
    assert.equal(r.status, 500);
    assert.match(r.message, /start time/);
    assert.ok(spawned && spawned > 1);
    const end = Date.now() + 15_000;
    const gone = () => {
      try {
        process.kill(spawned!, 0);
        return false;
      } catch {
        return true;
      }
    };
    while (!gone() && Date.now() < end) await new Promise((res) => setTimeout(res, 25));
    assert.equal(gone(), true, 'the runner we spawned is stopped');
    ca.setProcessStartReader(null);
    assert.equal((await ca.listCodingAgents({ id: r.id })).runs[0].state, 'failed');
    assert.equal((await ca.startCodingAgent({ kind: 'codex', path: linked8, prompt: 'again' }, {})).ok, true, 'a failed launch does not block the worktree');
  } finally {
    ca.setProcessStartReader(null);
    setMode('ok');
  }
});

test('an unreadable runs folder is an error, not "no runs"; a missing one is empty', async () => {
  const file = join(root, 'not-a-folder');
  writeFileSync(file, 'x');
  await assert.rejects(ca.listCodingAgents({ dir: file }));
  assert.deepEqual(await ca.listCodingAgents({ dir: join(root, 'does-not-exist') }), { runs: [] });
  const r = await ca.startCodingAgent({ kind: 'codex', path: linked, prompt: 'x' }, {}, { dir: file });
  assert.equal(r.status, 500);
});

test('gemini cannot get workspace-write (its read-only is the approval mode, not an OS sandbox)', async () => {
  const r = await ca.startCodingAgent({ kind: 'gemini', path: linked, prompt: 'x', sandbox: 'workspace-write' }, {});
  assert.equal(r.status, 400);
  assert.match(r.message, /workspace-write is not supported for gemini yet/);
  const tool = TOOLS.find((t) => t.name === 'start_coding_agent')!;
  assert.match(tool.description, /approval mode/);
});

test('PORTBOARD_READ_ONLY=1 refuses a start with 403', async () => {
  const { setPlatform, detectPlatform } = await import('../src/core/platform/index.ts');
  setPlatform(detectPlatform({ PORTBOARD_READ_ONLY: '1' }, 'linux'));
  try {
    const r = await ca.startCodingAgent({ kind: 'codex', path: linked, prompt: 'x' }, {});
    assert.equal(r.status, 403);
    assert.match(r.message, /PORTBOARD_READ_ONLY=1/);
    assert.equal((await ca.stopCodingAgent('ca-0123456789')).status, 403);
  } finally {
    setPlatform(null);
  }
});
