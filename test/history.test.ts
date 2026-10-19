import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVE_GAP_MS, HistoryStore, emptyHistory, historyView, loadHistory, mergeHistory, parseHistory, prune, record,
  samplesOf, withHistory, type Sample,
} from '../src/core/history.ts';
import type { DeviceCard, Usage, UseRow } from '../src/core/usage.ts';

const T0 = Date.parse('2026-10-17T10:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const mac: Sample = { device: 'dev-mac', name: 'dev-mac', kind: 'tailnet', nameKey: null, port: 22, service: 'SSH', connections: 2 };
const lan: Sample = { device: 'lan:192.168.1.7', name: 'MSI 기기', kind: 'lan', nameKey: 'mac:04:7c:16:0a:0b:03', port: 8790, service: 'Portboard', connections: 1 };

test('record: firstSeen/lastSeen, minutes from the time between samples, a new run after a gap', () => {
  const h = emptyHistory();
  record(h, [mac], T0);
  record(h, [mac], T0 + 30_000);
  record(h, [mac], T0 + 60_000);
  let e = h.entries['dev-mac|22'];
  assert.equal(h.startedAt, T0);
  assert.equal(e.firstSeen, T0);
  assert.equal(e.lastSeen, T0 + 60_000);
  assert.equal(e.activeSince, T0);
  assert.equal(e.samples, 3);
  assert.equal(e.days['2026-10-17'], 1.5); // 30 s for the first sample + 2 × 30 s
  // Requests between loop samples add only the real time in between
  record(h, [mac], T0 + 70_000);
  assert.equal(h.entries['dev-mac|22'].days['2026-10-17'], 1.67);
  // Away for longer than the gap: a new run, credited one nominal sample rather than the whole gap
  record(h, [{ ...mac, connections: 5 }], T0 + 70_000 + ACTIVE_GAP_MS + 1);
  e = h.entries['dev-mac|22'];
  assert.equal(e.activeSince, T0 + 70_000 + ACTIVE_GAP_MS + 1);
  assert.equal(e.firstSeen, T0);
  assert.equal(e.peak, 5);
  assert.equal(e.days['2026-10-17'], 2.17);
  // Same instant twice (cached result recorded again): nothing changes
  record(h, [mac], e.lastSeen);
  assert.equal(h.entries['dev-mac|22'].samples, 5);
});

test('prune keeps 30 days: old day buckets and pairs go, firstSeen is clamped', () => {
  const h = emptyHistory();
  record(h, [mac, lan], T0 - 40 * DAY);
  record(h, [mac], T0 - 40 * DAY + 30_000);
  record(h, [mac], T0 - 2 * DAY);
  prune(h, T0);
  assert.equal(h.entries['lan:192.168.1.7|8790'], undefined);
  const e = h.entries['dev-mac|22'];
  assert.deepEqual(Object.keys(e.days), ['2026-10-15']);
  assert.equal(e.firstSeen, T0 - 30 * DAY);
  assert.equal(h.startedAt, T0 - 30 * DAY);
});

test('mergeHistory takes min firstSeen, max lastSeen and the max of each counter (two observers, no double count)', () => {
  const a = emptyHistory();
  const b = emptyHistory();
  record(a, [mac], T0);
  record(a, [mac], T0 + 30_000);
  record(b, [mac], T0 + 15_000);
  record(b, [mac, lan], T0 + 45_000);
  const m = mergeHistory(a, b);
  const e = m.entries['dev-mac|22'];
  assert.equal(e.firstSeen, T0);
  assert.equal(e.lastSeen, T0 + 45_000);
  assert.equal(e.samples, 2);
  assert.equal(e.days['2026-10-17'], 1); // a: 0.5 + 0.5, b: 0.5 + 0.5 → max, not 2
  assert.ok(m.entries['lan:192.168.1.7|8790']);
  assert.equal(m.startedAt, T0);
  // inputs untouched
  assert.equal(a.entries['lan:192.168.1.7|8790'], undefined);
});

test('parseHistory drops malformed entries instead of failing', () => {
  const h = parseHistory(JSON.stringify({
    startedAt: T0,
    entries: {
      ok: { device: 'x', port: 22, firstSeen: T0, lastSeen: T0, activeSince: T0, days: { '2026-10-17': 1, nope: 3 } },
      bad: { device: 'y', port: 'z', firstSeen: T0 },
      worse: null,
    },
  }));
  assert.deepEqual(Object.keys(h.entries), ['ok']);
  assert.deepEqual(h.entries.ok.days, { '2026-10-17': 1 });
  assert.equal(h.entries.ok.nameKey, null);
  assert.deepEqual(parseHistory('{not json').entries, {});
});

test('HistoryStore: throttled atomic writes that merge with what another process wrote', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-hist-'));
  const path = join(dir, 'state', 'usage-history.json');
  const store = await new HistoryStore(path, 60_000).open(T0);
  store.record([mac], T0 + 1000); // within the throttle window: memory only
  await new Promise((r) => setImmediate(r));
  await assert.rejects(readFile(path, 'utf8'));

  // Another Portboard wrote a pair meanwhile
  const other = emptyHistory();
  record(other, [lan], T0 + 500);
  await mkdir(join(dir, 'state'), { recursive: true });
  await writeFile(path, JSON.stringify(other));

  await store.flush(T0 + 2000);
  const disk = parseHistory(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(disk.entries).sort(), ['dev-mac|22', 'lan:192.168.1.7|8790']);
  assert.deepEqual(await readdir(join(dir, 'state')), ['usage-history.json']); // no tmp left behind

  // Past the throttle window, record() writes by itself
  store.record([mac], T0 + 62_000 + 1000);
  await store.flush();
  const again = await loadHistory(path, T0 + 70_000);
  assert.equal(again.entries['dev-mac|22'].lastSeen, T0 + 63_000);
  // A fresh process picks it all up
  const reopened = await new HistoryStore(path).open(T0 + 70_000);
  assert.equal(reopened.data.entries['lan:192.168.1.7|8790'].name, 'MSI 기기');
});

