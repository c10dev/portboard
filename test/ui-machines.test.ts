// The machine list on the pages (public/lib/machines.js, public/features/where.js): the strip's tone, bars and line,
// which repo@branch is on another machine (the 개발 tab's badge), the machine filter, other machines' checkouts by
// repo, and the 어디서 돌릴까 answer as DOM. Compared through t(), so the file runs in either language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument } from './fixtures/fake-dom.ts';
import { alsoOn, busyCheckouts, elsewhereByOwner, loadPct, machineBits, machineOptions, machineTone, remoteRepos, sameRepo } from '../public/lib/machines.js';
import { t } from '../public/lib/i18n.js';

const NOW = Date.parse('2026-10-22T05:00:00Z');
const at = (agoSec: number) => new Date(NOW - agoSec * 1000).toISOString();

const wt = (over: Record<string, unknown> = {}) => ({
  owner: 'shop-web@feat-map', repo: 'shop-web', remote: 'c10dev/shop-web', branch: 'feat-map', path: null, main: false,
  dirty: 0, lastCommit: at(3600), inUse: false, claude: true, reservedPort: null, ...over,
});

const machine = (over: Record<string, unknown> = {}): any => ({
  id: 'devbox', name: 'devbox', kind: 'linux', reach: 'local', online: true, checkedAt: at(2), stale: false, error: null,
  load: { cores: 8, load1: 2, memTotalMb: 32000, memAvailMb: 16000, diskFreePct: 40, uptimeSec: 1 },
  claude: { cliVersion: '2.1.299', active: 2, idle: 1, source: 'proc', sessions: [] },
  worktrees: [wt({ owner: 'shop-web@main', branch: 'main', main: true, claude: false })],
  ports: { listening: 20, devServers: 2 }, capabilities: ['linux'], maxSessions: 4, launch: [{ via: 'local', note: '' }],
  ...over,
});

const devbox = machine();
const mac = machine({
  id: 'mac', name: 'mac', kind: 'mac', reach: 'agent', checkedAt: at(8),
  claude: { cliVersion: '2.1.299', active: 1, idle: 0, source: 'ps', sessions: [{ id: '9f8e7d6c', project: 'shop-web', worktree: 'shop-web@feat-map', idleMin: 0, cpuPct: null, mb: null, startedAt: null, idle: false }] },
  worktrees: [wt({ dirty: 5, inUse: true }), wt({ owner: 'notes@main', repo: 'notes', remote: null, branch: 'main', main: true })],
  maxSessions: 2,
});
const desktop = machine({ id: 'desktop', name: 'desktop', kind: 'wsl', reach: 'agent', online: false, checkedAt: null, stale: true, claude: null, worktrees: null, load: null });
const cloud = machine({ id: 'cloud', name: 'cloud', kind: 'cloud', reach: 'none', checkedAt: null, load: null, claude: null, worktrees: null, ports: null, maxSessions: null });
const ALL = [devbox, mac, desktop, cloud];

test('loadPct and machineTone: load per core and memory in use; stale warns, offline and cloud are off, a busy box warns', () => {
  assert.deepEqual(loadPct(devbox), { cpu: 25, mem: 50 });
  assert.deepEqual(loadPct(cloud), { cpu: null, mem: null });
  assert.equal(machineTone(devbox), 'ok');
  assert.equal(machineTone(machine({ stale: true })), 'warn');
  assert.equal(machineTone(desktop), 'off');
  assert.equal(machineTone(cloud), 'off');
  assert.equal(machineTone(machine({ load: { ...devbox.load, load1: 7.6 } })), 'warn');
  assert.equal(machineTone(machine({ reach: 'agent', error: 'refused', checkedAt: null })), 'bad');
});

test('machineBits: sessions against maxSessions, idle, checkouts with work, data age when stale', () => {
  assert.deepEqual(machineBits(devbox, NOW), [t('machines.sessions', { active: 2, max: 4 }), t('machines.idle', { n: 1 })]);
  assert.deepEqual(machineBits(mac, NOW), [t('machines.sessions', { active: 1, max: 2 }), t('machines.busyCheckouts', { n: 1 })]);
  assert.deepEqual(machineBits(machine({ stale: true, checkedAt: at(90), claude: null }), NOW), [t('machines.staleFor', { s: 90 })]);
  assert.deepEqual(machineBits(machine({ stale: true, checkedAt: at(240), claude: null }), NOW), [t('machines.staleForMin', { n: 4 })]);
  assert.deepEqual(machineBits(desktop, NOW), [t('machines.offline')]);
  assert.deepEqual(machineBits(cloud, NOW), [t('machines.cloud.line')]);
  assert.deepEqual(busyCheckouts(mac).map((w: any) => w.owner), ['shop-web@feat-map']);
});

