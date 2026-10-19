// REST routes no other test drives (#6), through the registry's router with a fake server context: dev servers
// (script allowlist, port choice, unit naming), control (logs, restart/stop and their quiet window), port rules,
// reservations, free ports, 새 기기, device names, unexpose, the alert test button, Proxmox trends and the worktree
// writes' argument checks.
//
// Nothing here reaches the machine: every state file lives in a temp dir (set before any Portboard module computes
// PATHS), and the commands the routes run (ss, git, systemctl, systemd-run, journalctl, tailscale, docker, ip, gh)
// are shell shims first on PATH that log their argv and print canned output from out/<name>.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const DIR = await mkdtemp(join(tmpdir(), 'pb-routes-'));
const SHIM = join(DIR, 'shim');
const OUT = join(SHIM, 'out');
const CALLS = join(SHIM, 'calls.log');
const REPOS = join(DIR, 'repos');
const MAIN = join(REPOS, 'shop-web');
const FEAT = join(DIR, 'worktrees', 'shop-web-feat');

Object.assign(process.env, {
  PORTBOARD_PREFS: join(DIR, 'prefs.json'),
  PORTBOARD_CLIENTS: join(DIR, 'clients.json'),
  PORTBOARD_RESERVATIONS: join(DIR, 'reservations.json'),
  PORTBOARD_REMOTE_CONFIG: join(DIR, 'remote.json'),
  PORTBOARD_SITE: join(DIR, 'portboard.json'),
  PORTBOARD_ACCESS: join(DIR, 'access.json'),
  PORTBOARD_STATE_DIR: join(DIR, 'state'),
  PORTBOARD_HISTORY: join(DIR, 'history.json'),
  PORTBOARD_UPTIME: join(DIR, 'uptime.json'),
  PORTBOARD_AUDIT: join(DIR, 'audit.jsonl'),
  PORTBOARD_PROXMOX: join(DIR, 'proxmox.json'),
  PORTBOARD_PVEPORTS: join(DIR, 'pveports.json'),
  PORTBOARD_WINPORTS: join(DIR, 'winports.json'),
  PORTBOARD_ALERT_CHANNEL: join(DIR, 'alerts-channel.json'),
  COMPUTE_POOL_DIR: join(DIR, 'pool'),
  PORTBOARD_REPOS_ROOT: REPOS,
  PATH: `${join(SHIM, 'bin')}:/usr/bin:/bin`,
});

// ---- the shims ----

/** One script per command: log "<cmd> <args>", print out/<key>, stderr from out/<key>.err, exit out/<key>.code (0), or exit 1 without out/<key>. */
async function shim(cmd: string, key: string) {
  const script = `#!/bin/sh
echo "${cmd} $*" >> "${CALLS}"
k="${key}"
f="${OUT}/$k"
[ -f "$f.err" ] && cat "$f.err" >&2
[ -f "$f" ] || exit 1
cat "$f"
[ -f "$f.code" ] && exit "$(cat "$f.code")"
exit 0
`;
  await writeFile(join(SHIM, 'bin', cmd), script);
  await chmod(join(SHIM, 'bin', cmd), 0o755);
}

await mkdir(join(SHIM, 'bin'), { recursive: true });
await mkdir(OUT, { recursive: true });
// git -C <repo> …  → out/git-<repo name>;  systemctl --user <verb> … → out/systemctl-<verb>
await shim('git', 'git-$(basename "$2")');
await shim('systemctl', 'systemctl-$2');
for (const c of ['ss', 'systemd-run', 'journalctl', 'tailscale', 'docker', 'ip', 'gh']) await shim(c, c);

const out = (key: string, text: string, extra: { code?: number; err?: string } = {}) =>
  Promise.all([
    writeFile(join(OUT, key), text),
    extra.code === undefined ? rm(join(OUT, `${key}.code`), { force: true }) : writeFile(join(OUT, `${key}.code`), String(extra.code)),
    extra.err === undefined ? rm(join(OUT, `${key}.err`), { force: true }) : writeFile(join(OUT, `${key}.err`), extra.err),
  ]);
