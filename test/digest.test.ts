import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  buildDigest,
  busiest,
  CATCHUP_MS,
  checkSettings,
  decide,
  emptyState,
  korDur,
  latestSlot,
  nextSlot,
  parseSettings,
  parseState,
  periodOf,
  RETRY_MS,
  type DigestInput,
  type DigestSettings,
} from '../src/core/digest.ts';
import { httpSender, loadChannel } from '../src/core/alerts.ts';
import { loadPrefs, setDigestPrefs, setPortPrefs } from '../src/core/prefs.ts';
import type { KnownDevice, KnownStore } from '../src/core/known.ts';
import type { SelfWatchStatus } from '../src/core/selfwatch.ts';
import { createDigester, type Sources } from '../src/features/digest.ts';
import { REGISTRY } from '../src/features/registry.ts';
import { isEnabled } from '../src/features/jobs.ts';
import { resolvePaths } from '../src/core/paths.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** KST wall clock → ms */
const kst = (s: string) => Date.parse(`${s}+09:00`);
const daily: DigestSettings = { mode: 'daily', time: '09:00' };
const weekly: DigestSettings = { mode: 'weekly', time: '09:00' };

// ---------- settings ----------

test('settings: malformed falls back to off at 09:00; checkSettings names the problem', () => {
  assert.deepEqual(parseSettings(undefined), { mode: 'off', time: '09:00' });
  assert.deepEqual(parseSettings({ mode: 'hourly', time: '9:00' }), { mode: 'off', time: '09:00' });
  assert.deepEqual(parseSettings({ mode: 'weekly', time: '21:30' }), { mode: 'weekly', time: '21:30' });
  assert.equal(checkSettings({ mode: 'daily', time: '07:05' }), null);
  assert.equal(checkSettings({}), null);
  assert.match(checkSettings({ mode: 'monthly' })!, /mode/);
  assert.match(checkSettings({ time: '24:00' })!, /time/);
  assert.match(checkSettings({ mode: 'daily', extra: 1 })!, /unknown field/);
  assert.match(checkSettings([])!, /object/);
});

test('prefs: digest is kept across port edits, and off at the default time is removed', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'portboard-')), 'prefs.json');
  assert.deepEqual(await setDigestPrefs({ mode: 'daily' }, path), { mode: 'daily', time: '09:00' });
  await setPortPrefs(8780, { alert: true }, path);
  assert.deepEqual((await loadPrefs(path)).digest, { mode: 'daily', time: '09:00' });
  assert.deepEqual(await setDigestPrefs({ time: '08:30' }, path), { mode: 'daily', time: '08:30' });
  await setDigestPrefs({ mode: 'off', time: '09:00' }, path);
  assert.equal((await loadPrefs(path)).digest, undefined);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).digest, undefined);
});

// ---------- schedule ----------

test('slots: daily at the KST time; weekly on Monday; off has none', () => {
  // 2026-10-18 is a Sunday
  assert.equal(latestSlot(daily, kst('2026-10-18T08:59:00')), kst('2026-10-17T09:00:00'));
  assert.equal(latestSlot(daily, kst('2026-10-18T09:00:00')), kst('2026-10-18T09:00:00'));
  assert.equal(latestSlot(daily, kst('2026-10-18T23:59:00')), kst('2026-10-18T09:00:00'));
  assert.equal(latestSlot(daily, kst('2026-10-19T00:30:00')), kst('2026-10-18T09:00:00'), 'after midnight KST, before 09:00');
  assert.equal(nextSlot(daily, kst('2026-10-18T10:00:00')), kst('2026-10-19T09:00:00'));
  assert.equal(latestSlot(weekly, kst('2026-10-18T10:00:00')), kst('2026-10-12T09:00:00'), 'Sunday → last Monday');
  assert.equal(latestSlot(weekly, kst('2026-10-19T08:00:00')), kst('2026-10-12T09:00:00'), 'Monday before the time');
  assert.equal(latestSlot(weekly, kst('2026-10-19T09:00:00')), kst('2026-10-19T09:00:00'));
  assert.equal(nextSlot(weekly, kst('2026-10-19T09:00:01')), kst('2026-10-26T09:00:00'));
  assert.equal(latestSlot({ mode: 'daily', time: '23:30' }, kst('2026-10-18T23:40:00')), kst('2026-10-18T23:30:00'));
  assert.equal(latestSlot({ mode: 'off', time: '09:00' }, kst('2026-10-18T10:00:00')), null);
  assert.deepEqual(periodOf('weekly', kst('2026-10-19T09:00:00')), { from: kst('2026-10-12T09:00:00'), to: kst('2026-10-19T09:00:00') });
});

