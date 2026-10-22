// 세션 종료 정리 (#43): the ended-session store, the hook cleanup reason, the auto-stop modes (with real dummy
// processes as well as fake rows), the session-end route's guards, the autoStop setting, and the plugin's hook handler.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

// Before any Portboard module computes PATHS: this file's prefs and ended list are its own.
const DIR = await mkdtemp(join(tmpdir(), 'pb-claude-session-'));
process.env.PORTBOARD_PREFS = join(DIR, 'prefs.json');
process.env.PORTBOARD_CLAUDE_SESSIONS = join(DIR, 'claude-sessions.json');

const store = await import('../src/core/claude-sessions.ts');
const { cleanupReasons, ownerOf } = await import('../src/core/owners.ts');
const { autoStop, autoStopTargets, checkSessionEnd, checkSessionStart, localOnly, claudeSessionFeature } = await import('../src/features/claude-session.ts');
const { loadPrefs, setClaudeCleanup, setPortPrefs } = await import('../src/core/prefs.ts');
const { claudeEnvArgs, planStart } = await import('../src/core/devservers.ts');
const { createRouter } = await import('../src/features/router.ts');
const { onSessionEnd } = await import('../claude-plugin/hooks/session-end.ts');
const { onSessionStart } = await import('../claude-plugin/hooks/session-start.ts');
type Owner = import('../src/core/owners.ts').Owner;
type OwnedPort = import('../src/features/owners.ts').OwnedPort;
type EndedSession = import('../src/core/claude-sessions.ts').EndedSession;

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NOW = Date.parse('2026-10-18T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ended = (id: string, at: number, reason = 'other'): EndedSession => ({ id, cwd: '/w', reason, at: iso(at) });

after(() => rm(DIR, { recursive: true, force: true }));

// ---------- the store ----------

test('prune: newest first, one per id, at most 200, nothing older than 7 days', () => {
  const many = Array.from({ length: 205 }, (_, i) => ended(`s${String(i).padStart(4, '0')}x`, NOW - i * 1000));
  const kept = store.prune(many, NOW);
  assert.equal(kept.length, store.MAX_ENDED);
  assert.equal(kept[0].id, 's0000x');
  assert.equal(kept.at(-1)!.id, 's0199x');
  const old = store.prune([ended('olderthan7', NOW - 8 * 24 * 3600_000), ended('sixdaysold', NOW - 6 * 24 * 3600_000)], NOW);
  assert.deepEqual(old.map((e) => e.id), ['sixdaysold']);
  const dup = store.prune([ended('sameid000', NOW - 5000, 'other'), ended('sameid000', NOW - 1000, 'logout')], NOW);
  assert.deepEqual(dup.map((e) => e.reason), ['logout']);
});

test('recordEnded: atomic file, survives a reload, bounded on write; a broken file reads as empty', async () => {
  const path = join(DIR, 'store-a.json');
  for (let i = 0; i < 203; i++) await store.recordEnded({ id: `rec-${String(i).padStart(4, '0')}`, cwd: '/w', reason: 'other' }, NOW + i, path);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.ended.length, 200);
  assert.equal(raw.ended[0].id, 'rec-0202');
  assert.equal((await store.loadEnded(path, NOW + 300)).length, 200);
  // 8 days later the whole list has expired
  assert.equal((await store.loadEnded(path, NOW + 8 * 24 * 3600_000)).length, 0);
  const broken = join(DIR, 'store-b.json');
  await writeFile(broken, '{not json');
  assert.deepEqual(await store.loadEnded(broken, NOW), []);
  assert.deepEqual(await store.loadEnded(join(DIR, 'missing.json'), NOW), []);
  await store.recordEnded({ id: 'after-broken', cwd: '', reason: 'logout' }, NOW, broken);
  assert.deepEqual((await store.loadEnded(broken, NOW)).map((e) => e.id), ['after-broken']);
});