const calls = async (cmd: string) => (await readFile(CALLS, 'utf8').catch(() => '')).split('\n').filter((l) => l.startsWith(`${cmd} `));
const clearCalls = () => rm(CALLS, { force: true });
const listen = (...ports: number[]) => out('ss', ports.map((p) => `LISTEN 0      511        127.0.0.1:${p}        0.0.0.0:*`).join('\n') + '\n');

// ---- the repos: shop-web (main) with a linked worktree on feat ----

await mkdir(join(MAIN, '.git'), { recursive: true });
await mkdir(FEAT, { recursive: true });
await writeFile(join(MAIN, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'tsc -b', test: 'node --test' } }));
await writeFile(join(FEAT, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js', lint: 'eslint .' } }));
await out('git-shop-web', `worktree ${MAIN}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n\nworktree ${FEAT}\nHEAD ${'b'.repeat(40)}\nbranch refs/heads/feat\n\n`);

// ---- Portboard, imported only now ----

const { REGISTRY } = await import('../src/features/registry.ts');
const { createRouter } = await import('../src/features/router.ts');
const { unitFor } = await import('../src/core/devservers.ts');
const { loadReservations } = await import('../src/core/reservations.ts');
const { loadNames } = await import('../src/core/clients.ts');
const { loadPrefs } = await import('../src/core/prefs.ts');
const { applyRule } = await import('../src/features/port-rules.ts');
const { t } = await import('../src/core/i18n.ts');

after(() => rm(DIR, { recursive: true, force: true }));

const route = createRouter(REGISTRY.routes);

/** What the handlers may touch on the server context; every call is recorded. */
function context(over: Record<string, unknown> = {}) {
  const invalidated: string[] = [];
  const acked: string[] = [];
  const ctx = {
    invalidate: (w: string) => void invalidated.push(w),
    snapshot: async () => ({ ports: [] }),
    topology: async (fresh?: boolean) => ({ topology: true, fresh: !!fresh }),
    known: {
      summary: async (settings: unknown) => ({ pending: [], settings }),
      acknowledge: async (key: string) => (acked.push(key), key === 'all' ? 3 : 1),
    },
    alerts: { test: async () => ({ ok: false, message: 'no channel', sent: [] }) },
    ...over,
  };
  return { ctx: ctx as any, invalidated, acked };
}

async function api(method: 'GET' | 'POST', path: string, body?: unknown, c = context()) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as any;
  req.method = method;
  req.headers = { 'x-portboard': '1' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const r = await route(req, new URL(`http://dash${path}`), c.ctx);
  assert.ok(r, `${method} ${path} is a route`);
  return r as { status: number; body: any };
}

const systemdUnits = async (running: { dir: string; port: number; script: string; owner: string }[]) => {
  await out('systemctl-list-units', running.map((r) => `${unitFor(r.dir)} loaded active running Portboard dev\n`).join(''));
  await out(
    'systemctl-show',
    running
      .map((r) => `Id=${unitFor(r.dir)}\nWorkingDirectory=${r.dir}\nActiveState=active\nSubState=running\nDescription=Portboard dev: ${r.owner} :${r.port} (${r.script})\nActiveEnterTimestamp=n/a\n`)
      .join('\n'),
  );
};

// ---------- dev servers ----------

test('GET /api/dev-servers: running pb-dev units with their worktree owner; startable worktrees offer only dev/start/preview/serve', async () => {
  await systemdUnits([{ dir: FEAT, port: 5300, script: 'start', owner: 'shop-web@feat' }]);
  const r = await api('GET', '/api/dev-servers');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.running.map((x: any) => [x.unit, x.path, x.port, x.active, x.owner]), [[unitFor(FEAT), FEAT, 5300, true, 'shop-web@feat']]);
  assert.deepEqual(r.body.startable[MAIN], { scripts: { dev: 'vite' }, preferred: 'dev', owner: 'shop-web@main' });
  assert.deepEqual(r.body.startable[FEAT], { scripts: { start: 'node server.js' }, preferred: 'start', owner: 'shop-web@feat' });
});

test('POST /api/dev-servers/start: bad bodies, unknown directories and scripts outside the allowlist are 400 before anything runs', async () => {
  await systemdUnits([]);
  await clearCalls();
  assert.deepEqual(await api('POST', '/api/dev-servers/start', {}), { status: 400, body: { error: 'path required' } });
  for (const port of [80, 70000, 5300.5, 'abc']) {
    assert.deepEqual(await api('POST', '/api/dev-servers/start', { path: MAIN, port }), { status: 400, body: { error: 'port must be 1024–65535' } }, String(port));
  }
  const unknown = await api('POST', '/api/dev-servers/start', { path: join(DIR, 'elsewhere') });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.message, t('devservers.unknownDir'));
  // in package.json, but not a script Portboard starts; and names every object has
  for (const script of ['build', 'test', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const r = await api('POST', '/api/dev-servers/start', { path: MAIN, script });
    assert.equal(r.status, 400, script);
    assert.equal(r.body.message, t('devservers.noScript', { scripts: 'dev' }), script);
  }
  assert.deepEqual(await calls('systemd-run'), [], 'nothing was started');
});

test('POST /api/dev-servers/start: a running worktree is 409; a port reserved for someone else or in use is 409', async () => {
  await systemdUnits([{ dir: FEAT, port: 5300, script: 'start', owner: 'shop-web@feat' }]);
  await listen(5401);
  await clearCalls();
  const running = await api('POST', '/api/dev-servers/start', { path: FEAT });
  assert.deepEqual([running.status, running.body.message], [409, t('devservers.running')]);

  assert.equal((await api('POST', '/api/reservations', { owner: 'uploader', port: 5400 })).status, 201);
  const held = await api('POST', '/api/dev-servers/start', { path: MAIN, port: 5400 });
  assert.deepEqual([held.status, held.body.message], [409, t('devservers.reserved', { port: 5400, owner: 'uploader' })]);
  const busy = await api('POST', '/api/dev-servers/start', { path: MAIN, port: '5401' });
  assert.deepEqual([busy.status, busy.body.message], [409, t('devservers.inUse', { port: 5401 })]);
  assert.deepEqual(await calls('systemd-run'), []);
  await api('POST', '/api/reservations/5400/release');
});

test('POST /api/dev-servers/start: the worktree\'s own reservation first; the unit is named for the directory and runs npm run <script> on loopback', async () => {
  await systemdUnits([]);
  await listen(3000);
  await out('systemd-run', '');
  await clearCalls();
  assert.equal((await api('POST', '/api/reservations', { owner: 'shop-web@main', port: 5402, note: 'mine' })).status, 201);
  const c = context();
  const r = await api('POST', '/api/dev-servers/start', { path: MAIN }, c);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.port, 5402);
  assert.equal(r.body.unit, unitFor(MAIN));
  assert.match(r.body.unit, /^pb-dev-repos-shop-web-[0-9a-f]{8}\.service$/);
  assert.equal(r.body.message, t('devservers.started', { unit: unitFor(MAIN), port: 5402, fw: 'vite' }));
  assert.deepEqual(c.invalidated, ['snapshot']);
  const [run] = await calls('systemd-run');
  assert.ok(run.includes(`--unit=${unitFor(MAIN)}`), run);
  assert.ok(run.includes(`--property=WorkingDirectory=${MAIN}`), run);
  assert.ok(run.includes('--setenv=PORT=5402'), run);
  assert.match(run, / -- \S+\/npm run dev -- --port 5402 --strictPort --host 127\.0\.0\.1$/);
  assert.ok(!run.includes('CLAUDE_CODE_SESSION_ID'), 'the dashboard\'s button belongs to no Claude session');

  // no reservation: the first free port (3000 is taken) is picked and reserved for the worktree's owner
  const feat = await api('POST', '/api/dev-servers/start', { path: FEAT, script: 'start' });
  assert.equal(feat.status, 200);
  assert.equal(feat.body.port, 3001);
  const held = (await loadReservations()).find((x) => x.port === 3001);
  assert.deepEqual([held?.owner, held?.note], ['shop-web@feat', 'dev server (start)']);
  const [, second] = await calls('systemd-run');
  assert.match(second, / -- \S+\/npm run start$/, 'a generic server gets PORT/HOST env only, no flags');
});

