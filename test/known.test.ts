import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNeigh } from '../src/core/clients.ts';
import type { Channel, Message } from '../src/core/alerts.ts';
import {
  acknowledge, cardKey, createTracker, dueAlert, emptyKnown, newDeviceText, observationOf, observe, parseKnown, settle,
  withNewDevices, summary, type KnownStore, type Observation,
} from '../src/core/known.ts';
import { loadPrefs, newDeviceSettings, setNewDevicePrefs, setPortPrefs } from '../src/core/prefs.ts';
import type { DeviceCard, UseRow } from '../src/core/usage.ts';
import { L } from './fixtures/locale.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 17, 12);
const ON = { connections: true, neighbors: false };

function use(port: number, over: Partial<UseRow> = {}): UseRow {
  return {
    port, service: port === 22 ? 'SSH' : `svc${port}`, fullName: `svc${port}`, kind: 'app', url: null, via: 'direct', servePort: null,
    connections: 1, bytesSent: 0, bytesReceived: 0, rttMs: null, since: '2026-10-17T12:00:00.000Z', processes: [], routed: false,
    ...over,
  };
}

function card(id: string, uses: UseRow[], over: Partial<DeviceCard> = {}): DeviceCard {
  return {
    id, name: id, nameSource: 'tailscale', kind: 'tailnet', os: null, vendor: null, mac: null, randomMac: false,
    networks: [], addresses: [], tailscaleIps: [], lanIps: [], online: true, lastSeen: null, path: null, pool: null,
    poolMatch: null, ports: null, nameKey: null, lanVia: {}, routes: [], virt: null, guestOf: null, pveHost: null,
    uses, connections: uses.reduce((a, u) => a + u.connections, 0), bytes: 0, ...over,
  } as DeviceCard;
}

const lan = (ip: string, mac: string | null, uses: UseRow[], over: Partial<DeviceCard> = {}) =>
  card(`lan:${ip}`, uses, { kind: 'lan', name: over.name ?? 'HP 기기', nameSource: 'vendor', mac, vendor: 'HP Inc.', addresses: [ip], lanIps: [ip], nameKey: mac ? `mac:${mac}` : `ip:${ip}`, ...over });

const self = card('devbox', [], { kind: 'self', lanIps: ['192.168.1.205'] });

const NEIGH = parseNeigh([
  '192.168.1.1 dev ens18 lladdr b0:38:6c:0a:0b:07 REACHABLE',
  '192.168.1.201 dev ens18 lladdr 50:81:40:0a:0b:01 STALE',
  '172.18.0.8 dev br-4f2a lladdr 42:c7:ef:0a:0b:08 STALE',
  '172.17.0.2 dev docker0 lladdr 02:42:ac:11:00:02 STALE',
  'fe80::be24:11ff:fec8:3a44 dev ens18 lladdr bc:24:11:0a:0b:04 STALE',
  '192.168.1.203 dev ens18 lladdr bc:24:11:0a:0b:04 STALE',
].join('\n'));
const OUI = new Map([['508140', 'HP Inc.'], ['B0386C', 'EFM Networks']]);

function day1() {
  const cards = [
    self,
    card('dev-mac', [use(22)]),
    card('iphone', []), // in the tailnet, not connected right now
    card('pve1', [use(22, { routed: true })], { lanIps: ['192.168.1.201'] }),
    card('nas', [use(22000)], { mac: 'bc:24:11:0a:0b:04', lanIps: ['192.168.1.203'] }),
  ];
  const history = { byDevice: { 'lan:192.168.1.108': { name: '개인 Wi-Fi 주소 기기', kind: 'lan', nameKey: 'ip:192.168.1.108', lastSeen: '', recent: [] } } };
  return observationOf({ cards, history } as any, NEIGH, OUI, {})!;
}

// ---------- seeding ----------

test('observationOf: neighbours on docker/bridge interfaces and MACs of known tailnet devices are left out', () => {
  const o = day1();
  assert.deepEqual(o.neighbors.map((n) => n.key), ['mac:b0:38:6c:0a:0b:07']);
  assert.equal(o.neighbors[0].name, L('EFM Networks 기기', 'EFM Networks device'));
  // routed traffic is the router's, not a device connecting; the self card is not tracked
  assert.deepEqual(o.connected.map((c) => [c.key, c.service?.name]), [['ts:dev-mac', 'SSH'], ['ts:nas', 'svc22000']]);
  assert.deepEqual(o.present.map((c) => c.key).sort(), ['ip:192.168.1.108', 'ts:dev-mac', 'ts:iphone', 'ts:nas', 'ts:pve1']);
});