// The flake above: file timestamps tick coarsely (a few ms on tmpfs/ext4), so a write right after the broken file can
// carry its exact mtime; a cache keyed by mtime alone then served the stale []. Force the shared mtime every time.
test('loadEnded: a rewrite that keeps the mtime still invalidates the cache (atomic rename = new inode)', async () => {
  const path = join(DIR, 'store-same-mtime.json');
  const tick = new Date(NOW); // whole ms: utimes round-trips it exactly
  const sameTick = async () => {
    await utimes(path, tick, tick);
    assert.equal((await stat(path)).mtimeMs, NOW);
  };
  await writeFile(path, '{not json');
  await sameTick();
  assert.deepEqual(await store.loadEnded(path, NOW), []);
  await store.recordEnded({ id: 'same-tick-1', cwd: '', reason: 'logout' }, NOW, path);
  await sameTick();
  assert.deepEqual((await store.loadEnded(path, NOW)).map((e) => e.id), ['same-tick-1']);
  // two records within one tick
  await store.recordEnded({ id: 'same-tick-2', cwd: '', reason: 'other' }, NOW + 1, path);
  await sameTick();
  assert.deepEqual((await store.loadEnded(path, NOW + 1)).map((e) => e.id), ['same-tick-2', 'same-tick-1']);
});

test('recordStarted: kept next to the ended list; a start after an end cancels it, an older start does not', async () => {
  const path = join(DIR, 'store-started.json');
  await store.recordEnded({ id: 'came-back-1', cwd: '/w', reason: 'other' }, NOW - 60_000, path);
  await store.recordEnded({ id: 'stays-ended', cwd: '/w', reason: 'other' }, NOW - 60_000, path);
  await store.recordStarted({ id: 'stays-ended', cwd: '/w', source: 'startup' }, NOW - 120_000, path);
  await store.recordStarted({ id: 'came-back-1', cwd: '/w', source: 'resume' }, NOW - 1000, path);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(raw.ended.map((e: EndedSession) => e.id).sort(), ['came-back-1', 'stays-ended']);
  assert.deepEqual(raw.started.map((e: { id: string }) => e.id), ['came-back-1', 'stays-ended']);
  const lookup = store.lookupOf(await store.loadEnded(path, NOW), await store.loadStarted(path, NOW));
  assert.equal(lookup('came-back-1'), null);
  assert.equal(lookup('stays-ended')?.id, 'stays-ended');
  // an ended-only file from before keeps reading
  const old = join(DIR, 'store-old.json');
  await writeFile(old, JSON.stringify({ ended: [ended('from-before', NOW - 1000)] }));
  assert.deepEqual((await store.loadEnded(old, NOW)).map((e) => e.id), ['from-before']);
  assert.deepEqual(await store.loadStarted(old, NOW), []);
});

// ---------- the cleanup reason ----------

const owner = (over: Partial<Owner>): Owner => ({ pid: 1, session: null, worktree: null, scratchpad: false, cwdGone: false, orphan: false, ...over });
const session = (id: string, alive: boolean, lastActive: string | null) => ({ id, title: 't', alive, lastActive, source: 'env' as const });

test('cleanupReasons: a hook-ended session is a candidate at once — still alive, worktree server, no 2 h wait', () => {
  const lookup = store.lookupOf([ended('sess-ended', NOW - 30_000)]);
  // the Claude process is still exiting when the hook fires: alive, transcript just written
  assert.deepEqual(cleanupReasons(owner({ session: session('sess-ended', true, iso(NOW - 31_000)) }), NOW, lookup), ['session-ended-hook']);
  // a worktree server whose session ended a minute ago: the heuristic alone says keep, the hook says candidate
  const quiet = owner({ session: session('sess-ended', false, iso(NOW - 60_000)) });
  assert.deepEqual(cleanupReasons(quiet, NOW), []);
  assert.deepEqual(cleanupReasons(quiet, NOW, lookup), ['session-ended-hook']);
  // never both session reasons
  assert.deepEqual(cleanupReasons(owner({ scratchpad: true, session: session('sess-ended', false, iso(NOW - 60_000)) }), NOW, lookup), ['session-ended-hook']);
  // other sessions are untouched
  assert.deepEqual(cleanupReasons(owner({ session: session('sess-other', true, iso(NOW)) }), NOW, lookup), []);
  // cwd-gone still comes first
  assert.deepEqual(cleanupReasons(owner({ cwdGone: true, session: session('sess-ended', true, null) }), NOW, lookup), ['cwd-gone', 'session-ended-hook']);
});