test('POST /api/dev-servers/start: systemd-run failing is a 500 with its own message, the port stays reserved', async () => {
  await systemdUnits([]);
  await listen();
  await out('systemd-run', '', { code: 1, err: 'Failed to start transient service unit: Unit already exists.\n' });
  const r = await api('POST', '/api/dev-servers/start', { path: MAIN, port: 5410 });
  assert.equal(r.status, 500);
  assert.deepEqual([r.body.ok, r.body.message], [false, 'Failed to start transient service unit: Unit already exists.']);
  assert.ok((await loadReservations()).some((x) => x.port === 5410 && x.owner === 'shop-web@main'));
  await out('systemd-run', '');
});

test('POST /api/dev-servers/stop: 404 when Portboard started nothing there; otherwise systemctl --user stop on that unit only', async () => {
  await systemdUnits([{ dir: FEAT, port: 5300, script: 'start', owner: 'shop-web@feat' }]);
  await out('systemctl-stop', '');
  await clearCalls();
  assert.deepEqual(await api('POST', '/api/dev-servers/stop', { path: 7 }), { status: 400, body: { error: 'path required' } });
  const none = await api('POST', '/api/dev-servers/stop', { path: MAIN });
  assert.deepEqual([none.status, none.body.message], [404, t('devservers.notRunning')]);
  const c = context();
  const r = await api('POST', '/api/dev-servers/stop', { path: FEAT }, c);
  assert.deepEqual(r, { status: 200, body: { ok: true, message: t('devservers.stopped', { unit: unitFor(FEAT) }) } });
  assert.deepEqual(c.invalidated, ['snapshot']);
  assert.deepEqual((await calls('systemctl')).filter((l) => l.includes(' stop ')), [`systemctl --user stop ${unitFor(FEAT)}`]);
});