test('observationOf refuses a degraded sample: no self card, or LAN connections with an empty neighbour table', () => {
  assert.equal(observationOf({ cards: [card('mac', [use(22)])] }, NEIGH, OUI, {}), null);
  assert.equal(observationOf({ cards: [self, lan('192.168.1.50', null, [use(22)])] }, new Map(), OUI, {}), null);
  assert.ok(observationOf({ cards: [self, card('mac', [use(22)])] }, new Map(), OUI, {}));
});

test('first run seeds everything visible (peers, neighbours, history) and alerts on nothing', () => {
  const s = emptyKnown();
  assert.deepEqual(observe(s, day1(), ON, T0), []);
  assert.equal(s.seededAt, T0);
  assert.deepEqual(Object.keys(s.devices).sort(), ['ip:192.168.1.108', 'mac:b0:38:6c:0a:0b:07', 'ts:dev-mac', 'ts:iphone', 'ts:nas', 'ts:pve1']);
  assert.ok(Object.values(s.devices).every((r) => r.connected === T0 && !r.pending && !r.notify && r.seeded));
  // Day two, same picture plus iphone connecting: still nothing new
  const o = day1();
  o.connected.push({ ...o.present.find((p) => p.key === 'ts:iphone')!, service: { port: 22, name: 'SSH' } });
  assert.deepEqual(observe(s, o, ON, T0 + 1440 * MIN), []);
  assert.deepEqual(dueAlert(s, T0 + 1440 * MIN), []);
});

// ---------- diffing ----------

function seeded(): KnownStore {
  const s = emptyKnown();
  observe(s, day1(), ON, T0);
  return s;
}

// the tailnet devices whose LAN addresses are in NEIGH, idle
const owners = [card('pve1', [], { lanIps: ['192.168.1.201'] }), card('nas', [], { mac: 'bc:24:11:0a:0b:04', lanIps: ['192.168.1.203'] })];
const obsOf = (cards: DeviceCard[], neigh = NEIGH) => observationOf({ cards: [self, ...owners, ...cards] }, neigh, OUI, {})!;

test('a device connecting for the first time becomes pending and is queued for one alert', () => {
  const s = seeded();
  const ev = observe(s, obsOf([lan('192.168.1.50', '50:81:40:aa:bb:cc', [use(22, { connections: 2 })])]), ON, T0 + MIN);
  assert.deepEqual(ev.map((r) => [r.key, r.pending, r.notify, r.service?.port]), [['mac:50:81:40:aa:bb:cc', 'connection', true, 22]]);
  // seen again: not new again
  assert.deepEqual(observe(s, obsOf([lan('192.168.1.50', '50:81:40:aa:bb:cc', [use(22)])]), ON, T0 + 2 * MIN), []);
  // a new tailnet node too
  assert.deepEqual(observe(s, obsOf([card('new-laptop', [use(8790)])]), ON, T0 + 3 * MIN).map((r) => r.key), ['ts:new-laptop']);
});

test('the same MAC on a new IP is the same device; a different MAC on a known IP is a new one', () => {
  const s = seeded();
  observe(s, obsOf([lan('192.168.1.50', '50:81:40:aa:bb:cc', [use(22)])]), ON, T0 + MIN);
  acknowledge(s, 'all');
  assert.deepEqual(observe(s, obsOf([lan('192.168.1.77', '50:81:40:aa:bb:cc', [use(22)])]), ON, T0 + 2 * MIN), []);
  assert.equal(s.devices['mac:50:81:40:aa:bb:cc'].ip, '192.168.1.77');
  assert.deepEqual(observe(s, obsOf([lan('192.168.1.77', '50:81:40:dd:ee:ff', [use(22)])]), ON, T0 + 3 * MIN).map((r) => r.key), ['mac:50:81:40:dd:ee:ff']);
});