test('cleanupReasons: a session that came back after its SessionEnd (resumed) is no longer hook-ended', () => {
  const lookup = store.lookupOf([ended('sess-resum', NOW - 10 * 60_000)]);
  // transcript moved 5 minutes after the hook: resumed in a new process
  assert.deepEqual(cleanupReasons(owner({ session: session('sess-resum', true, iso(NOW - 5 * 60_000)) }), NOW, lookup), []);
  // within the grace (the transcript's last write right after the hook) it still counts
  assert.deepEqual(cleanupReasons(owner({ session: session('sess-resum', true, iso(NOW - 10 * 60_000 + 30_000)) }), NOW, lookup), ['session-ended-hook']);
});

// ---------- auto-stop: which servers ----------

function row(port: number, o: Partial<Owner>, extra: Partial<OwnedPort> = {}): OwnedPort {
  const ow = owner({ pid: port, ...o });
  const reasons = cleanupReasons(ow, NOW, store.lookupOf([ended('sess-a-000', NOW - 1000), ended('sess-b-000', NOW - 1000)]));
  return { port, name: `svc${port}`, pid: port, unit: null, owner: ow, reasons, reasonText: [], ...extra };
}
const S = (id: string) => session(id, false, iso(NOW - 2000));
const DOC = {
  at: iso(NOW),
  ports: [
    row(18001, { session: S('sess-a-000'), scratchpad: true }), // scratchpad process
    row(18002, { session: S('sess-a-000') }, { unit: 'pb-sd-dummy.service' }), // transient pb-sd unit
    row(18003, { session: S('sess-a-000') }, { unit: 'pb-dev-portboard-1a2b.service' }), // transient pb-dev unit
    row(18004, { session: S('sess-a-000'), worktree: { repo: '~/r', repoName: 'r', path: '~/w', branch: 'b', merged: false, dirty: true, linked: true } }), // worktree process
    row(18005, { session: S('sess-a-000') }, { unit: 'other-transient.service' }), // someone else's systemd-run name
    { ...row(18006, { session: S('sess-a-000'), scratchpad: true }), reasons: [] }, // pinned: no reasons
    row(18007, { session: S('sess-b-000'), scratchpad: true }), // another ended session
    row(18008, { session: session('sess-live0', true, iso(NOW)), scratchpad: true }), // a live session
  ],
  candidates: [],
};
const ports = (rows: OwnedPort[]) => rows.map((r) => r.port);

test('autoStopTargets: off → none; scratchpad → scratchpad dirs and pb-sd/pb-dev units; all → every server of the session', () => {
  assert.deepEqual(ports(autoStopTargets(DOC, 'sess-a-000', 'off', 'other')), []);
  assert.deepEqual(ports(autoStopTargets(DOC, 'sess-a-000', 'scratchpad', 'other')), [18001, 18002, 18003]);
  assert.deepEqual(ports(autoStopTargets(DOC, 'sess-a-000', 'all', 'logout')), [18001, 18002, 18003, 18004, 18005]);
  // /clear: the Claude process keeps running, nothing is stopped whatever the mode
  assert.deepEqual(ports(autoStopTargets(DOC, 'sess-a-000', 'all', 'clear')), []);
  assert.deepEqual(ports(autoStopTargets(DOC, 'sess-b-000', 'scratchpad', 'other')), [18007]);
  assert.deepEqual(ports(autoStopTargets(DOC, 'sess-live0', 'all', 'other')), []);
});

const fakeDeps = (mode: 'off' | 'scratchpad' | 'all', calls: number[][], portboardPids: number[] = []) => ({
  snapshot: async () => ({}) as any,
  mode: async () => mode,
  owners: async () => DOC,
  cleanup: async (p: number[]) => (calls.push(p), p.map((port) => ({ port, ok: true, message: 'stopped' }))),
  isPortboard: async (pid: number) => portboardPids.includes(pid),
});