// ---------- control ----------

const entry = (port: number, control: unknown) => ({ port, listening: true, control });

test('GET /api/ports/:port/logs: owner from ctx.snapshot (not a new one); lines clamped; nothing listening or no owner is 409', async () => {
  await out('journalctl', '2026-10-19T10:00:00+0000 box shop[1]: one\n2026-10-19T10:00:01+0000 box shop[1]: two\n');
  await clearCalls();
  let snaps = 0;
  const c = context({ snapshot: async () => (snaps++, { ports: [entry(8080, { type: 'systemd', unit: 'shop.service' }), entry(8081, null)] }) });
  const r = await api('GET', '/api/ports/8080/logs?lines=20', undefined, c);
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'journalctl --user -u shop.service');
  assert.equal(r.body.lines.length, 2);
  await api('GET', '/api/ports/8080/logs?lines=abc', undefined, c);
  await api('GET', '/api/ports/8080/logs?lines=999999', undefined, c);
  assert.deepEqual(
    (await calls('journalctl')).map((l) => l.split(' -n ')[1]),
    ['20 --no-pager -o short-iso', '100 --no-pager -o short-iso', '1000 --no-pager -o short-iso'],
  );
  assert.deepEqual(await api('GET', '/api/ports/9/logs', undefined, c), { status: 409, body: { ok: false, source: '', lines: [], message: 'nothing is listening on 9' } });
  assert.equal((await api('GET', '/api/ports/8081/logs', undefined, c)).body.message, 'owner of 8081 is not visible to this user');
  assert.equal(snaps, 5);
  assert.equal((await api('GET', '/api/ports/0/logs', undefined, c)).status, 400);
});

