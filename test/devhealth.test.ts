// 기기 상태 알림 (src/core/devhealth.ts, src/features/devhealth.ts, c10dev/portboard#2): the thresholds file, what
// the devices data shows (failure rate, a running guest off the tailnet, load per core), the per-condition step
// (sustain, reminder, recovery with margin), the messages and digest line, the check with its state file and sends,
// and the SSH readers' pending reason. Neutral names only: hosts desktop/mac, guest nas on node pve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  conditionsView,
  DEFAULT_THRESHOLDS,
  devhealthMessage,
  digestLine,
  emptyState,
  observe,
  parseState,
  parseThresholds,
  stepAll,
  stepCondition,
  type HealthInput,
  type Observation,
} from '../src/core/devhealth.ts';
import { checkOnce, resetForTest, statePath, viewOf } from '../src/features/devhealth.ts';
import { resolvePaths } from '../src/core/paths.ts';
import { readerReason, STALE_AFTER, type SshReadStatus } from '../src/core/sshread.ts';
import type { Message } from '../src/core/alerts.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-19T00:00:00Z');
const th = DEFAULT_THRESHOLDS;

type Dev = HealthInput['devices'][number];
const dev = (over: Partial<Dev> = {}): Dev => ({ id: 'desktop', name: 'desktop', self: false, online: true, lastSeen: null, pool: null, ...over });
const input = (devices: Dev[], guests: HealthInput['proxmox']['hosts'][number]['guests'] = []): HealthInput => ({ devices, proxmox: { hosts: guests.length ? [{ node: 'pve', guests }] : [] } });
const guest = (over: Partial<HealthInput['proxmox']['hosts'][number]['guests'][number]> = {}) => ({ vmid: 101, name: 'nas', status: 'running', template: false, device: 'nas', ...over });

test('thresholds: defaults, valid keys taken, out-of-range and wrong types ignored', () => {
  assert.deepEqual(parseThresholds(null), DEFAULT_THRESHOLDS);
  assert.deepEqual(parseThresholds({ failPct: 70, loadPerCore: 1.5, offlineMin: 0, loadMin: 'x', reminderHours: 1000 }), { ...DEFAULT_THRESHOLDS, failPct: 70, loadPerCore: 1.5 });
});

test('observe: failure rate needs enough runs; the margin decides clear', () => {
  const at = (runs: number, failed: number) => observe(input([dev({ pool: { name: 'desktop', state: 'ok', last24h: { runs, failed } } })]), T0, th).find((o) => o.kind === 'failures')!;
  assert.deepEqual({ ...at(9, 7) }, { key: 'failures:desktop', kind: 'failures', name: 'desktop', breach: true, clear: false, since: null, facts: { runs: 9, failed: 7, pct: 78 } });
  assert.equal(at(4, 4).breach, false, 'under failMinRuns');
  assert.equal(at(4, 4).clear, true, 'too few runs to say anything: clear');
  assert.deepEqual([at(10, 5).breach, at(10, 5).clear], [true, false], 'at the threshold');
  assert.deepEqual([at(20, 9).breach, at(20, 9).clear], [false, false], '45%: between threshold and margin, hold');
  assert.deepEqual([at(10, 4).breach, at(10, 4).clear], [false, true]);
  assert.equal(at(0, 0).clear, true);
});

test('observe: load per core, not for a host the monitor has lost', () => {
  const load = (load1: number, state = 'agent-busy') => observe(input([dev({ id: 'mac', name: 'mac', pool: { name: 'mac', state, load1, cores: 10 } })]), T0, th).find((o) => o.kind === 'load');
  assert.deepEqual(load(32)?.facts, { load1: 32, cores: 10, ratio: 3.2 });
  assert.equal(load(32)?.breach, true);
  assert.deepEqual([load(18)?.breach, load(18)?.clear], [false, false], '1.8× per core: under 2, over the 1.6 margin');
  assert.equal(load(16)?.clear, true);
  assert.equal(load(32, 'agent-away'), undefined, 'stale numbers');
  assert.equal(observe(input([dev({ pool: { name: 'desktop', state: 'ok', load1: 5 } })]), T0, th).length, 0, 'no cores, no last24h: nothing');
});

