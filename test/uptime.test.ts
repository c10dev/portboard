import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codeOf,
  detail,
  emptyUptime,
  loadUptime,
  MAX_SEGMENTS,
  outages,
  parseUptime,
  prune,
  recentChecks,
  recordCheck,
  RETENTION_MS,
  slots,
  stats,
  summary,
  UptimeStore,
  type Code,
  type Uptime,
} from '../src/core/uptime.ts';
import { createChecker, type CheckerDeps, type PortView } from '../src/core/alerts.ts';

const T0 = Date.parse('2026-10-17T00:00:00Z');
const S = 30_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** One check every 30 s from `start`, codes in order */
function feed(u: Uptime, port: number, start: number, codes: string): number {
  let t = start;
  for (const c of codes) {
    recordCheck(u, port, t, c as Code);
    t += S;
  }
  return t - S;
}

test('recordCheck: same result extends the run, a change or a long gap opens a new segment', () => {
  const u = emptyUptime();
  feed(u, 8780, T0, 'uuuuddu');
  assert.deepEqual(u.ports[8780], [
    [T0, T0 + 3 * S, 'u'],
    [T0 + 4 * S, T0 + 5 * S, 'd'],
    [T0 + 6 * S, T0 + 6 * S, 'u'],
  ]);
  recordCheck(u, 8780, T0 + 6 * S, 'd'); // same instant again: ignored
  recordCheck(u, 8780, T0 + 5 * S, 'd'); // clock went back: ignored
  assert.equal(u.ports[8780].length, 3);
  recordCheck(u, 8780, T0 + 6 * S + 10 * MIN, 'u'); // Portboard was off for 10 minutes
  assert.equal(u.ports[8780].length, 4);
});

test('codeOf: quiet window wins over down, http vs listen reasons', () => {
  assert.equal(codeOf({ ok: true }, T0, T0 + MIN), 'u');
  assert.equal(codeOf({ ok: false, reason: 'listen' }, T0, T0 + MIN), 'q');
  assert.equal(codeOf({ ok: false, reason: 'listen' }, T0, 0), 'd');
  assert.equal(codeOf({ ok: false, reason: 'http' }, T0), 'h');
});

test('stats: up / (up + down), quiet and unchecked time left out, null when nothing was checked', () => {
  const u = emptyUptime();
  // 1 h up (120 checks), then 2 checks down (1 min), then up again for 59 min
  const end = feed(u, 1, T0, `${'u'.repeat(120)}dd${'u'.repeat(118)}`);
  const s = stats(u.ports[1], T0, end + S, end + S);
  assert.equal(s.downMs, MIN);
  assert.equal(s.upMs, 119 * MIN);
  assert.equal(s.pct, 99.16); // floor, so a down minute never rounds up to 100
  assert.equal(stats(u.ports[1], T0 - DAY, T0 - HOUR).pct, null);

  // Quiet (restart from Portboard) counts neither way; a gap (Portboard off) isn't down
  const q = emptyUptime();
  feed(q, 2, T0, 'uuqqqquu');
  feed(q, 2, T0 + HOUR, 'uu');
  const sq = stats(q.ports[2], T0, T0 + 2 * HOUR, T0 + 2 * HOUR);
  assert.equal(sq.pct, 100);
  assert.equal(sq.quietMs, 4 * S);
  assert.equal(sq.coveredMs, 10 * S);
});