/** Runs decide like the job does: applies arm/disarm, and a send as successful */
function drive(s: DigestSettings, times: number[], st = emptyState()) {
  const actions: string[] = [];
  for (const t of times) {
    const d = decide(s, st, t);
    actions.push(d.action);
    if (d.action === 'arm' || d.action === 'disarm') st = d.state;
    if (d.action === 'send') st = { ...st, lastSlot: d.slot, lastSent: t };
  }
  return { actions, st };
}

test('decide: switching on at 15:00 does not send that morning\'s digest; the next 09:00 goes once', () => {
  const { actions } = drive(daily, [kst('2026-10-18T15:00:00'), kst('2026-10-18T15:01:00'), kst('2026-10-19T08:59:00'), kst('2026-10-19T09:00:00'), kst('2026-10-19T09:01:00'), kst('2026-10-19T12:00:00')]);
  assert.deepEqual(actions, ['arm', 'none', 'none', 'send', 'none', 'none']);
});

test('decide: a restart after the send (same state file) does not send again', () => {
  const { st } = drive(daily, [kst('2026-10-17T20:00:00'), kst('2026-10-18T09:00:10')]);
  const again = parseState(JSON.stringify(st)); // what a restarted server reads back
  assert.equal(decide(daily, again, kst('2026-10-18T09:02:00')).action, 'none');
});

test('decide: a slot missed while the server was down goes out late, but not past the catch-up window', () => {
  const armed = drive(daily, [kst('2026-10-17T20:00:00')]).st;
  assert.deepEqual(decide(daily, armed, kst('2026-10-18T11:30:00')), { action: 'send', slot: kst('2026-10-18T09:00:00') });
  assert.equal(decide(daily, armed, kst('2026-10-18T09:00:00') + CATCHUP_MS + MIN).action, 'none');
});

test('decide: after a failed attempt it waits RETRY_MS; changing the time re-arms; off disarms', () => {
  const armed = drive(daily, [kst('2026-10-17T20:00:00')]).st;
  const failed = { ...armed, lastAttempt: kst('2026-10-18T09:00:00') };
  assert.equal(decide(daily, failed, kst('2026-10-18T09:05:00')).action, 'none');
  assert.equal(decide(daily, failed, kst('2026-10-18T09:00:00') + RETRY_MS).action, 'send');
  assert.equal(decide({ mode: 'daily', time: '08:00' }, armed, kst('2026-10-18T08:30:00')).action, 'arm');
  const off = decide({ mode: 'off', time: '09:00' }, armed, kst('2026-10-18T08:30:00'));
  assert.equal(off.action, 'disarm');
  assert.equal(decide({ mode: 'off', time: '09:00' }, off.action === 'disarm' ? off.state : armed, kst('2026-10-18T08:31:00')).action, 'none');
});

// ---------- text ----------

const NOW = kst('2026-10-18T09:00:00');
const FROM = NOW - DAY;

const device = (over: Partial<KnownDevice>): KnownDevice => ({
  key: 'mac:aa', kind: 'lan', name: 'iPhone', nameSource: 'vendor' as KnownDevice['nameSource'], vendor: null, mac: null, ip: null,
  cardId: null, nameKey: null, firstSeen: NOW - HOUR, connected: NOW - HOUR, neighbor: null, service: null, pending: 'connection',
  notify: false, notified: null, ...over,
});