test('observe: a running guest whose tailnet device is offline, from its lastSeen', () => {
  const seen = new Date(T0 - 40 * MIN).toISOString();
  const [o] = observe(input([dev({ id: 'nas', name: 'nas', online: false, lastSeen: seen })], [guest()]), T0, th);
  assert.deepEqual({ ...o }, { key: 'guest:pve/101', kind: 'guest', name: 'nas', breach: true, clear: false, since: T0 - 40 * MIN, facts: { guest: 'nas', vmid: 101, node: 'pve', device: 'nas' } });
  const stopped = observe(input([dev({ id: 'nas', name: 'nas', online: false })], [guest({ status: 'stopped' })]), T0, th)[0];
  assert.deepEqual([stopped.breach, stopped.clear], [false, true], 'a stopped guest is expected to be offline');
  assert.equal(observe(input([dev({ id: 'nas', name: 'nas', online: false })], [guest()]), T0, th)[0].since, null, 'no lastSeen: from the first sample');
  assert.equal(observe(input([dev({ id: 'srv', self: true })], [guest({ device: 'srv' })]), T0, th).length, 0, 'this server');
  assert.equal(observe(input([], [guest({ device: 'lan:192.168.1.9' })]), T0, th).length, 0, 'LAN-only guest');
  assert.equal(observe(input([dev({ id: 'nas', online: false })], [guest({ template: true })]), T0, th).length, 0, 'template');
});

const obs = (over: Partial<Observation> = {}): Observation => ({ key: 'load:mac', kind: 'load', name: 'mac', breach: true, clear: false, since: null, facts: { load1: 32, cores: 10, ratio: 3.2 }, ...over });

test('step: a load breach warns after loadMin, reminds every reminderHours, recovers after recoverMin clear', () => {
  let st = stepCondition(undefined, obs(), T0, th);
  assert.equal(st.event, null);
  for (let m = 1; m < 15; m++) assert.equal((st = stepCondition(st.next, obs(), T0 + m * MIN, th)).event, null, `minute ${m}`);
  st = stepCondition(st.next, obs(), T0 + 15 * MIN, th);
  assert.equal(st.event, 'warn');
  assert.equal(st.next.breachSince, T0);
  assert.equal(stepCondition(st.next, obs(), T0 + 16 * MIN, th).event, null);
  const remind = stepCondition({ ...st.next, lastSample: T0 + 6 * HOUR + 14 * MIN }, obs(), T0 + 6 * HOUR + 15 * MIN, th);
  assert.equal(remind.event, 'remind');
  // hovering between threshold and margin: neither recovers nor resets
  let s2 = stepCondition(st.next, obs({ breach: false, clear: false }), T0 + 16 * MIN, th);
  assert.deepEqual([s2.event, s2.next.active, s2.next.clearSince], [null, true, null]);
  s2 = stepCondition(s2.next, obs({ breach: false, clear: true }), T0 + 17 * MIN, th);
  assert.equal(s2.next.clearSince, T0 + 17 * MIN);
  for (let m = 18; m < 22; m++) assert.equal((s2 = stepCondition(s2.next, obs({ breach: false, clear: true }), T0 + m * MIN, th)).event, null);
  s2 = stepCondition(s2.next, obs({ breach: false, clear: true }), T0 + 22 * MIN, th);
  assert.equal(s2.event, 'recover');
  assert.deepEqual([s2.next.active, s2.next.breachSince], [false, null]);
});

test('step: a short spike or a gap in the samples does not warn', () => {
  let st = stepCondition(undefined, obs(), T0, th);
  st = stepCondition(st.next, obs({ breach: false, clear: true }), T0 + MIN, th);
  assert.equal(st.next.breachSince, null);
  st = stepCondition(st.next, obs(), T0 + 2 * MIN, th);
  // the server was down 20 minutes: the run starts again
  st = stepCondition(st.next, obs(), T0 + 22 * MIN, th);
  assert.equal(st.event, null);
  assert.equal(st.next.breachSince, T0 + 22 * MIN);
});

test('step: failures warn on the first sample; a guest counts from lastSeen', () => {
  assert.equal(stepCondition(undefined, obs({ key: 'failures:desktop', kind: 'failures' }), T0, th).event, 'warn');
  const g = obs({ key: 'guest:pve/101', kind: 'guest', since: T0 - 29 * MIN });
  assert.equal(stepCondition(undefined, g, T0, th).event, null);
  assert.equal(stepCondition(undefined, { ...g, since: T0 - 30 * MIN }, T0, th).event, 'warn');
});