test('slots / recentChecks: worst state per slot, - where nothing was checked, last slot = last check', () => {
  const u = emptyUptime();
  const last = feed(u, 3, T0, 'uuuudquu');
  assert.equal(recentChecks(u.ports[3], last + 5_000, 10), '--uuuudquu');
  // 10 minutes later with no checks (Portboard stopped): the bar ends now, everything recent is unknown
  assert.equal(recentChecks(u.ports[3], last + 10 * MIN, 5), '-----');
  // checks a second late or early still count once each; a 3-minute gap shows as missed checks
  const j = emptyUptime();
  for (const [t, c] of [[0, 'u'], [29_400, 'd'], [60_200, 'd'], [89_700, 'd'], [120_400, 'u'], [300_400, 'u']] as const) recordCheck(j, 1, T0 + t, c);
  assert.equal(recentChecks(j.ports[1], T0 + 301_000, 12), '-udddu-----u');
  const big = slots(u.ports[3], T0 + 4 * MIN, 2, 2 * MIN);
  assert.deepEqual(big.map((x) => x.state), ['up', 'down']);
  assert.equal(big[1].pct, 66.66); // d q u u: 60 s up, 30 s down, quiet ignored
});

test('outages: merged across quiet, split by a gap, open while still down', () => {
  const u = emptyUptime();
  feed(u, 4, T0, 'uudqdduu');
  const past = outages(u.ports[4], T0 + 10 * MIN);
  assert.equal(past.length, 1);
  assert.deepEqual(past[0], { from: new Date(T0 + 2 * S).toISOString(), to: new Date(T0 + 6 * S).toISOString(), minutes: 2, reason: 'listen' });

  const last = feed(u, 4, T0 + HOUR, 'uhhh');
  const now = outages(u.ports[4], last + 10_000);
  assert.equal(now.length, 2);
  assert.equal(now[0].to, null);
  assert.equal(now[0].reason, 'http');
  // the checker stopped while it was down: no longer "still down", the outage ends where checking ended
  assert.notEqual(outages(u.ports[4], last + HOUR)[0].to, null);
});

test('prune: 30-day retention trims and drops, MAX_SEGMENTS keeps the newest', () => {
  const u = emptyUptime();
  feed(u, 5, T0, 'uud');
  feed(u, 6, T0 + 40 * DAY, 'u');
  u.ports[7] = [[T0, T0 + 40 * DAY, 'u']];
  prune(u, T0 + 41 * DAY);
  assert.equal(u.ports[5], undefined);
  assert.deepEqual(u.ports[7], [[T0 + 41 * DAY - RETENTION_MS, T0 + 40 * DAY, 'u']]);
  const f = emptyUptime();
  feed(f, 8, T0, 'ud'.repeat(MAX_SEGMENTS));
  prune(f, T0 + DAY);
  assert.equal(f.ports[8].length, MAX_SEGMENTS);
  assert.equal(f.ports[8].at(-1)![2], 'd');
});

test('parseUptime: hostile or torn files give an empty or partial store, never a throw', () => {
  for (const bad of ['', '{', 'null', '[]', '{"ports": []}', '{"ports": {"x": 1}}']) assert.deepEqual(parseUptime(bad), emptyUptime());
  const u = parseUptime(JSON.stringify({
    version: 1,
    ports: {
      8780: [[1, 2, 'u'], [3, 2, 'u'], [4, 5, 'z'], [2, 9, 'd'], [10, 11, 'd'], 'junk'],
      99999: [[1, 2, 'u']],
      '01': [[1, 2, 'u']],
    },
  }));
  assert.deepEqual(u, { version: 1, ports: { 8780: [[1, 2, 'u'], [10, 11, 'd']] } });
});

test('summary / detail: 24 h and 7 d %, coverage, bars of the right size, null for an unchecked port', () => {
  const u = emptyUptime();
  const last = feed(u, 9, T0, `${'u'.repeat(58)}dd`); // 30 minutes, the last minute down
  const now = last + 5_000;
  const s = summary(u, 9, now)!;
  assert.equal(s.checks, `${'u'.repeat(28)}dd`);
  // 58 checks up = 29 min; down from the first d until now = 35 s
  assert.equal(s.pct24h, 98.02);
  assert.ok(s.covered24hMs < 31 * MIN);
  assert.equal(summary(u, 10, now), null);
  const d = detail(u, 9, now)!;
  assert.equal(d.day.length, 48);
  assert.equal(d.month.length, 30);
  assert.equal(d.day.at(-1)!.state, 'down');
  assert.equal(d.outages[0].to, null);
});