const quiet: DigestInput = { watching: [], uptime: { version: 1, ports: {} }, known: null, cleanup: [], worktrees: { removable: 0, removableKb: 0 }, selfwatch: null, history: null };

test('digest: nothing to report is one line', () => {
  const d = buildDigest(quiet, 'daily', { from: FROM, to: NOW }, NOW);
  assert.equal(d.empty, true);
  assert.equal(d.body, '이상 없음');
  assert.equal(d.title, 'Portboard 일간 요약 · 10/18(일)', 'the day it is sent');
  const watched = buildDigest(
    { ...quiet, watching: [{ kind: 'port', port: 8780, name: 'uploader', down: false, since: null }], uptime: { version: 1, ports: { 8780: [[FROM, NOW, 'u']] } } },
    'daily', { from: FROM, to: NOW }, NOW,
  );
  assert.equal(watched.body, '이상 없음 · 감시 서비스 1개 모두 정상');
  assert.equal(watched.body.split('\n').length, 1);
});

test('digest: outages, what is down, new devices, cleanup, worktrees, self-watch and most used, in that order', () => {
  const seg = (a: number, b: number, c: 'u' | 'd' | 'h') => [a, b, c] as [number, number, 'u' | 'd' | 'h'];
  const known: KnownStore = {
    version: 1, seededAt: FROM - 10 * DAY, lastSent: null,
    devices: {
      a: device({ key: 'a', name: 'iPhone' }),
      b: device({ key: 'b', name: 'Galaxy Tab', pending: null, connected: NOW - 2 * HOUR, firstSeen: NOW - 2 * HOUR }),
      old: device({ key: 'old', name: 'NAS', firstSeen: FROM - DAY, connected: FROM - DAY }),
      seed: device({ key: 'seed', name: 'Seeded', seeded: true }),
    },
  };
  const selfwatch = {
    collectors: [
      { name: 'proxmox', label: 'Proxmox', view: 'down', enabled: true },
      { name: 'ss', label: '포트 목록', view: 'ok', enabled: true },
    ],
    expiry: { checkedAt: null, items: [{ key: 'proxmox-token', name: 'Proxmox API token', expiresAt: new Date(NOW + 3 * DAY).toISOString(), status: 'soon', note: null }] },
  } as unknown as SelfWatchStatus;
  const day = new Date(NOW - HOUR).toISOString().slice(0, 10);
  const entry = (device: string, port: number, service: string, minutes: number) => ({
    device, port, service, name: device, kind: 'tailnet', nameKey: null, firstSeen: FROM, lastSeen: NOW, activeSince: FROM, samples: 1, peak: 1, days: { [day]: minutes },
  });
  const input: DigestInput = {
    watching: [
      { kind: 'port', port: 8780, name: 'uploader', down: false, since: null },
      { kind: 'port', port: 3000, name: 'acme', down: true, since: new Date(NOW - 3 * HOUR).toISOString() },
      { kind: 'device', name: 'desktop-pc', down: false, since: null },
    ],
    uptime: {
      version: 1,
      ports: {
        // two outages in the period (10 min and 4 min), one before it
        8780: [seg(FROM - 2 * HOUR, FROM - HOUR, 'd'), seg(FROM, NOW - 10 * HOUR, 'u'), seg(NOW - 10 * HOUR + 30_000, NOW - 9 * HOUR - 50 * MIN, 'd'), seg(NOW - 9 * HOUR - 49 * MIN - 30_000, NOW - 5 * HOUR, 'u'), seg(NOW - 5 * HOUR + 30_000, NOW - 4 * HOUR - 56 * MIN, 'h'), seg(NOW - 4 * HOUR - 55 * MIN - 30_000, NOW, 'u')],
        3000: [seg(FROM, NOW - 3 * HOUR, 'u'), seg(NOW - 3 * HOUR + 30_000, NOW, 'd')],
      },
    },
    known,
    cleanup: [{ port: 8801, name: 'vite' }, { port: 8803, name: '[systemd-run] /usr/bin/python3 -m http.server 8803' }],
    worktrees: { removable: 4, removableKb: 1.5 * 1024 ** 2 },
    selfwatch,
    history: {
      version: 1, startedAt: FROM,
      entries: {
        x: entry('iphone', 8780, 'uploader', 200), y: entry('mac', 8780, 'uploader', 20), z: entry('mac', 3000, 'acme', 65),
        l: entry('local', 8790, 'portboard', 1000), w: entry('mac', 5173, 'vite', 5),
      },
    },
  };
  const d = buildDigest(input, 'daily', { from: FROM, to: NOW }, NOW);
  assert.equal(d.empty, false);
  assert.deepEqual(d.body.split('\n'), [
    '🔔 감시 서비스 2개 · 가동률 93.2%',
    '⚠️ 3000 acme: 1번, 총 3시간 중단',
    '⚠️ 8780 uploader: 2번, 총 14분 중단',
    '🔴 지금 꺼짐: 3000 acme (3시간째)',
    '🆕 새 기기 2대: Galaxy Tab, iPhone (확인 안 함 1)',
    '🧹 정리 후보 서버 2개: 8801 vite, 8803',
    '🌿 지워도 되는 worktree 4개 · 1.5 GB',
    '🩺 수집 문제: Proxmox',
    '🔑 Proxmox API token 3일 남음',
    '📈 많이 쓴 서비스: uploader (2대) · acme (1대) · vite (1대)',
  ]);
  // weekly titles show the span
  assert.equal(buildDigest(quiet, 'weekly', periodOf('weekly', kst('2026-10-19T09:00:00')), NOW).title, 'Portboard 주간 요약 · 10/12(월)–10/19(월)');
});

