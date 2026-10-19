import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverride, chooseUnits, decide, evaluate, listPaths, parseArgs, parseDeployed, planRestart, unitsForPath, type DecisionInput } from '../scripts/deploy-plan.ts';
import { describeSecrets, scanSecrets, secretsFrom, statusCheck, unitCheck } from '../scripts/deploy-smoke.ts';

// ---- change detection ----

test('unitsForPath: dashboard, remote, shared and non-runtime paths', () => {
  assert.deepEqual(unitsForPath('src/server.ts'), ['portboard']);
  assert.deepEqual(unitsForPath('public/app.js'), ['portboard']);
  assert.deepEqual(unitsForPath('src/remote.ts'), ['portboard-remote']);
  assert.deepEqual(unitsForPath('src/remote/http.ts'), ['portboard-remote']);
  // feature modules (#21) are loaded by the dashboard too, with src/mcp/ and the remote files they import
  assert.deepEqual(unitsForPath('src/mcp/tools.ts'), ['portboard', 'portboard-remote']);
  assert.deepEqual(unitsForPath('src/remote/redact.ts'), ['portboard', 'portboard-remote']);
  assert.deepEqual(unitsForPath('src/remote/core.ts'), ['portboard', 'portboard-remote']);
  assert.deepEqual(unitsForPath('src/core/devices.ts'), ['portboard', 'portboard-remote']);
  assert.deepEqual(unitsForPath('src/version.ts'), ['portboard', 'portboard-remote']);
  assert.deepEqual(unitsForPath('package.json'), ['portboard', 'portboard-remote']);
  // an unknown folder under src/ (e.g. a future feature module) is never skipped
  assert.deepEqual(unitsForPath('src/features/x.ts'), ['portboard', 'portboard-remote']);
  for (const p of ['src/mcp.ts', 'README.md', 'CHANGELOG.md', 'docs/operations.md', 'test/core.test.ts', 'scripts/deploy.ts', 'menubar/format.mjs', 'bin/portboard-mcp', 'deploy/portboard.service']) {
    assert.deepEqual(unitsForPath(p), [], p);
  }
});

test('planRestart: collects reasons per unit and flags unit files', () => {
  const plan = planRestart(['public/app.js', 'src/server.ts', 'docs/operations.md', 'deploy/portboard-remote.service']);
  assert.deepEqual(plan.units, ['portboard']);
  assert.deepEqual(plan.reasons.portboard, ['public/app.js', 'src/server.ts']);
  assert.deepEqual(plan.reasons['portboard-remote'], []);
  assert.deepEqual(plan.unitFiles, ['deploy/portboard-remote.service']);

  assert.deepEqual(planRestart(['src/remote/oauth.ts']).units, ['portboard-remote']);
  assert.deepEqual(planRestart(['src/core/ss.ts', 'public/x.js']).units, ['portboard', 'portboard-remote']);
  assert.deepEqual(planRestart(['README.md']).units, []);
  assert.deepEqual(planRestart([]).units, []);
});

test('applyOverride: auto follows the diff, the rest replace it', () => {
  const plan = planRestart(['public/app.js']);
  assert.deepEqual(applyOverride(plan, 'auto'), ['portboard']);
  assert.deepEqual(applyOverride(plan, 'all'), ['portboard', 'portboard-remote']);
  assert.deepEqual(applyOverride(plan, 'none'), []);
  assert.deepEqual(applyOverride(plan, 'portboard-remote'), ['portboard-remote']);
});

// ---- smoke evaluation ----

test('evaluate: all ok passes, any failure or no checks fails', () => {
  assert.deepEqual(evaluate([{ name: 'a', ok: true }, { name: 'b', ok: true }]), { ok: true, passed: 2, failed: [] });
  const r = evaluate([{ name: 'a', ok: true }, { name: 'b', ok: false, detail: '500' }]);
  assert.equal(r.ok, false);
  assert.equal(r.passed, 1);
  assert.deepEqual(r.failed.map((c) => c.name), ['b']);
  assert.equal(evaluate([]).ok, false);
});