test('UptimeStore: records only port observations, throttles writes, flush is atomic and reloadable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portboard-uptime-'));
  const path = join(dir, 'state', 'uptime.json');
  const store = await new UptimeStore(path, 60_000).open(T0);
  store.record([{ key: 'port:8780', ok: true }, { key: 'device:iphone', ok: false }], T0 + S);
  await assert.rejects(readFile(path, 'utf8')); // throttled: nothing written yet
  store.record([{ key: 'port:8780', ok: false, reason: 'listen' }], T0 + 2 * S, { 8780: T0 + 2 * MIN });
  store.record([{ key: 'port:8780', ok: false, reason: 'http' }], T0 + 2 * MIN + S);
  await store.flush(T0 + 2 * MIN + S);
  const disk = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(disk.ports), ['8780']);
  assert.deepEqual(disk.ports[8780].map((s: unknown[]) => s[2]), ['u', 'q', 'h']);
  const again = await loadUptime(path, T0 + 3 * MIN);
  assert.deepEqual(again.ports[8780], store.data.ports[8780]);

  await writeFile(path, '{torn');
  assert.deepEqual(await loadUptime(path), emptyUptime());
});

test('checker → record: every check of watched ports, also without a channel; skipped when ss returned nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portboard-uptime-checker-'));
  const clock = { t: T0 };
  let views: PortView[] = [{ port: 8780, listening: true, name: 'uploader', scope: 'loopback', addresses: ['127.0.0.1'], probe: { http: true } }];
  const store = new UptimeStore(join(dir, 'uptime.json'));
  const deps: CheckerDeps = {
    ports: async () => views,
    devices: async () => [],
    watched: async () => ({ ports: { 8780: {}, 5281: {} }, devices: [] }),
    channel: async () => null,
    send: async () => [],
    now: () => clock.t,
    statePath: join(dir, 'alerts-state.json'),
    quietPath: join(dir, 'quiet.json'),
    logPath: join(dir, 'alerts.jsonl'),
    record: (obs, t, quiet) => store.record(obs, t, quiet),
  };
  const c = createChecker(deps);
  await c.tick();
  clock.t += S;
  views = [];
  await c.tick(); // ss failed: no observation, no record
  clock.t += S;
  views = [{ port: 9999, listening: true, name: 'other', scope: 'loopback', addresses: ['127.0.0.1'], probe: null }];
  await c.tick();
  assert.deepEqual(store.data.ports[8780], [[T0, T0, 'u'], [T0 + 2 * S, T0 + 2 * S, 'd']]);
  assert.deepEqual(store.data.ports[5281], [[T0, T0 + 2 * S, 'd']]);
});

test('checker without a channel still learns which ports speak HTTP: a listening port that stops answering records h', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portboard-uptime-http-'));
  const clock = { t: T0 };
  let probe: { http: boolean } | null = { http: true };
  const store = new UptimeStore(join(dir, 'uptime.json'));
  const c = createChecker({
    ports: async () => [{ port: 8780, listening: true, name: 'uploader', scope: 'loopback', addresses: ['127.0.0.1'], probe }],
    devices: async () => [],
    watched: async () => ({ ports: { 8780: {} }, devices: [] }),
    channel: async () => null,
    send: async () => [],
    httpOk: async () => false,
    now: () => clock.t,
    statePath: join(dir, 'alerts-state.json'),
    quietPath: join(dir, 'quiet.json'),
    logPath: join(dir, 'alerts.jsonl'),
    record: (obs, t, quiet) => store.record(obs, t, quiet),
  });
  await c.tick();
  probe = { http: false }; // the snapshot's probe gave up, and the checker's own GET / gets nothing
  clock.t += S;
  await c.tick();
  assert.deepEqual(store.data.ports[8780].map((s) => s[2]), ['u', 'h']);
  assert.equal((await c.status()).watching[0].down, false); // no channel: no alert state machine
});