test('autoStop: goes through cleanup only when the mode allows it, never for a Portboard', async () => {
  const calls: number[][] = [];
  const e = { id: 'sess-a-000', cwd: '/w', reason: 'other' };
  assert.deepEqual((await autoStop(e, fakeDeps('off', calls))).results, []);
  assert.deepEqual(calls, []);
  const r = await autoStop(e, fakeDeps('scratchpad', calls, [18002]));
  assert.deepEqual(calls, [[18001, 18003]]);
  assert.equal(r.mode, 'scratchpad');
  assert.deepEqual(r.results.map((x) => x.port), [18001, 18003]);
  await autoStop(e, fakeDeps('all', calls));
  assert.deepEqual(calls.at(-1), [18001, 18002, 18003, 18004, 18005]);
  await autoStop({ ...e, reason: 'clear' }, fakeDeps('all', calls));
  assert.equal(calls.length, 2);
});

// ---------- auto-stop with real dummy processes ----------

const uid = userInfo().uid;
// One root per test process: concurrent `npm test` runs on this machine (other worktrees) used to share it, and each
// run's after() deleted the others' scratchpads mid-test, so their dummy servers showed up as 'cwd-gone'.
const SCRATCH_ROOT = `/tmp/claude-${uid}/-portboard-test-${process.pid}`;
after(() => rm(SCRATCH_ROOT, { recursive: true, force: true }));

function dummy(cwd: string, env: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ['-e', "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], {
    cwd,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', (d) => resolve({ child, port: Number(String(d).trim()) }));
    child.once('error', reject);
  });
}