test('sameRepo: folder name or GitHub owner/name, any case', () => {
  assert.ok(sameRepo({ name: 'Shop-Web', remote: null }, wt()));
  assert.ok(sameRepo({ name: 'sw', remote: 'git@github.com:C10dev/shop-web.git' }, wt()));
  assert.ok(sameRepo({ name: 'sw', remote: 'https://github.com/c10dev/shop-web' }, wt()));
  assert.ok(!sameRepo({ name: 'sw', remote: 'git@github.com:other/shop-web.git' }, wt()));
  assert.ok(!sameRepo({ name: 'shop', remote: null }, wt()));
});

test('elsewhereByOwner + alsoOn: agents only, keyed by repo@branch; warn with work there, info for a clean copy', () => {
  const e = elsewhereByOwner(ALL);
  assert.deepEqual(e.get('shop-web@feat-map'), [{ machine: 'mac', dirty: 5, inUse: true, sessions: 1, work: true }]);
  assert.equal(e.get('shop-web@main'), undefined, 'this machine is not "elsewhere"');
  const busy = alsoOn(e.get('shop-web@feat-map'))!;
  assert.deepEqual(busy.slice(0, 2), [t('machines.alsoOnBusy', { machines: 'mac' }), 'warn']);
  assert.ok(busy[2].includes(t('machines.dirty', { n: 5 })) && busy[2].includes(t('machines.activeSessions', { n: 1 })), busy[2]);
  assert.deepEqual(alsoOn(e.get('notes@main'))!.slice(0, 2), [t('machines.alsoOn', { machines: 'mac' }), 'info']);
  assert.equal(alsoOn(undefined), null);
});

test('machineOptions and remoteRepos: this machine first, machines with checkouts; their checkouts grouped by repo', () => {
  assert.deepEqual(machineOptions(ALL), [{ value: 'devbox', label: t('machines.thisOne', { name: 'devbox' }) }, { value: 'mac', label: 'mac' }]);
  const r = remoteRepos(ALL);
  assert.deepEqual(r.map((x: any) => [x.machine, x.repo, x.worktrees.length]), [['mac', 'shop-web', 1], ['mac', 'notes', 1]]);
  assert.deepEqual(remoteRepos(ALL, 'desktop'), []);
  assert.equal(remoteRepos(ALL, 'mac').length, 2);
});

test('where answerView: recommendation with why, caveats and how; alternatives; excluded; nothing fits', async () => {
  globalThis.document = new FakeDocument() as any;
  const { answerView, VIA } = await import('../public/features/where.js');
  const text = (nodes: any[]) => nodes.map((n) => n.textContent).join('\n');
  const view = answerView({
    repo: 'shop-web',
    recommendation: { machine: 'devbox', score: 0.81, why: ['shop-web@feat-map is checked out here'], caveats: ['the branch has 5 uncommitted changes on mac'], how: { via: 'desktop-ssh', cwd: '~/projects/shop-web', steps: ['open it'] } },
    alternatives: [{ machine: 'cloud', score: 0.5, why: [], caveats: ['no tailnet'] }],
    excluded: [{ machine: 'desktop', reason: 'offline' }],
    dataAge: {},
  });
  const s = text(view);
  for (const want of [t('where.repoFromTask', { repo: 'shop-web' }), 'devbox', t('where.score', { score: 0.81 }), 'is checked out here', '⚠ the branch has 5', VIA['desktop-ssh'], '~/projects/shop-web', 'open it', 'cloud (0.5) · no tailnet', 'desktop: offline']) {
    assert.ok(s.includes(want), want);
  }
  assert.ok(text(answerView({ recommendation: null, alternatives: [], excluded: [], dataAge: {} })).includes(t('where.none')));
});