test('a LAN device the history knew only by IP is adopted once by the MAC seen at that IP', () => {
  const s = seeded();
  const phone = lan('192.168.1.108', '16:22:4f:0a:0b:06', [use(22)], { name: '개인 Wi-Fi 주소 기기', nameSource: 'ip', vendor: null, nameKey: 'ip:192.168.1.108' });
  assert.deepEqual(observe(s, obsOf([phone]), ON, T0 + MIN), []);
  assert.ok(s.devices['mac:16:22:4f:0a:0b:06']);
  assert.equal(s.devices['ip:192.168.1.108'], undefined);
  // the next different MAC at that IP is new
  const other = { ...phone, mac: '1a:00:00:00:00:01' };
  assert.equal(observe(s, obsOf([other]), ON, T0 + 2 * MIN).length, 1);
});

test('neighbour sightings: recorded silently by default; a later first connection still alerts', () => {
  const s = seeded();
  const neigh = new Map([...NEIGH, ['192.168.1.60', { mac: '50:81:40:11:22:33', state: 'REACHABLE', dev: 'ens18' }]]);
  assert.deepEqual(observe(s, obsOf([], neigh), ON, T0 + MIN), []);
  const r = s.devices['mac:50:81:40:11:22:33'];
  assert.deepEqual([r.neighbor, r.connected, r.pending, r.notify], [T0 + MIN, null, null, false]);
  const ev = observe(s, obsOf([lan('192.168.1.60', '50:81:40:11:22:33', [use(445)])], neigh), ON, T0 + 2 * MIN);
  assert.deepEqual(ev.map((x) => [x.key, x.pending, x.notify]), [['mac:50:81:40:11:22:33', 'connection', true]]);
});

test('neighbour alerts when turned on; the later connection moves the badge but does not alert twice', () => {
  const s = seeded();
  const both = { connections: true, neighbors: true };
  const neigh = new Map([...NEIGH, ['192.168.1.61', { mac: '50:81:40:44:55:66', state: 'REACHABLE', dev: 'ens18' }]]);
  assert.deepEqual(observe(s, obsOf([], neigh), both, T0 + MIN).map((r) => [r.pending, r.notify]), [['neighbor', true]]);
  const list = dueAlert(s, T0 + MIN);
  settle(s, list, 'sent', T0 + MIN);
  observe(s, obsOf([lan('192.168.1.61', '50:81:40:44:55:66', [use(22)])], neigh), both, T0 + 2 * MIN);
  const r = s.devices['mac:50:81:40:44:55:66'];
  assert.deepEqual([r.pending, r.notify, r.notified], ['connection', false, T0 + MIN]);
});

test('connections off: still recorded and badged, nothing queued', () => {
  const s = seeded();
  const ev = observe(s, obsOf([card('new-tab', [use(22)])]), { connections: false, neighbors: false }, T0 + MIN);
  assert.deepEqual(ev.map((r) => [r.pending, r.notify]), [['connection', false]]);
  assert.deepEqual(dueAlert(s, T0 + MIN), []);
});

test('확인 clears the badge and an alert not sent yet; by key, by nameKey, or all', () => {
  const s = seeded();
  observe(s, obsOf([lan('192.168.1.50', '50:81:40:aa:bb:cc', [use(22)]), card('a', [use(22)]), card('b', [use(22)])]), ON, T0 + MIN);
  assert.equal(acknowledge(s, 'mac:50:81:40:aa:bb:cc'), 1);
  assert.equal(s.devices['mac:50:81:40:aa:bb:cc'].notify, false);
  assert.equal(acknowledge(s, 'nope'), 0);
  assert.equal(acknowledge(s, 'all'), 2);
  assert.deepEqual(dueAlert(s, T0 + MIN), []);
  assert.deepEqual(summary(s, ON, true).pending, []);
});

test('withNewDevices marks pending cards (新 badge) by key or card id', () => {
  const s = seeded();
  const fresh = lan('192.168.1.50', '50:81:40:aa:bb:cc', [use(22)]);
  observe(s, obsOf([fresh]), ON, T0 + MIN);
  const out = withNewDevices({ cards: [self, fresh, card('dev-mac', [])] }, summary(s, ON, true));
  assert.deepEqual(out.cards.map((c) => c.newDevice?.scope ?? null), [null, 'connection', null]);
  assert.equal(out.newDevices.pending[0].nameKey, 'mac:50:81:40:aa:bb:cc');
  assert.equal(cardKey(self), null);
});