test('autoStop per mode against real processes: owners come from /proc, only the allowed ones get SIGTERM', async () => {
  const sess = randomUUID();
  const scratch = join(SCRATCH_ROOT, sess, 'scratchpad', 'www');
  const work = await mkdtemp(join(tmpdir(), 'pb-worktree-'));
  await mkdir(scratch, { recursive: true });
  const env = { CLAUDE_CODE_SESSION_ID: sess, CLAUDE_PID: '999999999' };
  const started: ChildProcess[] = [];
  try {
    const run = async (mode: 'off' | 'scratchpad' | 'all') => {
      // tracked one by one: a failed spawn must not leave the earlier ones running (they kept the test process alive)
      const track = async (d: ReturnType<typeof dummy>) => {
        const x = await d;
        started.push(x.child);
        return x;
      };
      const a = await track(dummy(scratch, env)); // from the session's scratchpad
      const b = await track(dummy(work, env)); // same session, an ordinary directory
      const c = await track(dummy(scratch, { ...env, CLAUDE_CODE_SESSION_ID: randomUUID() })); // another session's env (scratchpad id loses to env)
      const lookup = store.lookupOf([ended(sess, Date.now())]);
      const rows: OwnedPort[] = [];
      for (const d of [a, b, c]) {
        const o = (await ownerOf(d.child.pid!))!;
        const reasons = cleanupReasons(o, Date.now(), lookup);
        rows.push({ port: d.port, name: 'node', pid: d.child.pid!, unit: null, owner: o, reasons, reasonText: [] });
      }
      assert.equal(rows[0].owner.scratchpad, true);
      assert.equal(rows[0].owner.session?.id, sess);
      assert.equal(rows[1].owner.session?.id, sess);
      assert.equal(rows[1].owner.scratchpad, false);
      // c: its (fake, dead) CLAUDE_PID and scratchpad cwd make it a candidate by the old heuristic, but it isn't this session's
      assert.deepEqual(rows.map((r) => r.reasons), [['session-ended-hook'], ['session-ended-hook'], ['session-ended']]);
      const killed: number[] = [];
      await autoStop({ id: sess, cwd: scratch, reason: 'prompt_input_exit' }, {
        snapshot: async () => ({}) as any,
        mode: async () => mode,
        owners: async () => ({ at: '', ports: rows, candidates: [] }),
        cleanup: async (ps) => ps.map((port) => {
          const r = rows.find((x) => x.port === port)!;
          process.kill(r.pid, 'SIGTERM');
          killed.push(port);
          return { port, ok: true, message: 'SIGTERM' };
        }),
        isPortboard: async () => false,
      });
      return { killed, a: a.port, b: b.port };
    };
    const off = await run('off');
    assert.deepEqual(off.killed, []);
    const sp = await run('scratchpad');
    assert.deepEqual(sp.killed, [sp.a]);
    const all = await run('all');
    assert.deepEqual(all.killed, [all.a, all.b]);
  } finally {
    for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
    await rm(join(SCRATCH_ROOT, sess), { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

// ---------- the route ----------

const req = (method: string, remoteAddress: string, headers: Record<string, string> = {}) => ({ method, headers: { 'x-portboard': '1', ...headers }, socket: { remoteAddress } }) as any;

test('localOnly: loopback without proxy headers only', () => {
  assert.equal(localOnly(req('POST', '127.0.0.1')), true);
  assert.equal(localOnly(req('POST', '::1')), true);
  assert.equal(localOnly(req('POST', '100.64.0.5')), false);
  assert.equal(localOnly(req('POST', '127.0.0.1', { 'x-forwarded-for': '100.64.0.5' })), false);
  assert.equal(localOnly(req('POST', '127.0.0.1', { 'tailscale-user-login': 'a@b' })), false);
  assert.equal(localOnly(req('POST', '127.0.0.1', { 'tailscale-funnel-request': '?1' })), false);
});

test('checkSessionEnd validates the hook JSON and ignores its other fields', () => {
  const id = randomUUID();
  assert.deepEqual(checkSessionEnd({ session_id: id, cwd: '/w', reason: 'logout', transcript_path: '/t', hook_event_name: 'SessionEnd' }), { id, cwd: '/w', reason: 'logout' });
  assert.deepEqual(checkSessionEnd({ session_id: id }), { id, cwd: '', reason: 'other' });
  assert.equal(typeof checkSessionEnd(null), 'string');
  assert.equal(typeof checkSessionEnd({ session_id: '../../etc' }), 'string');
  assert.equal(typeof checkSessionEnd({ session_id: id, cwd: 3 }), 'string');
  assert.equal(typeof checkSessionEnd({ session_id: id, reason: 'x y; rm' }), 'string');
});

test('checkSessionStart: the session-end rules, source in place of reason', () => {
  const id = randomUUID();
  assert.deepEqual(checkSessionStart({ session_id: id, cwd: '/w', source: 'resume', model: 'x' }), { id, cwd: '/w', source: 'resume' });
  assert.deepEqual(checkSessionStart({ session_id: id }), { id, cwd: '', source: 'other' });
  assert.equal(checkSessionStart({ session_id: id, source: 'x y; rm' }), 'source must be a short word');
  assert.equal(typeof checkSessionStart({ session_id: '../x' }), 'string');
  assert.equal(typeof checkSessionStart(null), 'string');
});

test('POST /api/claude/session-start: X-Portboard and loopback only, then records', async () => {
  const route = createRouter(claudeSessionFeature.routes!);
  const ctx = { invalidate: () => {}, snapshot: async () => assert.fail('no snapshot') } as any;
  const body = (b: unknown) => {
    const r = req('POST', '127.0.0.1');
    r.on = (ev: string, fn: (x?: unknown) => void) => {
      if (ev === 'data') fn(Buffer.from(JSON.stringify(b)));
      if (ev === 'end') fn();
      return r;
    };
    return r;
  };
  const url = new URL('http://x/api/claude/session-start');
  const id = randomUUID();
  assert.equal((await route({ ...body({ session_id: id }), headers: {} }, url, ctx))!.status, 403);
  const viaServe = body({ session_id: id });
  viaServe.headers['tailscale-user-login'] = 'someone@example.com';
  assert.deepEqual(await route(viaServe, url, ctx), { status: 403, body: { error: 'loopback only' } });
  assert.equal((await route(body({ session_id: id, source: '; rm' }), url, ctx))!.status, 400);
  assert.deepEqual(await route(body({ session_id: id, cwd: '/w', source: 'resume' }), url, ctx), { status: 200, body: { recorded: true } });
  assert.deepEqual((await store.loadStarted())[0], { id, cwd: '/w', source: 'resume', at: (await store.loadStarted())[0].at });
});

test('POST /api/claude/session-end: guard, loopback, then records; settings route validates', async () => {
  const route = createRouter(claudeSessionFeature.routes!);
  const invalidated: string[] = [];
  const ctx = { invalidate: (w: string) => invalidated.push(w), snapshot: async () => assert.fail('no auto-stop with off') } as any;
  const body = (b: unknown) => {
    const r = req('POST', '127.0.0.1');
    // the router reads the body from the request stream
    const chunks = [Buffer.from(JSON.stringify(b))];
    r.on = (ev: string, fn: (x?: unknown) => void) => {
      if (ev === 'data') for (const c of chunks) fn(c);
      if (ev === 'end') fn();
      return r;
    };
    return r;
  };
  const url = new URL('http://x/api/claude/session-end');
  const id = randomUUID();
  // no X-Portboard
  assert.equal((await route({ ...body({ session_id: id }), headers: {} }, url, ctx))!.status, 403);
  // via tailscale serve (loopback socket, forwarded headers)
  const viaServe = body({ session_id: id });
  viaServe.headers['tailscale-user-login'] = 'someone@example.com';
  assert.deepEqual(await route(viaServe, url, ctx), { status: 403, body: { error: 'loopback only' } });
  const remote = body({ session_id: id });
  remote.socket.remoteAddress = '100.64.0.9';
  assert.equal((await route(remote, url, ctx))!.status, 403);
  assert.equal((await route(body({ session_id: 'x' }), url, ctx))!.status, 400);
  const okReply = await route(body({ session_id: id, cwd: '/w', reason: 'logout' }), url, ctx);
  assert.deepEqual(okReply, { status: 200, body: { recorded: true, autoStop: 'off' } });
  assert.deepEqual(invalidated, ['snapshot']);
  assert.equal((await store.loadEnded())[0].id, id);

  const sessions = await route({ method: 'GET', headers: {} } as any, new URL('http://x/api/claude/sessions'), ctx);
  assert.equal((sessions!.body as any).ended[0].id, id);
  assert.deepEqual((sessions!.body as any).settings, { autoStop: 'off' });
  const settingsUrl = new URL('http://x/api/claude/settings');
  assert.equal((await route(body({ autoStop: 'everything' }), settingsUrl, ctx))!.status, 400);
  assert.deepEqual(await route(body({ autoStop: 'scratchpad' }), settingsUrl, ctx), { status: 200, body: { settings: { autoStop: 'scratchpad' } } });
  assert.deepEqual((await loadPrefs()).claudeCleanup, { autoStop: 'scratchpad' });
  await setClaudeCleanup('off');
});

// ---------- the setting ----------

test('prefs: claudeCleanup survives other writes, off is removed, junk is dropped', async () => {
  const path = join(DIR, 'prefs-b.json');
  await setClaudeCleanup('all', path);
  await setPortPrefs(3000, { pinned: true }, path);
  assert.deepEqual((await loadPrefs(path)).claudeCleanup, { autoStop: 'all' });
  await setClaudeCleanup('off', path);
  assert.equal('claudeCleanup' in JSON.parse(await readFile(path, 'utf8')), false);
  await writeFile(path, JSON.stringify({ ports: {}, claudeCleanup: { autoStop: 'nuke' } }));
  assert.equal((await loadPrefs(path)).claudeCleanup, undefined);
});

// ---------- pb-dev units carry the asking session ----------

test('start_dev_server from a Claude session passes its id to the unit; the dashboard path passes none', () => {
  const id = randomUUID();
  assert.deepEqual(claudeEnvArgs({ CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: '42' }), [`--setenv=CLAUDE_CODE_SESSION_ID=${id}`, '--setenv=CLAUDE_PID=42']);
  assert.deepEqual(claudeEnvArgs({ CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: '4 2' }), [`--setenv=CLAUDE_CODE_SESSION_ID=${id}`]);
  assert.deepEqual(claudeEnvArgs({ CLAUDE_CODE_SESSION_ID: 'a b' }), []);
  assert.deepEqual(claudeEnvArgs({}), []);
  const p = planStart({ dir: '/w/x', label: 'x@b', script: 'dev', command: 'vite', port: 5300, nodeBin: '/n/bin', env: { CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: '42' } });
  assert.ok(p.args.indexOf(`--setenv=CLAUDE_CODE_SESSION_ID=${id}`) < p.args.indexOf('--'));
  assert.ok(!planStart({ dir: '/w/x', label: 'x@b', script: 'dev', command: 'vite', port: 5300, nodeBin: '/n/bin' }).args.some((a) => a.includes('CLAUDE')));
});

// ---------- the plugin's hook handler ----------

// Records only the hook's POST. The live Portboard on this machine probes every new loopback listener with GET / for
// its <title>, and that probe used to land here as an empty body (JSON.parse threw, an uncaught flake under load).
async function listen(handler: (req: IncomingMessage, body: string) => void, answer = true, path = '/api/claude/session-end'): Promise<{ server: Server; url: string }> {
  const server = createServer((q, s) => {
    if (q.method !== 'POST' || q.url !== path) return void s.writeHead(404).end();
    let b = '';
    q.on('data', (c) => (b += c));
    q.on('end', () => {
      handler(q, b);
      if (answer) s.end('{"recorded":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('onSessionEnd: POSTs {session_id, cwd, reason} with X-Portboard', async () => {
  const got: { path: string; header: unknown; body: unknown }[] = [];
  const { server, url } = await listen((q, b) => got.push({ path: q.url!, header: q.headers['x-portboard'], body: JSON.parse(b) }));
  try {
    await onSessionEnd({ session_id: 'abcd-1234-ef', cwd: '/w', reason: 'logout' }, { url });
    assert.deepEqual(got, [{ path: '/api/claude/session-end', header: '1', body: { session_id: 'abcd-1234-ef', cwd: '/w', reason: 'logout' } }]);
  } finally {
    server.close();
  }
});

test('onSessionStart: POSTs {session_id, cwd, source} with X-Portboard; never throws', async () => {
  const got: { path: string; header: unknown; body: unknown }[] = [];
  const { server, url } = await listen((q, b) => got.push({ path: q.url!, header: q.headers['x-portboard'], body: JSON.parse(b) }), true, '/api/claude/session-start');
  try {
    await onSessionStart({ session_id: 'abcd-1234-ef', cwd: '/w', source: 'resume' }, { url });
    await onSessionStart({ session_id: 'abcd-1234-ff', cwd: '/w' }, { url });
    assert.deepEqual(got, [
      { path: '/api/claude/session-start', header: '1', body: { session_id: 'abcd-1234-ef', cwd: '/w', source: 'resume' } },
      { path: '/api/claude/session-start', header: '1', body: { session_id: 'abcd-1234-ff', cwd: '/w' } },
    ]);
  } finally {
    server.close();
  }
  await onSessionStart({ session_id: 'abcd-1234-ef', cwd: '/w' }, { url: 'http://127.0.0.1:1' });
  await onSessionStart(null as any);
});

test('onSessionEnd never throws and gives up after 500 ms', async () => {
  const { server, url } = await listen(() => {}, false); // never answers
  try {
    const t0 = Date.now();
    await onSessionEnd({ session_id: 'abcd-1234-ef', cwd: '/w' }, { url });
    const took = Date.now() - t0;
    assert.ok(took >= 450 && took < 1500, `took ${took} ms`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
  await onSessionEnd({ session_id: 'abcd-1234-ef', cwd: '/w' }, { url: 'http://127.0.0.1:1' }); // refused
  await onSessionEnd(null as any);
  await onSessionEnd({ session_id: 'abcd-1234-ef', cwd: '/w' }, { url: 'not a url' });
});

test('session-end.ts as a CLI: reads the SessionEnd JSON from stdin, exits 0 with or without Portboard', async () => {
  const got: unknown[] = [];
  const { server, url } = await listen((_q, b) => got.push(JSON.parse(b)));
  const cli = (input: string, env: Record<string, string>) =>
    new Promise<number | null>((resolve) => {
      const c = spawn(process.execPath, [join(ROOT, 'claude-plugin/hooks/session-end.ts')], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
      c.on('exit', resolve);
      c.stdin.end(input);
    });
  try {
    const input = JSON.stringify({ session_id: 'abcd-1234-ef', transcript_path: '/t.jsonl', cwd: '/w', hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
    assert.equal(await cli(input, { PORTBOARD_URL: url }), 0);
    assert.deepEqual(got, [{ session_id: 'abcd-1234-ef', cwd: '/w', reason: 'prompt_input_exit' }]);
    assert.equal(await cli('not json', { PORTBOARD_URL: url }), 0);
    assert.equal(await cli(input, { PORTBOARD_URL: 'http://127.0.0.1:1' }), 0);
    assert.equal(got.length, 1);
  } finally {
    server.close();
  }
});