test('POST restart/stop: the owner comes from a fresh snapshot; a failure is 409, clears the quiet window it set, and invalidates', async () => {
  await listen(18080);
  await clearCalls();
  const quiet = join(process.env.PORTBOARD_STATE_DIR!, 'quiet.json');
  for (const action of ['restart', 'stop']) {
    const c = context({ snapshot: async () => assert.fail('writes take a new snapshot, not the shared one') });
    const unowned = await api('POST', `/api/ports/18080/${action}`, undefined, c);
    assert.deepEqual(unowned, { status: 409, body: { ok: false, message: 'owner of 18080 is not visible to this user' } }, action);
    const nothing = await api('POST', `/api/ports/18099/${action}`, undefined, c);
    assert.deepEqual(nothing, { status: 409, body: { ok: false, message: 'nothing is listening on 18099' } }, action);
    assert.deepEqual(c.invalidated, ['snapshot', 'snapshot']);
  }
  assert.ok((await calls('ss')).length >= 4, 'each action ran ss itself');
  const q = JSON.parse(await readFile(quiet, 'utf8').catch(() => '{}'));
  assert.ok(!JSON.stringify(q).includes('18080') && !JSON.stringify(q).includes('18099'), `no quiet window left after a failure: ${JSON.stringify(q)}`);
  assert.deepEqual([...(await calls('systemctl')), ...(await calls('docker'))].filter((l) => / (restart|stop) /.test(l)), [], 'nothing was restarted or stopped');
});

test('POST /api/ports/:port/unexpose: a port that is not served is 409 and nothing is turned off', async () => {
  await clearCalls();
  const c = context();
  const r = await api('POST', '/api/ports/8080/unexpose', undefined, c);
  assert.deepEqual(r.status, 409);
  assert.equal(r.body.message, '8080 is not served');
  assert.ok((await calls('tailscale')).every((l) => l.includes('status')), 'only serve status was asked');
});

// ---------- port rules ----------

test('POST /api/port-rules: body checks, then the key and rule checks of applyRule, all 400 with the reason', async () => {
  const bad = async (body: unknown) => (await api('POST', '/api/port-rules', body)).body;
  assert.deepEqual(await api('POST', '/api/port-rules', '[1]'), { status: 400, body: { error: 'body must be an object' } });
  assert.deepEqual(await bad({ key: '3000-3010' }), { error: 'rule is required (an object, or null to remove)' });
  assert.deepEqual(await bad({ key: '', rule: {} }), { ok: false, key: '', error: 'key must be a non-empty string' });
  assert.match((await bad({ key: '3010-3000', rule: { label: 'x' } })).error, /backwards/);
  assert.match((await bad({ key: 'vite(', rule: { label: 'x' } })).error, /valid regex/);
  assert.deepEqual(await bad({ key: '3000-3010', rule: { color: 'red' } }), { ok: false, key: '3000-3010', error: 'unknown field: color' });
  assert.deepEqual(await bad({ key: '3000-3010', rule: [] }), { ok: false, key: '3000-3010', error: 'rule must be an object' });
  assert.match((await bad({ key: '3000-3010', rule: { onNew: 'loud' } })).error, /^onNew must be one of/);
  assert.deepEqual(await applyRule(42, {}), { ok: false, key: '42', error: 'key must be a non-empty string' });
});