test('stepAll: events per condition, idle ones not kept, unseen ones kept until forgotten', () => {
  const a = stepAll(emptyState(), [obs({ key: 'failures:desktop', kind: 'failures', name: 'desktop', facts: { runs: 9, failed: 7, pct: 78 } }), obs({ breach: false, clear: true })], T0, th);
  assert.deepEqual(a.events.map((e) => [e.key, e.event]), [['failures:desktop', 'warn']]);
  assert.deepEqual(Object.keys(a.next.conditions), ['failures:desktop']);
  const b = stepAll(a.next, [], T0 + MIN, th);
  assert.ok(b.next.conditions['failures:desktop'], 'not seen this time (pool unreachable): kept');
  assert.deepEqual(Object.keys(stepAll(a.next, [], T0 + 8 * 24 * HOUR, th).next.conditions), [], 'forgotten after a week unseen');
  // recovery carries the state before the step
  let s = a.next;
  for (let m = 1; m <= 6; m++) {
    const r = stepAll(s, [obs({ key: 'failures:desktop', kind: 'failures', name: 'desktop', breach: false, clear: true, facts: { runs: 9, failed: 1, pct: 11 } })], T0 + m * MIN, th);
    s = r.next;
    if (m < 6) assert.equal(r.events.length, 0);
    else {
      assert.deepEqual(r.events.map((e) => e.event), ['recover']);
      assert.equal(r.events[0].since, T0);
      assert.deepEqual(Object.keys(s.conditions), []);
    }
  }
  assert.deepEqual(parseState(JSON.stringify(a.next)), a.next, 'the state file round-trips');
  assert.deepEqual(parseState('{"version": 2}'), emptyState());
  assert.deepEqual(parseState('nope'), emptyState());
});

test('messages: names and numbers, Korean under PORTBOARD_LOCALE=ko, reminder and recovery', () => {
  const st = stepCondition(undefined, obs({ key: 'failures:desktop', kind: 'failures', name: 'desktop', facts: { runs: 9, failed: 7, pct: 78 } }), T0, th).next;
  const warn = devhealthMessage('failures:desktop', 'warn', st, T0, T0);
  assert.equal(warn.key, 'devhealth:failures:desktop');
  assert.equal(warn.kind, 'warning');
  assert.equal(warn.high, true);
  assert.equal(warn.title, 'portboard: desktop 작업 9개 중 7개 실패 (24시간)');
  assert.match(warn.body, /9개 중 7개\(78%\)/);
  const remind = devhealthMessage('failures:desktop', 'remind', st, T0, T0 + 6 * HOUR);
  assert.match(remind.title, /\(계속\)$/);
  assert.equal(remind.high, false);
  const rec = devhealthMessage('failures:desktop', 'recover', st, T0, T0 + 2 * HOUR);
  assert.equal(rec.kind, 'recovered');
  assert.equal(rec.title, 'portboard: desktop 작업 실패 해소');
  const g = devhealthMessage('guest:pve/101', 'warn', { ...st, kind: 'guest', name: 'nas', facts: { guest: 'nas', vmid: 101, node: 'pve', device: 'nas' } }, T0 - 45 * MIN, T0);
  assert.match(g.body, /45분/);
  for (const m of [warn, remind, rec, g]) assert.doesNotMatch(`${m.title} ${m.body}`, /\{\w+\}/, 'every placeholder filled');
});

test('view and digest: active first; a digest line only while alerted and fresh', () => {
  const a = stepAll(emptyState(), [obs({ key: 'failures:desktop', kind: 'failures', name: 'desktop', facts: { runs: 9, failed: 7, pct: 78 } }), obs()], T0, th).next;
  const v = conditionsView(a);
  assert.deepEqual(v.map((c) => [c.key, c.active]), [['failures:desktop', true], ['load:mac', false]]);
  assert.equal(v[1].since, new Date(T0).toISOString());
  assert.equal(v[1].text, '코어 10개에 부하 32 (코어당 3.2)');
  const line = digestLine(a, T0 + MIN);
  assert.deepEqual(line, { problem: true, text: '🖥️ 기기 상태: desktop 24시간 작업 9개 중 7개 실패 (78%)' });
  assert.equal(digestLine(a, T0 + 10 * MIN), null, 'stale');
  assert.equal(digestLine(stepAll(emptyState(), [obs()], T0, th).next, T0), null, 'nothing alerted yet');
});

