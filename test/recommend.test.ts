import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MachineStatus } from '../src/core/machines.ts';
import { DEFAULT_WEIGHTS, elsewhereOf, findWorktree, sameRepo, weightsOf, whereToRun } from '../src/core/recommend.ts';
import type { WorktreeBrief } from '../src/core/worktrees.ts';
import { t } from '../src/core/i18n.ts';

// where_to_run / find_worktree (docs/multi-host.md): exclusions, the score's terms and the conflict text, over a
// fixed machine list. The reasons are compared through t(), so the file runs in either language.

const NOW = Date.parse('2026-10-22T05:00:00Z');
const at = (agoSec: number) => new Date(NOW - agoSec * 1000).toISOString();

const wt = (over: Partial<WorktreeBrief>): WorktreeBrief => ({
  owner: 'shop-web@feat-map',
  repo: 'shop-web',
  remote: 'c10dev/shop-web',
  branch: 'feat-map',
  path: '~/projects/shop-web/.claude/worktrees/feat-map',
  main: false,
  dirty: 0,
  lastCommit: '2026-10-21T09:12:00Z',
  inUse: false,
  claude: true,
  reservedPort: 4105,
  ...over,
});

const machine = (over: Partial<MachineStatus>): MachineStatus => ({
  id: 'vocado-dev',
  name: 'vocado-dev',
  kind: 'linux',
  reach: 'local',
  online: true,
  checkedAt: at(2),
  stale: false,
  error: null,
  load: { cores: 16, load1: 3.2, memTotalMb: 64000, memAvailMb: 31000, diskFreePct: 41, uptimeSec: 1 },
  claude: { cliVersion: '2.1.299', active: 2, idle: 1, source: 'proc', sessions: [] },
  worktrees: [wt({}), wt({ owner: 'shop-web@main', branch: 'main', path: '~/projects/shop-web', main: true, claude: false, reservedPort: null })],
  ports: { listening: 27, devServers: 2 },
  capabilities: ['linux', 'systemd', 'dev-servers', 'always-on'],
  maxSessions: 4,
  launch: [{ via: 'local', note: '' }, { via: 'desktop-ssh', note: '' }],
  ...over,
});

const vocado = machine({});
const mac = machine({
  id: 'mac',
  name: 'mac',
  kind: 'mac',
  reach: 'agent',
  checkedAt: at(8),
  load: { cores: 10, load1: 2, memTotalMb: 32000, memAvailMb: 12000, diskFreePct: 30, uptimeSec: 1 },
  claude: { cliVersion: '2.1.299', active: 1, idle: 0, source: 'ps', sessions: [{ id: '9f8e7d6c', project: 'shop-web', worktree: 'shop-web@feat-map', idleMin: 0, cpuPct: null, mb: null, startedAt: null, idle: false }] },
  worktrees: [wt({ path: null, main: true, dirty: 5, inUse: true, claude: false, reservedPort: null })],
  capabilities: ['macos'],
  maxSessions: 2,
  launch: [{ via: 'remote-control', note: '' }],
});
const desktop = machine({ id: 'desktop', name: 'desktop', kind: 'wsl', reach: 'agent', online: false, checkedAt: null, stale: true, claude: null, worktrees: null, launch: [{ via: 'desktop-ssh', note: '' }] });
const cloud = machine({ id: 'cloud', name: 'cloud', kind: 'cloud', reach: 'none', checkedAt: null, load: null, claude: null, worktrees: null, ports: null, capabilities: ['sandbox', 'parallel', 'isolated'], maxSessions: null, launch: [{ via: 'cloud', note: '' }] });
const ALL = [vocado, mac, desktop, cloud];

test('whereToRun: the clean worktree on the roomy machine wins; cloud and the busy Mac are alternatives; offline excluded', () => {
  const r = whereToRun({ repo: 'shop-web', branch: 'feat-map', needs: ['dev-server'] }, ALL, { now: NOW });
  assert.equal(r.recommendation?.machine, 'vocado-dev');
  assert.ok(r.recommendation!.why.some((w) => w.includes('shop-web@feat-map')));
  assert.ok(r.recommendation!.why.some((w) => w.includes('4105')));
  assert.equal(r.recommendation!.how.via, 'local');
  assert.equal(r.recommendation!.how.cwd, '~/projects/shop-web/.claude/worktrees/feat-map');
  assert.ok(r.recommendation!.how.steps.some((s) => s.includes('start_dev_server')));
  // the Mac: a dev server needs dev-servers (systemd), so it is out; desktop is offline
  assert.deepEqual(r.excluded.map((x) => x.machine).sort(), ['desktop', 'mac']);
  assert.deepEqual(r.alternatives.map((x) => x.machine), ['cloud']);
  assert.ok(r.recommendation!.score > r.alternatives[0].score, `${r.recommendation!.score} > ${r.alternatives[0].score}`);
  assert.ok(r.alternatives[0].caveats.some((c) => c.includes('tailnet')));
  // vocado-dev is told the branch has uncommitted changes on the Mac
  assert.ok(r.recommendation!.caveats.some((c) => c.includes('mac')));
});