test('POST /api/port-rules: a range goes to portRules, a single port to its own entry, otherPorts to the default; null removes', async () => {
  const c = context();
  const range = await api('POST', '/api/port-rules', { key: ' 18891-18899 ', rule: { label: 'Scratchpad preview', hidden: true } }, c);
  assert.equal(range.status, 200);
  assert.deepEqual([range.body.ok, range.body.key, range.body.where, range.body.rule], [true, '18891-18899', 'portRules', { label: 'Scratchpad preview', hidden: true }]);
  assert.deepEqual(range.body.view.rules.map((r: any) => [r.key, r.kind, r.rank]), [['18891-18899', 'range', 0]]);
  assert.deepEqual(range.body.view.onNew, ['notify', 'openBrowserOnce', 'silent', 'ignore']);
  assert.deepEqual(c.invalidated, ['snapshot']);

  const one = await api('POST', '/api/port-rules', { key: '5173', rule: { label: 'shop', onNew: 'silent' } });
  assert.deepEqual([one.body.where, one.body.key], ['ports', '5173']);
  assert.deepEqual(one.body.view.exact, [{ port: 5173, label: 'shop', onNew: 'silent' }]);
  const other = await api('POST', '/api/port-rules', { key: 'otherPorts', rule: { onNew: 'ignore' } });
  assert.equal(other.body.where, 'otherPorts');
  assert.deepEqual(other.body.view.rules.at(-1), { key: 'otherPorts', kind: 'otherPorts', rank: 1, rule: { onNew: 'ignore' } });

  const prefs = await loadPrefs();
  assert.deepEqual(prefs.portRules, { '18891-18899': { label: 'Scratchpad preview', hidden: true } });
  assert.equal(prefs.ports['5173']?.label, 'shop');

  assert.deepEqual((await api('POST', '/api/port-rules', { key: '5173', rule: null })).body.removed, true);
  assert.deepEqual((await api('POST', '/api/port-rules', { key: '18891-18899', rule: null })).body.removed, true);
  assert.deepEqual((await api('POST', '/api/port-rules', { key: '18891-18899', rule: null })).body.removed, false, 'already gone');
  const gone = await api('POST', '/api/port-rules', { key: 'otherPorts', rule: null });
  assert.deepEqual([gone.body.where, gone.body.removed], ['otherPorts', true]);
  const view = (await api('GET', '/api/port-rules')).body;
  assert.deepEqual([view.rules, view.exact, view.problems], [[], [], []]);
});

// ---------- reservations and free ports ----------

test('reservations: create 201, the same owner again 200, a conflict 409, bad owner/port 400; release 200 then 404; GET shows who listens', async () => {
  const made = await api('POST', '/api/reservations', { owner: 'billing@main', port: 6100, note: '  api  ' });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.reservation.port, made.body.reservation.owner, made.body.reservation.note], [6100, 'billing@main', 'api']);
  const again = await api('POST', '/api/reservations', { owner: 'billing@main' });
  assert.deepEqual([again.status, again.body.existing, again.body.reservation.port], [200, true, 6100]);
  assert.deepEqual(await api('POST', '/api/reservations', { owner: 'other', port: 6100 }), { status: 409, body: { error: '6100 is reserved for billing@main' } });
  assert.equal((await api('POST', '/api/reservations', { owner: '', port: 6101 })).status, 400);
  assert.deepEqual(await api('POST', '/api/reservations', { owner: 'x', port: 80 }), { status: 400, body: { error: 'port must be an integer 1024–65535' } });

  const snapshot = async () => ({ ports: [{ port: 6100, listening: true, name: 'node', processes: [{ project: 'billing' }] }] });
  const list = await api('GET', '/api/reservations', undefined, context({ snapshot }));
  const row = list.body.reservations.find((r: any) => r.port === 6100);
  assert.deepEqual(row.listening, { name: 'node', project: 'billing', matchesOwner: true });

  assert.equal((await api('POST', '/api/reservations/6100/release')).status, 200);
  assert.deepEqual(await api('POST', '/api/reservations/6100/release'), { status: 404, body: { error: '6100 is not reserved' } });
});

test('GET /api/free-ports: skips listening and reserved ports; count, preferred and for (that owner\'s reserved ports first)', async () => {
  await listen(3000, 3002);
  // 3001 is the feat worktree's since its dev server started above
  assert.equal((await api('POST', '/api/reservations', { owner: 'cms@main', port: 3005 })).status, 201);
  assert.deepEqual((await api('GET', '/api/free-ports')).body, { ports: [3003] });
  assert.deepEqual((await api('GET', '/api/free-ports?count=3&preferred=8000')).body, { ports: [8000, 8001, 8002] });
  assert.deepEqual((await api('GET', '/api/free-ports?count=2&for=cms@main')).body, { ports: [3005, 3003] });
  assert.equal((await api('GET', '/api/free-ports?count=500')).body.ports.length, 20, 'at most 20');
  await api('POST', '/api/reservations/3005/release');
});