// ---------- alerts: batching and rate limit ----------

test('rate limit: the first new device alerts at once; later ones wait for the window and go out together', () => {
  const s = seeded();
  observe(s, obsOf([card('one', [use(22)])]), ON, T0 + MIN);
  const first = dueAlert(s, T0 + MIN);
  assert.deepEqual(first.map((r) => r.key), ['ts:one']);
  settle(s, first, 'sent', T0 + MIN);
  assert.equal(s.lastSent, T0 + MIN);

  observe(s, obsOf([card('two', [use(22)])]), ON, T0 + 2 * MIN);
  observe(s, obsOf([lan('192.168.1.50', '50:81:40:aa:bb:cc', [use(445)])]), ON, T0 + 3 * MIN);
  assert.deepEqual(dueAlert(s, T0 + 5 * MIN), [], 'inside the 10-minute window');
  const batch = dueAlert(s, T0 + 11 * MIN);
  assert.deepEqual(batch.map((r) => r.key), ['ts:two', 'mac:50:81:40:aa:bb:cc']);
  const m = newDeviceText(batch, 'https://devbox.example.ts.net');
  assert.equal(m.title, 'portboard: 2 new devices');
  assert.match(m.body, /two \(tailnet\) connected to SSH :22/);
  assert.match(m.body, /HP 기기 \(LAN, HP Inc\.\) connected to svc445 :445/);
  assert.equal(m.click, 'https://devbox.example.ts.net/devices.html');
});

test('a failed send is retried next time; with no channel the queue is dropped, not sent later', () => {
  const s = seeded();
  observe(s, obsOf([card('one', [use(22)])]), ON, T0 + MIN);
  settle(s, dueAlert(s, T0 + MIN), 'failed', T0 + MIN);
  assert.equal(s.lastSent, null);
  assert.equal(dueAlert(s, T0 + MIN + 30_000).length, 1);
  settle(s, dueAlert(s, T0 + 2 * MIN), 'no-channel', T0 + 2 * MIN);
  assert.deepEqual(dueAlert(s, T0 + 60 * MIN), []);
  assert.equal(s.devices['ts:one'].pending, 'connection', 'the badge stays');
});

test('alert text: one device links to its card; names only, never an address or MAC', () => {
  const s = seeded();
  observe(s, obsOf([lan('192.168.1.50', '3a:11:22:33:44:55', [use(22)], { name: '192.168.1.50', nameSource: 'ip', vendor: null })]), ON, T0 + MIN);
  const m = newDeviceText(dueAlert(s, T0 + MIN), 'https://devbox.example.ts.net/');
  assert.equal(m.title, 'portboard: new device — unnamed LAN device');
  assert.equal(m.click, 'https://devbox.example.ts.net/devices.html#lan%3A192.168.1.50');
  assert.equal(`${m.title}\n${m.body}`.includes('192.168'), false);
  assert.equal(`${m.title}\n${m.body}`.includes('3a:11'), false);
  assert.equal(m.kind, 'new-device');
});

test('tracker: persists across restarts, sends one batched alert, logs it, keeps the channel out of the API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portboard-known-'));
  const path = join(dir, 'known-devices.json');
  const logPath = join(dir, 'alerts.jsonl');
  const channel: Channel = { ntfyServer: 'https://ntfy.example', ntfyTopic: 'TOPIC-secret-42', webhookUrl: null };
  const sent: Message[] = [];
  let t = T0;
  const make = () => createTracker({ path, logPath, channel: async () => channel, send: async (_c, m) => { sent.push(m); return [{ channel: 'ntfy', ok: true }]; }, now: () => t, dashboard: null });

  let k = make();
  await k.observe(day1(), ON);
  await k.idle();
  assert.equal(sent.length, 0);
  t += MIN;
  await k.observe(obsOf([card('one', [use(22)]), card('two', [use(80)])]), ON);
  await k.idle();
  assert.deepEqual(sent.map((m) => m.title), ['portboard: 2 new devices']);
  t += MIN;
  await k.observe(obsOf([card('three', [use(22)])]), ON);
  await k.idle();
  assert.equal(sent.length, 1, 'rate limited');

  // restart: same store, the window and the queue survive
  k = make();
  t += 5 * MIN;
  await k.observe(null, ON);
  await k.idle();
  assert.equal(sent.length, 1);
  t += 5 * MIN;
  await k.observe(null, ON);
  await k.idle();
  assert.deepEqual(sent.map((m) => m.title), ['portboard: 2 new devices', 'portboard: new device — three']);

  assert.equal(await k.acknowledge('ts:one'), 1);
  const sum = await k.summary(ON);
  assert.deepEqual(sum.pending.map((p) => p.key).sort(), ['ts:three', 'ts:two']);
  const disk = await readFile(path, 'utf8');
  assert.equal(parseKnown(disk).devices['ts:one'].pending, null);
  const log = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.kind), ['new-device', 'new-device']);
  for (const text of [JSON.stringify(sum), disk, JSON.stringify(log)]) assert.equal(text.includes('TOPIC-secret-42'), false);
});