test('statusCheck: code, size and time; errors keep their message; never the body', () => {
  const ok = statusCheck('/api/ports', { status: 200, text: 'x'.repeat(2048), ms: 12 }, 200);
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, '200 · 2.0KB · 12ms');
  const bad = statusCheck('공개 POST /mcp', { status: 200, text: 'SECRET-BODY', ms: 5 }, 401);
  assert.equal(bad.ok, false);
  assert.match(bad.detail!, /^200 \(기대 401\)/);
  assert.doesNotMatch(bad.detail!, /SECRET-BODY/);
  const err = statusCheck('/api/health', new Error('ECONNREFUSED'), 200);
  assert.deepEqual(err, { name: '/api/health', ok: false, detail: 'ECONNREFUSED' });
});

// ---- secret scan ----

const proxmox = { url: 'https://192.0.2.1:8006', tokenId: 'u@pam!t', secret: '00000000-1111-2222-3333-444444444444', fingerprint: 'AA:BB' };
const alerts = { ntfy: { server: 'https://ntfy.sh', topic: 'made-up-topic-abcdef123456' } };
const remote = { tokens: { ['a'.repeat(64)]: {}, ['b'.repeat(64)]: {} }, clients: {}, approval: null };

test('secretsFrom: proxmox secret, ntfy topic, webhook, remote token hashes; tolerates missing files', () => {
  const s = secretsFrom(proxmox, { ...alerts, webhook: { url: 'https://hooks.example/abc123xyz' } }, remote);
  assert.deepEqual(s.map((x) => x.name), ['proxmox secret', 'ntfy topic', 'webhook url', 'remote token hash', 'remote token hash']);
  assert.equal(describeSecrets(s), 'proxmox secret 1, ntfy topic 1, webhook url 1, remote token hash 2');
  assert.deepEqual(secretsFrom(null, null, null), []);
  assert.deepEqual(secretsFrom({ secret: 'short' }, {}, { approval: null }), []); // too short to be a real secret
  assert.equal(describeSecrets([]), '없음');
});

test('scanSecrets: 0 hits passes; a hit names the kind and the response, never the value', () => {
  const secrets = secretsFrom(proxmox, alerts, remote);
  const clean = scanSecrets([{ where: '/api/devices', text: '{"devices":[]}' }, { where: '/', text: '<html>' }], secrets);
  assert.equal(clean.ok, true);
  assert.equal(clean.detail, '응답 2개 × 비밀값 4개, 0건');

  const leak = scanSecrets([{ where: '/api/devices', text: `{"x":"${alerts.ntfy.topic}","h":"${'b'.repeat(64)}"}` }], secrets);
  assert.equal(leak.ok, false);
  assert.equal(leak.detail, '2건 노출: ntfy topic → /api/devices; remote token hash → /api/devices');
  for (const s of secrets) assert.ok(!leak.detail!.includes(s.value));

  // nothing to compare against is a failure, not a silent pass
  assert.equal(scanSecrets([{ where: '/', text: '' }], []).ok, false);
});

// ---- rollback decision ----

const base: DecisionInput = {
  dryRun: false,
  noPush: false,
  testsOk: true,
  restarted: ['portboard'],
  smoke: { ok: true, passed: 14, failed: [] },
  previous: 'a'.repeat(40),
  head: 'b'.repeat(40),
};
const failing = { ok: false, passed: 13, failed: [{ name: '/api/usage', ok: false }] };

test('decide: success pushes unless --no-push or --dry-run', () => {
  assert.deepEqual(decide(base), { action: 'push' });
  assert.deepEqual(decide({ ...base, noPush: true }), { action: 'done' });
  assert.deepEqual(decide({ ...base, dryRun: true, restarted: [] }), { action: 'done' });
  // nothing restarted (docs-only change) still pushes after the checks pass
  assert.deepEqual(decide({ ...base, restarted: [] }), { action: 'push' });
});

test('decide: failed tests abort before anything restarts', () => {
  const d = decide({ ...base, testsOk: false, restarted: [], smoke: null });
  assert.equal(d.action, 'abort');
});