test('whereToRun: conflicts cost the Mac its locality; prefer and exclude move the answer', () => {
  const r = whereToRun({ repo: 'shop-web', branch: 'feat-map' }, [vocado, mac, cloud], { now: NOW });
  const m = r.alternatives.find((x) => x.machine === 'mac')!;
  assert.ok(m.caveats.includes(t('machinesMsg.caveat.sessionHere', { owner: 'shop-web@feat-map', n: 1 })), m.caveats.join(' | '));
  assert.ok(m.caveats.includes(t('machinesMsg.caveat.controlSeat')));
  assert.ok(m.score < r.recommendation!.score);
  const preferred = whereToRun({ repo: 'shop-web', branch: 'feat-map', prefer: 'cloud' }, [vocado, cloud], { now: NOW, weights: { prefer: 0.5 } });
  assert.equal(preferred.recommendation?.machine, 'cloud');
  const ex = whereToRun({ repo: 'shop-web', branch: 'feat-map', exclude: ['vocado-dev'] }, [vocado, cloud], { now: NOW });
  assert.equal(ex.recommendation?.machine, 'cloud');
  assert.equal(ex.excluded[0].machine, 'vocado-dev');
});

test('whereToRun: needs filter (macos, docker), stale data excluded, parallel favours the cloud, nothing left → null', () => {
  assert.equal(whereToRun({ needs: ['macos'] }, ALL, { now: NOW }).recommendation?.machine, 'mac');
  const docker = whereToRun({ needs: ['docker'] }, ALL, { now: NOW });
  assert.equal(docker.recommendation, null);
  assert.ok(docker.excluded.some((x) => x.machine === 'vocado-dev' && x.reason.includes('docker')));
  const old = whereToRun({}, [machine({ checkedAt: at(600) })], { now: NOW });
  assert.equal(old.recommendation, null);
  assert.equal(old.excluded[0].reason, t('machinesMsg.excluded.stale'));
  const par = whereToRun({ needs: ['parallel'] }, [machine({ worktrees: [] }), cloud], { now: NOW });
  assert.ok(par.recommendation, 'something is recommended');
  const cloudRow = [par.recommendation!, ...par.alternatives].find((x) => x.machine === 'cloud')!;
  assert.ok(cloudRow.why.includes(t('machinesMsg.why.isolated')));
});

test('whereToRun: ties go to the fresher data, then list order', () => {
  const a = machine({ id: 'a', name: 'a', checkedAt: at(30) });
  const b = machine({ id: 'b', name: 'b', checkedAt: at(3) });
  assert.equal(whereToRun({}, [a, b], { now: NOW }).recommendation?.machine, 'b');
  const c = machine({ id: 'c', name: 'c', checkedAt: at(3) });
  assert.equal(whereToRun({}, [c, b], { now: NOW }).recommendation?.machine, 'c');
});

test('weightsOf: known names only, over the defaults', () => {
  assert.deepEqual(weightsOf({}), DEFAULT_WEIGHTS);
  const w = weightsOf({ mac: -0.3, bogus: 1 });
  assert.equal(w.mac, -0.3);
  assert.equal((w as Record<string, number>).bogus, undefined);
});

test('sameRepo: folder name or GitHub owner/name, any case', () => {
  assert.ok(sameRepo({ repo: 'shop-web', remote: null }, 'Shop-Web'));
  assert.ok(sameRepo({ repo: 'sw', remote: 'c10dev/shop-web' }, 'shop-web'));
  assert.ok(sameRepo({ repo: 'sw', remote: 'c10dev/shop-web' }, 'c10dev/shop-web'));
  assert.ok(!sameRepo({ repo: 'shop', remote: null }, 'shop-web'));
});

test('findWorktree: exact matches first, then the query; conflict when one branch is on two machines with work', () => {
  const r = findWorktree({ repo: 'shop-web', branch: 'feat-map' }, ALL);
  assert.deepEqual(r.matches.map((m) => [m.machine, m.owner, m.dirty, m.inUse]), [
    ['vocado-dev', 'shop-web@feat-map', 0, false],
    ['mac', 'shop-web@feat-map', 5, true],
  ]);
  assert.deepEqual(r.matches[1].activeSession, { id: '9f8e7d6c', idleMin: 0, idle: false });
  assert.ok(r.conflict?.includes('vocado-dev, mac'), r.conflict ?? '');
  const q = findWorktree({ query: 'MAIN' }, ALL);
  assert.deepEqual(q.matches.map((m) => m.owner), ['shop-web@main']);
  assert.equal(q.conflict, null);
  assert.deepEqual(findWorktree({ query: 'feat', machine: 'mac' }, ALL).matches.map((m) => m.machine), ['mac']);
});

test('elsewhereOf: other machines (agents) with changes, a process or an active session on that repo@branch; fresh data only', () => {
  // the Mac: 5 uncommitted files, in use, one active session; vocado-dev is this machine, the desktop never answered
  assert.deepEqual(elsewhereOf('Shop-Web@feat-map', ALL, { now: NOW }), [{ machine: 'mac', dirty: 5, sessions: 1, inUse: true }]);
  assert.deepEqual(elsewhereOf('shop-web@main', ALL, { now: NOW }), []);
  // a clean, idle checkout there is no reason to warn
  const quiet = machine({ ...mac, worktrees: [wt({ dirty: 0, inUse: false })], claude: { ...mac.claude!, sessions: [{ ...mac.claude!.sessions[0], idle: true }] } });
  assert.deepEqual(elsewhereOf('shop-web@feat-map', [quiet], { now: NOW }), []);
  // an active session alone counts, with no checkout listed
  const sessionOnly = machine({ ...mac, worktrees: null });
  assert.deepEqual(elsewhereOf('shop-web@feat-map', [sessionOnly], { now: NOW }), [{ machine: 'mac', dirty: 0, sessions: 1, inUse: false }]);
  // 10 minutes later the Mac's data is too old to warn about
  assert.deepEqual(elsewhereOf('shop-web@feat-map', ALL, { now: NOW + 10 * 60_000 }), []);
});