function use(port: number, over: Partial<UseRow> = {}): UseRow {
  return {
    port, service: `svc${port}`, fullName: `svc${port}`, kind: 'app', url: null, via: 'direct', servePort: null,
    connections: 1, bytesSent: 0, bytesReceived: 0, rttMs: null, since: '2026-10-17T12:00:00.000Z', processes: [], routed: false,
    ...over,
  };
}

function card(id: string, uses: UseRow[], over: Partial<DeviceCard> = {}): DeviceCard {
  return {
    id, name: id, nameSource: 'tailscale', kind: 'tailnet', os: null, vendor: null, mac: null, randomMac: false,
    networks: [], addresses: [], tailscaleIps: [], lanIps: [], online: true, lastSeen: null, path: null, pool: null,
    poolMatch: null, nameKey: null, lanVia: {}, routes: [], virt: null, guestOf: null, pveHost: null,
    uses, connections: uses.reduce((a, u) => a + u.connections, 0), bytes: 0, ...over,
  } as DeviceCard;
}

function usageOf(cards: DeviceCard[], local: UseRow[] = []): Usage {
  return {
    at: '2026-10-17T12:00:00.000Z', observingSince: '2026-10-17T12:00:00.000Z', cards,
    local: { connections: local.length, uses: local }, byPort: {}, idleServices: 0, idle: [],
    pool: { available: false, source: null, url: '', healthAt: null } as Usage['pool'], selfLanIps: [],
    proxmox: { configured: false, ok: false, hosts: 0 },
  } as Usage;
}

test('samplesOf: one sample per device and port; routed traffic and local processes under their own keys', () => {
  const u = usageOf(
    [
      card('mac', [use(22, { connections: 2 }), use(8790, { via: 'serve' }), use(8790)]),
      card('pve1', [use(22, { routed: true, connections: 3 })], { kind: 'lan', name: 'pve1', nameKey: 'mac:50:81:40:0a:0b:01' }),
    ],
    [use(7720)],
  );
  const s = samplesOf(u);
  assert.deepEqual(
    s.map((x) => `${x.device}|${x.port}×${x.connections}`).sort(),
    ['local|7720×1', 'mac|22×2', 'mac|8790×2', 'pve1~routed|22×3'],
  );
  assert.equal(s.find((x) => x.device === 'pve1~routed')!.name, 'pve1 경유');
  assert.equal(s.find((x) => x.device === 'pve1~routed')!.nameKey, null);
});

test('withHistory: since moves back to the persisted run start; views list last use and the last 7 days', () => {
  const h = emptyHistory();
  record(h, [mac], T0 - 10 * DAY); // an old run
  record(h, [mac], T0); // a new run starts
  for (let t = T0 + 30_000; t <= T0 + 2 * 3600_000; t += 30_000) record(h, [mac], t);
  record(h, [lan], T0 + 3600_000);
  const now = T0 + 2 * 3600_000;
  const u = usageOf([card('dev-mac', [use(22, { since: new Date(now - 60_000).toISOString() })])]);
  const w = withHistory(u, h, now);
  const row = w.cards[0].uses[0];
  assert.equal(row.since, new Date(T0).toISOString()); // not the restart time
  assert.equal(row.activeSince, new Date(T0).toISOString());
  assert.equal(row.firstSeen, new Date(T0 - 10 * DAY).toISOString());

  const v = w.history;
  assert.equal(v.byPort[22].name, 'dev-mac');
  assert.equal(v.byPort[8790].at, new Date(T0 + 3600_000).toISOString());
  assert.equal(v.byPort[8790].name, 'MSI 기기');
  const recent = v.byDevice['dev-mac'].recent;
  assert.equal(recent.length, 1);
  assert.equal(recent[0].minutes, 120.5); // the 10-day-old minute is outside the window
  assert.equal(v.byDevice['lan:192.168.1.7'].nameKey, 'mac:04:7c:16:0a:0b:03');
  // A use the history doesn't know keeps its own since
  const fresh = withHistory(usageOf([card('x', [use(5000)])]), h, now).cards[0].uses[0];
  assert.equal(fresh.since, '2026-10-17T12:00:00.000Z');
  assert.equal(fresh.activeSince, null);
  assert.equal(historyView(emptyHistory(), now).startedAt, null);
});