test('digest: a source that failed (null) drops its line only', () => {
  const d = buildDigest({ ...quiet, watching: null, uptime: null, cleanup: [{ port: 8801, name: 'vite' }] }, 'daily', { from: FROM, to: NOW }, NOW);
  assert.equal(d.body, '🧹 정리 후보 서버 1개: 8801 vite');
});

test('busiest: whole UTC days the period touches, this server\'s own traffic left out', () => {
  const e = (device: string, port: number, days: Record<string, number>) => ({ device, port, service: `s${port}`, name: '', kind: '', nameKey: null, firstSeen: 0, lastSeen: 0, activeSince: 0, samples: 1, peak: 1, days });
  const h = { version: 1 as const, startedAt: 0, entries: { a: e('d1', 1, { '2026-10-17': 10, '2026-10-16': 99 }), b: e('local', 2, { '2026-10-17': 500 }), c: e('d2', 3, { '2026-10-17': 30 }) } };
  assert.deepEqual(busiest(h, kst('2026-10-17T09:00:00'), kst('2026-10-18T09:00:00')), [{ port: 3, service: 's3', minutes: 30, devices: 1 }, { port: 1, service: 's1', minutes: 10, devices: 1 }]);
  assert.equal(korDur(65 * MIN), '1시간 5분');
  assert.equal(korDur(26 * HOUR), '1일 2시간');
});

// ---------- sending (a local fake ntfy; never the real channel) ----------