test('decide: failed smoke after a restart rolls back to the previous deploy', () => {
  assert.deepEqual(decide({ ...base, smoke: failing }), { action: 'rollback', to: 'a'.repeat(40) });
  assert.deepEqual(decide({ ...base, smoke: failing, noPush: true }), { action: 'rollback', to: 'a'.repeat(40) });
});

test('decide: no rollback when it cannot help', () => {
  for (const over of [
    { dryRun: true, restarted: [] }, // dry-run never touches production
    { restarted: [] }, // production was already failing; this deploy did not cause it
    { previous: null }, // nothing to go back to
    { previous: 'b'.repeat(40) }, // same commit
  ] as Partial<DecisionInput>[]) {
    assert.equal(decide({ ...base, smoke: failing, ...over }).action, 'abort', JSON.stringify(over));
  }
});

// ---- state and flags ----

test('parseDeployed: valid record, junk and missing', () => {
  const sha = 'c'.repeat(40);
  assert.deepEqual(parseDeployed(JSON.stringify({ commit: sha, at: '2026-10-18T00:00:00Z', restarted: ['portboard', 'nope'] })), {
    commit: sha,
    at: '2026-10-18T00:00:00Z',
    restarted: ['portboard'],
  });
  assert.equal(parseDeployed(null), null);
  assert.equal(parseDeployed('not json'), null);
  assert.equal(parseDeployed(JSON.stringify({ commit: 'HEAD' })), null);
});

test('parseArgs: flags, --restart forms and errors', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, noPush: false, restart: 'auto', help: false });
  assert.deepEqual(parseArgs(['--dry-run', '--no-push', '--restart', 'remote']), { dryRun: true, noPush: true, restart: 'portboard-remote', help: false });
  assert.equal((parseArgs(['--restart=both']) as { restart: string }).restart, 'all');
  assert.equal(typeof parseArgs(['--restart']), 'string');
  assert.equal(typeof parseArgs(['--restart=x']), 'string');
  assert.equal(typeof parseArgs(['--force']), 'string');
});

test('listPaths: shortens long lists', () => {
  assert.equal(listPaths(['a', 'b']), 'a, b');
  assert.equal(listPaths(['a', 'b', 'c', 'd', 'e']), 'a, b, c 외 2개');
});

test('unitCheck: active and not restarted by systemd during the checks', () => {
  assert.deepEqual(unitCheck('portboard', 0, { state: 'active', restarts: 0 }), { name: 'portboard 유닛', ok: true, detail: 'active' });
  assert.equal(unitCheck('portboard', 0, { state: 'activating', restarts: 0 }).ok, false);
  const crashed = unitCheck('portboard-remote', 2, { state: 'active', restarts: 3 });
  assert.equal(crashed.ok, false);
  assert.match(crashed.detail!, /1번 죽고/);
  assert.equal(unitCheck('portboard', NaN, { state: 'active', restarts: NaN }).ok, true); // counter unavailable
});

test('chooseUnits: trusts deployed.json, restarts both when the running commit is unknown', () => {
  const plan = planRestart(['README.md']);
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  assert.deepEqual(chooseUnits({ plan, restart: 'auto', previous: a, head: b, guessed: false }), { units: [] });
  assert.deepEqual(chooseUnits({ plan, restart: 'auto', previous: b, head: b, guessed: false }), { units: [] }); // recorded: re-run is a no-op
  assert.deepEqual(chooseUnits({ plan, restart: 'auto', previous: a, head: b, guessed: true }).units, []); // origin/main behind HEAD: diff is fine
  const firstRun = chooseUnits({ plan, restart: 'auto', previous: b, head: b, guessed: true }); // pushed by hand before the first run
  assert.deepEqual(firstRun.units, ['portboard', 'portboard-remote']);
  assert.match(firstRun.note!, /deployed.json 없음/);
  assert.deepEqual(chooseUnits({ plan, restart: 'auto', previous: null, head: b, guessed: false }).units, ['portboard', 'portboard-remote']);
  assert.deepEqual(chooseUnits({ plan, restart: 'none', previous: b, head: b, guessed: true }), { units: [] }); // explicit override wins
});