test('checkOnce: reads, steps, writes the state file, sends only where alerts are on, retries a failed warning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-devhealth-'));
  await writeFile(join(dir, 'devhealth.json'), JSON.stringify({ failPct: 60 }));
  const paths = { ...resolvePaths({ PORTBOARD_STATE_DIR: dir, PORTBOARD_DEVHEALTH: join(dir, 'devhealth.json'), PORTBOARD_ALERT_CHANNEL: join(dir, 'none.json') }, dir), alertsOn: true };
  const data = input([dev({ pool: { name: 'desktop', state: 'ok', last24h: { runs: 9, failed: 7 } } })]);
  const sent: Message[] = [];
  let up = false;
  const send = async (_p: unknown, m: Message) => (sent.push(m), up);
  resetForTest();
  let f = await checkOnce(paths, { read: async () => data, send }, T0);
  assert.equal(sent.length, 1);
  assert.equal(f.conditions['failures:desktop'].active, false, 'nothing got through: not marked sent');
  up = true;
  f = await checkOnce(paths, { read: async () => data, send }, T0 + MIN);
  assert.equal(sent.length, 2);
  assert.equal(f.conditions['failures:desktop'].active, true);
  await checkOnce(paths, { read: async () => data, send }, T0 + 2 * MIN);
  assert.equal(sent.length, 2, 'no repeat');
  const saved = parseState(await readFile(statePath(paths), 'utf8'));
  assert.equal(saved.conditions['failures:desktop'].active, true);
  const view = await viewOf(paths);
  assert.equal(view.thresholds.failPct, 60, 'devhealth.json read');
  assert.equal(view.conditions[0].key, 'failures:desktop');

  // alerts off (a preview): tracked, never sent
  resetForTest();
  const quiet: Message[] = [];
  const off = { ...paths, stateDir: await mkdtemp(join(tmpdir(), 'pb-devhealth-')), alertsOn: false };
  const g = await checkOnce(off, { read: async () => data, send: async (_p, m) => (quiet.push(m), true) }, T0);
  assert.equal(quiet.length, 0);
  assert.equal(g.conditions['failures:desktop'].active, true);
  resetForTest();
});

const status = (over: Partial<SshReadStatus> = {}): SshReadStatus => ({ enabled: true, ok: false, pending: true, checkedAt: null, lastOk: null, error: null, failures: 0, nextAt: null, setupUrl: '', ...over });

test('SSH readers: a pending, off or failing reader says why', () => {
  assert.equal(readerReason(status(), null, T0), '첫 읽기 대기 중');
  assert.equal(readerReason(status(), T0 - 12_000, T0), '첫 읽기 진행 중 (12초)');
  assert.equal(readerReason(status({ pending: false, enabled: false }), null, T0), '설정에서 꺼져 있음');
  assert.equal(readerReason(status({ pending: false, error: 'timeout', nextAt: T0 + 90_000 }), null, T0), 'timeout, 90초 뒤 다시 시도');
  assert.equal(readerReason(status({ pending: false, ok: true }), null, T0), null);
  // ok, but the last good read is past STALE_AFTER: an idle process answers from it while it reads again
  const old = status({ pending: false, ok: true, lastOk: T0 - 34 * 3_600_000 });
  assert.equal(readerReason(old, null, T0), '마지막 성공 읽기 1일 10시간 전, 다음 요청 때 다시 읽어요');
  assert.equal(readerReason(old, T0 - 2_000, T0), '마지막 성공 읽기 1일 10시간 전, 다시 읽는 중 (2초)');
  assert.equal(readerReason(status({ pending: false, ok: true, lastOk: T0 - STALE_AFTER + 1 }), null, T0), null, 'fresh until STALE_AFTER');
  assert.equal(readerReason(status({ pending: false, ok: true, lastOk: T0 - STALE_AFTER }), null, T0), '마지막 성공 읽기 15분 전, 다음 요청 때 다시 읽어요');
});