// ---------- 새 기기 and device names ----------

test('새 기기: GET passes the saved settings; ack takes a device key or all; settings take two booleans only', async () => {
  const c = context();
  const view = await api('GET', '/api/known-devices', undefined, c);
  assert.deepEqual(Object.keys(view.body.settings).sort(), ['connections', 'neighbors']);
  for (const key of [undefined, 'all ', 'mac:', 'host:box', 'ts:' + 'x'.repeat(81)]) {
    assert.deepEqual((await api('POST', '/api/known-devices/ack', { key }, c)).status, 400, String(key));
  }
  assert.deepEqual(await api('POST', '/api/known-devices/ack', [], c), { status: 400, body: { error: 'body must be an object' } });
  assert.deepEqual((await api('POST', '/api/known-devices/ack', { key: 'mac:b0:38:6c:0a:0b:07' }, c)).body, { ok: true, acknowledged: 1 });
  assert.deepEqual((await api('POST', '/api/known-devices/ack', { key: 'all' }, c)).body, { ok: true, acknowledged: 3 });
  assert.deepEqual(c.acked, ['mac:b0:38:6c:0a:0b:07', 'all']);

  assert.deepEqual(await api('POST', '/api/known-devices/settings', { loud: true }, c), { status: 400, body: { error: 'unknown field: loud' } });
  assert.deepEqual(await api('POST', '/api/known-devices/settings', { neighbors: 'yes' }, c), { status: 400, body: { error: 'neighbors must be a boolean' } });
  const saved = await api('POST', '/api/known-devices/settings', { neighbors: true }, c);
  assert.equal(saved.body.settings.neighbors, true);
  assert.equal((await api('GET', '/api/known-devices', undefined, c)).body.settings.neighbors, true, 'saved in prefs.json');
  assert.deepEqual(c.invalidated, ['usage', 'usage', 'usage']);
});

test('POST /api/clients/name: checks the body, saves the trimmed name, acknowledges the 새 기기 badge; null clears without one', async () => {
  const c = context();
  assert.deepEqual(await api('POST', '/api/clients/name', { key: 'lan:x', name: 'a' }, c), { status: 400, body: { error: 'key must be mac:xx:xx:xx:xx:xx:xx or ip:<address>' } });
  assert.deepEqual(await api('POST', '/api/clients/name', { key: 'ip:192.168.1.7', name: 'x'.repeat(41) }, c), { status: 400, body: { error: 'name is longer than 40 characters' } });
  assert.deepEqual(await api('POST', '/api/clients/name', { key: 'ip:192.168.1.7', name: 'a', extra: 1 }, c), { status: 400, body: { error: 'unknown field: extra' } });
  assert.deepEqual((await api('POST', '/api/clients/name', { key: 'mac:04:7c:16:0a:0b:03', name: ' 데스크톱 ' }, c)).body, { ok: true, key: 'mac:04:7c:16:0a:0b:03', name: '데스크톱' });
  assert.deepEqual(await loadNames(), { 'mac:04:7c:16:0a:0b:03': '데스크톱' });
  assert.deepEqual((await api('POST', '/api/clients/name', { key: 'mac:04:7c:16:0a:0b:03', name: null }, c)).body.name, null);
  assert.deepEqual(await loadNames(), {});
  assert.deepEqual(c.acked, ['mac:04:7c:16:0a:0b:03']);
  assert.deepEqual(c.invalidated, ['usage', 'usage']);
});

// ---------- the rest ----------

test('POST /api/alerts/test passes the checker\'s answer through: 409 when nothing was sent, 200 when it was', async () => {
  assert.deepEqual(await api('POST', '/api/alerts/test'), { status: 409, body: { ok: false, message: 'no channel', sent: [] } });
  const sent = context({ alerts: { test: async () => ({ ok: true, message: 'sent', sent: ['ntfy'] }) } });
  assert.deepEqual(await api('POST', '/api/alerts/test', undefined, sent), { status: 200, body: { ok: true, message: 'sent', sent: ['ntfy'] } });
});