test('tracker: observe never waits for the channel; a failed send backs off 30 s; alerts off drops the queue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portboard-known-'));
  const channel: Channel = { ntfyServer: 'https://ntfy.example', ntfyTopic: 'T', webhookUrl: null };
  let t = T0;
  let release: () => void = () => {};
  let calls = 0;
  let ok = false;
  const k = createTracker({
    path: join(dir, 'k.json'), logPath: join(dir, 'a.jsonl'), channel: async () => channel, now: () => t, dashboard: null,
    send: async () => { calls++; await new Promise<void>((r) => (release = r)); return [{ channel: 'ntfy', ok }]; },
  });
  await k.observe(day1(), ON);
  // a stuck ntfy: observe() still returns at once
  const events = await k.observe(obsOf([card('one', [use(22)])]), ON);
  assert.equal(events.length, 1);
  assert.equal(calls, 1);
  assert.deepEqual((await k.summary(ON)).pending.map((p) => p.key), ['ts:one']);
  release();
  await k.idle();
  // failed: not retried by the next sample 10 s later, but after 30 s
  t += 10_000;
  await k.observe(null, ON);
  await k.idle();
  assert.equal(calls, 1);
  t += 30_000;
  ok = true;
  await k.observe(null, ON);
  release();
  await k.idle();
  assert.equal(calls, 2);

  const off = createTracker({ path: join(dir, 'off.json'), logPath: join(dir, 'b.jsonl'), channel: async () => channel, now: () => t, alertsOn: false, send: async () => { calls++; return []; } });
  await off.observe(day1(), ON);
  await off.observe(obsOf([card('two', [use(22)])]), ON);
  await off.idle();
  assert.equal(calls, 2, 'nothing sent with alerts off');
  assert.equal(parseKnown(await readFile(join(dir, 'off.json'), 'utf8')).devices['ts:two'].notify, false, 'no backlog for later');
  assert.equal((await off.summary(ON)).pending.length, 1, 'the badge still shows');
});

test('parseKnown drops malformed records', () => {
  const s = parseKnown(JSON.stringify({ seededAt: 5, devices: { 'ts:a': { key: 'ts:a', firstSeen: 1, pending: 'connection' }, 'ts:b': { key: 'ts:x', firstSeen: 1 }, 'zz:c': { key: 'zz:c', firstSeen: 1 }, 'ts:d': { key: 'ts:d' } } }));
  assert.deepEqual(Object.keys(s.devices), ['ts:a']);
  assert.equal(s.devices['ts:a'].pending, 'connection');
  assert.equal(parseKnown('garbage').seededAt, null);
});

test('prefs: newDevices defaults (connections on, neighbours off), survives other writes, stores only non-defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portboard-ndprefs-'));
  const path = join(dir, 'prefs.json');
  assert.deepEqual(newDeviceSettings(await loadPrefs(path)), { connections: true, neighbors: false });
  assert.deepEqual(await setNewDevicePrefs({ neighbors: true }, path), { connections: true, neighbors: true });
  await setPortPrefs(8790, { pinned: true }, path);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).newDevices, { neighbors: true });
  assert.deepEqual(await setNewDevicePrefs({ neighbors: false }, path), { connections: true, neighbors: false });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).newDevices, undefined);
});