async function fakeNtfy() {
  const posts: any[] = [];
  const server = createServer((req, res) => {
    // the live Portboard's title probe (GET /) reaches every new loopback listener: only the digest POSTs
    if (req.method !== 'POST') return void res.writeHead(404).end();
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      posts.push(JSON.parse(raw));
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { posts, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const sources = (over: Partial<DigestInput> = {}): Sources => {
  const i = { ...quiet, ...over };
  return {
    watching: async () => i.watching, uptime: async () => i.uptime, known: async () => i.known, cleanup: async () => i.cleanup,
    worktrees: async () => i.worktrees, selfwatch: async () => i.selfwatch, history: async () => i.history,
  };
};

test('digester: sends one scheduled digest to the channel (JSON, Korean intact), logs it, and a restart does not repeat it', async () => {
  const ntfy = await fakeNtfy();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'portboard-digest-'));
    const channelFile = join(dir, 'alerts.json');
    await writeFile(channelFile, JSON.stringify({ ntfy: { server: ntfy.url, topic: 'pb-test-topic' } }));
    let t = kst('2026-10-17T20:00:00');
    const make = () => createDigester({
      sources: sources({ cleanup: [{ port: 8801, name: '바이트' }] }),
      settings: async () => daily,
      channel: () => loadChannel(channelFile),
      send: httpSender(),
      now: () => t,
      statePath: join(dir, 'digest-state.json'),
      logPath: join(dir, 'alerts.jsonl'),
    });
    const d = make();
    assert.equal(await d.tick(), 'arm');
    t = kst('2026-10-18T09:00:05');
    assert.equal(await d.tick(), 'sent');
    assert.equal(await d.tick(), 'none');
    assert.equal(await make().tick(), 'none', 'restarted: same state file');
    assert.equal(ntfy.posts.length, 1);
    assert.deepEqual(ntfy.posts[0], { topic: 'pb-test-topic', title: 'Portboard 일간 요약 · 10/18(일)', message: '🧹 정리 후보 서버 1개: 8801 바이트', priority: 3, tags: ['memo'] });
    const log = (await readFile(join(dir, 'alerts.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].key, 'digest');
    assert.ok(!JSON.stringify(log).includes('pb-test-topic'), 'the topic stays out of the log');
    assert.equal((await d.view()).lastSent, new Date(kst('2026-10-18T09:00:05')).toISOString());

    // 지금 보내기: the period ending now, schedule untouched
    t = kst('2026-10-18T15:00:00');
    const r = await d.sendNow();
    assert.equal(r.ok, true);
    assert.equal(ntfy.posts.length, 2);
    assert.equal(ntfy.posts[1].title, 'Portboard 일간 요약 · 10/18(일)');
    assert.equal(parseState(await readFile(join(dir, 'digest-state.json'), 'utf8')).lastSlot, kst('2026-10-18T09:00:00'));
  } finally {
    await ntfy.close();
  }
});

test('digester: no channel → 알림 채널 없음, nothing written; a failing post is retried after RETRY_MS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portboard-digest-'));
  let t = kst('2026-10-17T20:00:00');
  let fail = true;
  const posts: string[] = [];
  const d = createDigester({
    sources: sources(),
    settings: async () => daily,
    channel: async () => ({ ntfyServer: 'http://127.0.0.1:1', ntfyTopic: 'x', webhookUrl: null }),
    send: async (_c, m) => (posts.push(m.title), [{ channel: 'ntfy', ok: !fail, ...(fail ? { error: 'HTTP 500' } : {}) }]),
    now: () => t,
    statePath: join(dir, 'state.json'),
    logPath: join(dir, 'log.jsonl'),
  });
  await d.tick();
  t = kst('2026-10-18T09:00:00');
  assert.equal(await d.tick(), 'failed');
  t += MIN;
  assert.equal(await d.tick(), 'none');
  fail = false;
  t = kst('2026-10-18T09:00:00') + RETRY_MS;
  assert.equal(await d.tick(), 'sent');
  assert.equal(posts.length, 2);

  const none = createDigester({ sources: sources(), settings: async () => daily, channel: async () => null, statePath: join(dir, 'x.json'), logPath: join(dir, 'x.jsonl') });
  assert.deepEqual((await none.sendNow()).message, '알림 채널 없음');
});

test('the digest job only runs where alerts may be sent: never in a preview', () => {
  const job = REGISTRY.jobs.find((j) => j.name === 'digest');
  assert.ok(job);
  assert.equal(isEnabled(job, resolvePaths({ PORTBOARD_PORT: '8808' }, '/home/x')), false);
  assert.equal(isEnabled(job, resolvePaths({}, '/home/x')), true);
  assert.equal(isEnabled(job, resolvePaths({ PORTBOARD_ALERTS: 'off' }, '/home/x')), false);
});