test('GET /api/topology hands ?fresh to the shared cache; GET /api/proxmox/trends takes hour or day only', async () => {
  assert.deepEqual((await api('GET', '/api/topology')).body, { topology: true, fresh: false });
  assert.deepEqual((await api('GET', '/api/topology?fresh')).body, { topology: true, fresh: true });
  assert.deepEqual(await api('GET', '/api/proxmox/trends?timeframe=week'), { status: 400, body: { error: 'timeframe must be hour or day' } });
});

test('worktree writes: only a scanned repo and 1–200 absolute paths; anything else is 400 before git runs', async () => {
  await clearCalls();
  assert.deepEqual(await api('POST', '/api/worktrees/remove', { repo: '/etc', paths: [FEAT] }), { status: 400, body: { error: 'unknown repo' } });
  for (const paths of [[], 'x', ['relative/path'], [FEAT, 3], ['/a\0b'], Array.from({ length: 201 }, (_, i) => `/w/${i}`)]) {
    assert.deepEqual(await api('POST', '/api/worktrees/remove', { repo: MAIN, paths }), { status: 400, body: { error: 'paths must be 1–200 absolute paths' } });
  }
  assert.deepEqual(await api('POST', '/api/worktrees/prune', { repo: join(REPOS, 'nope') }), { status: 400, body: { error: 'unknown repo' } });
  assert.deepEqual(await calls('git'), []);
});

// ---------- the dev-server MCP tools (the routes' checks, before the core) ----------

test('start_dev_server / stop_dev_server / list_dev_servers: argument checks, then the core; failures are isError', async () => {
  const { devServersFeature } = await import('../src/features/devservers.ts');
  const tool = (name: string) => devServersFeature.tools!.find((x) => x.def.name === name)!;
  const seen: unknown[][] = [];
  const core = {
    startDevServer: async (...a: unknown[]) => (seen.push(['start', ...a]), { ok: a[2] !== 4000, message: 'm', port: 4001 }),
    stopDevServer: async (...a: unknown[]) => (seen.push(['stop', ...a]), { ok: true, message: 'stopped' }),
    devServers: async () => ({ running: [], startable: { [MAIN]: { scripts: { dev: 'vite' }, preferred: 'dev', owner: 'shop-web@main' } } }),
  } as any;
  const err = async (name: string, args: unknown) => {
    const r = await tool(name).call(args, core);
    assert.equal(r.isError, true, JSON.stringify(args));
    return r.content[0].text;
  };
  assert.equal(await err('start_dev_server', {}), 'path must be a worktree path');
  assert.equal(await err('start_dev_server', { path: MAIN, script: 1 }), 'script must be a string');
  for (const port of [80, 70000, '5000', 5000.5]) assert.equal(await err('start_dev_server', { path: MAIN, port }), 'port must be 1024–65535');
  assert.equal(await err('stop_dev_server', { path: null }), 'path must be a worktree path');
  assert.deepEqual(seen, [], 'nothing invalid reached the core');

  assert.equal((await tool('start_dev_server').call({ path: MAIN, script: 'dev', port: 5000 }, core)).isError, undefined);
  assert.equal(await err('start_dev_server', { path: MAIN, port: 4000 }), JSON.stringify({ ok: false, message: 'm', port: 4001 }));
  await tool('stop_dev_server').call({ path: FEAT }, core);
  assert.deepEqual(seen, [['start', MAIN, 'dev', 5000], ['start', MAIN, undefined, 4000], ['stop', FEAT]]);
  const list = JSON.parse((await tool('list_dev_servers').call({}, core)).content[0].text);
  assert.deepEqual(list.startable, [{ path: MAIN, owner: 'shop-web@main', scripts: ['dev'], preferred: 'dev' }]);
});
