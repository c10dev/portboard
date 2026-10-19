import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Channel, Message, Sender } from '../src/core/alerts.ts';
import { clean, health, HealthRegistry, type CollectorHealth } from '../src/core/health.ts';
import {
  createSelfWatch,
  expiryStatus,
  proxmoxExpiry,
  proxmoxTokenItem,
  remoteItems,
  savedStatus,
  stepCollector,
  tokenPath,
  type ExpiryItem,
} from '../src/core/selfwatch.ts';
import { statusReport } from '../src/mcp/resources.ts';
import { SITE } from '../src/core/site.ts';
import { PvePortsCollector } from '../src/core/pveports.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CH: Channel = { ntfyServer: 'https://ntfy.example', ntfyTopic: 'secret-topic-123', webhookUrl: null };

function fakeSender(fail = () => false) {
  const sent: Message[] = [];
  const send: Sender = async (_c, m) => {
    sent.push(m);
    return [{ channel: 'ntfy', ok: !fail() }];
  };
  return { sent, send };
}

const rec = (name: string, over: Partial<CollectorHealth> = {}): CollectorHealth => ({
  name, enabled: true, ok: true, checkedAt: 0, lastOk: 0, lastError: null, failures: 0, since: null, setup: false, ...over,
});

async function harness(opts: { statePath?: string; alertsOn?: boolean; expiry?: () => Promise<ExpiryItem[]>; fail?: () => boolean } = {}) {
  let t = 10 * DAY;
  const reg = new HealthRegistry(() => t);
  const dir = await mkdtemp(join(tmpdir(), 'selfwatch-'));
  const statePath = opts.statePath ?? join(dir, 'selfwatch.json');
  const { sent, send } = fakeSender(opts.fail);
  const logs: string[] = [];
  const make = () =>
    createSelfWatch({
      collectors: () => reg.all(),
      expiry: opts.expiry ?? (async () => []),
      channel: async () => CH,
      send,
      alertsOn: opts.alertsOn ?? true,
      now: () => t,
      threshold: 15 * MIN,
      statePath,
      logPath: join(dir, 'alerts.jsonl'),
      log: (l) => logs.push(l),
    });
  return { reg, sent, logs, statePath, dir, make, w: make(), advance: (ms: number) => (t += ms), now: () => t };
}

// ---------- health registry ----------

test('registry: failures count up, since is the first failure, an ok resets both; disabled is not a failure', () => {
  let t = 1000;
  const r = new HealthRegistry(() => t);
  r.report('pool', { ok: true });
  t = 2000;
  r.report('pool', { ok: false, error: 'HTTP 502' });
  t = 3000;
  r.report('pool', { ok: false, error: 'HTTP 502' });
  assert.deepEqual(r.get('pool'), { name: 'pool', enabled: true, ok: false, checkedAt: 3000, lastOk: 1000, lastError: 'HTTP 502', failures: 2, since: 2000, setup: false });
  t = 4000;
  r.report('pool', { ok: true });
  assert.equal(r.get('pool')!.failures, 0);
  assert.equal(r.get('pool')!.since, null);
  r.report('proxmox', { ok: false, enabled: false, error: 'no proxmox.json' });
  assert.deepEqual({ ...r.get('proxmox')!, checkedAt: 0 }, { name: 'proxmox', enabled: false, ok: false, checkedAt: 0, lastOk: null, lastError: 'no proxmox.json', failures: 0, since: null, setup: false });
  assert.deepEqual(r.all().map((x) => x.name), ['pool', 'proxmox'], 'COLLECTORS order');
});

test('clean: no URLs, tokens or key=value secrets in a stored error, one short line', () => {
  assert.equal(clean('cannot reach Proxmox at https://192.168.1.201:8006 (ECONNREFUSED)'), 'cannot reach Proxmox at <url> (ECONNREFUSED)');
  assert.equal(clean('header PVEAPIToken=portboard@pve!ro=1234-abcd'), 'header PVEAPIToken=***');
  assert.equal(clean(`bad ${'a1B2'.repeat(12)} here`), 'bad *** here');
  assert.equal(clean('topic: secret-topic-123 failed'), 'topic=*** failed');
  assert.equal(clean('first\nsecond'), 'first');
  assert.equal(clean('word '.repeat(60))!.length, 120);
  assert.equal(clean(''), null);
});

test('ssh readers report their fixed error code to the registry, never stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sw-ssh-'));
  const key = join(dir, 'k');
  await writeFile(key, 'x');
  const configPath = join(dir, 'pveports.json');
  await writeFile(configPath, JSON.stringify({ host: '192.168.1.201', node: 'pve1', enabled: true, key }));
  health.clear();
  const c = new PvePortsCollector({
    configPath, fakeCmd: null, health: 'pve-ports', log: () => {},
    runner: async () => ({ ok: false, stdout: '', stderr: 'root@192.168.1.201: Permission denied (publickey).' }),
  });
  await c.refresh();
  const r = health.get('pve-ports')!;
  assert.equal(r.lastError, 'not-installed');
  assert.equal(r.setup, true, 'a key not installed yet is a setup step');
  assert.ok(!JSON.stringify(r).includes('192.168'));
  health.clear();
});

// ---------- state machine ----------

test('step: no alert before the threshold, one after, none repeated; one recovery', () => {
  let s = undefined;
  const t0 = 100 * MIN;
  const failing = (t: number) => rec('pool', { ok: false, lastError: 'HTTP 502', failures: 3, since: t0, checkedAt: t, lastOk: t0 - MIN });
  let r = stepCollector(s, failing(t0 + 14 * MIN), t0 + 14 * MIN);
  assert.equal(r.message, null);
  assert.equal(r.next.down, false);
  r = stepCollector(r.next, failing(t0 + 16 * MIN), t0 + 16 * MIN);
  assert.equal(r.message?.kind, 'down');
  assert.equal(r.message?.key, 'collector:pool');
  assert.match(r.message!.body, /16 min \(HTTP 502\)/);
  r = stepCollector(r.next, failing(t0 + 30 * MIN), t0 + 30 * MIN);
  assert.equal(r.message, null, 'one alert per outage');
  r = stepCollector(r.next, rec('pool', { checkedAt: t0 + 31 * MIN, lastOk: t0 + 31 * MIN }), t0 + 31 * MIN);
  assert.equal(r.message?.kind, 'recovered');
  assert.match(r.message!.title, /pool collection is back/);
  s = r.next;
  assert.equal(s.down, false);
  assert.equal(s.everOk, true);
});

test('step: a failure that comes back within the hour is tracked but not re-alerted, and then gets no recovery either', () => {
  const t0 = 100 * MIN;
  const fail = (since: number, t: number) => rec('pool', { ok: false, lastError: 'x', since, checkedAt: t });
  let r = stepCollector(undefined, fail(t0, t0 + 16 * MIN), t0 + 16 * MIN);
  assert.equal(r.message?.kind, 'down');
  r = stepCollector(r.next, rec('pool', { checkedAt: t0 + 17 * MIN }), t0 + 17 * MIN);
  assert.equal(r.message?.kind, 'recovered');
  const t1 = t0 + 20 * MIN;
  r = stepCollector(r.next, fail(t1, t1 + 16 * MIN), t1 + 16 * MIN);
  assert.equal(r.next.down, true);
  assert.equal(r.message, null, 'rate-limited: last down alert was 20 min ago');
  r = stepCollector(r.next, rec('pool', { checkedAt: t1 + 17 * MIN }), t1 + 17 * MIN);
  assert.equal(r.message, null, 'no recovery for an outage nobody was told about');
  // An hour after the first alert, a new long outage alerts again.
  const t2 = t0 + 70 * MIN;
  r = stepCollector(r.next, fail(t2, t2 + 16 * MIN), t2 + 16 * MIN);
  assert.equal(r.message?.kind, 'down');
});

test('step: off and not-set-up collectors are never alerted; a setup error after it once worked is', () => {
  const t = 100 * MIN;
  let r = stepCollector(undefined, rec('proxmox', { enabled: false, ok: false, lastError: 'no proxmox.json', checkedAt: t }), t + 60 * MIN);
  assert.equal(r.message, null);
  r = stepCollector(undefined, rec('pve-ports', { ok: false, setup: true, lastError: 'not-installed', since: t, checkedAt: t + 60 * MIN }), t + 60 * MIN);
  assert.equal(r.message, null);
  assert.equal(r.next.failingSince, null);
  // Worked once, then the key was removed: that is an outage.
  r = stepCollector({ ...r.next, everOk: true }, rec('pve-ports', { ok: false, setup: true, lastError: 'not-installed', since: t, checkedAt: t + 16 * MIN }), t + 16 * MIN);
  assert.equal(r.message?.kind, 'down');
});

test('step: a collector that stopped reporting for 30 min is failing (stuck loop); hostkeys is exempt', () => {
  const t = 1000 * MIN;
  let r = stepCollector(undefined, rec('usage', { checkedAt: t - 31 * MIN, lastOk: t - 31 * MIN }), t);
  assert.equal(r.next.failingSince, t);
  assert.match(r.next.lastError!, /no report for 31 min/);
  r = stepCollector(r.next, rec('usage', { checkedAt: t - 31 * MIN, lastOk: t - 31 * MIN }), t + 16 * MIN);
  assert.equal(r.message?.kind, 'down');
  r = stepCollector(undefined, rec('hostkeys', { checkedAt: t - 5 * 60 * MIN }), t);
  assert.equal(r.next.failingSince, null);
});

// ---------- watcher ----------

test('watcher: alerts through the fake sender once, logs it, recovers once', async () => {
  const h = await harness();
  h.reg.report('pool', { ok: true });
  await h.w.tick();
  h.advance(MIN);
  h.reg.report('pool', { ok: false, error: 'compute-pool monitor not reachable at http://127.0.0.1:7720 (fetch failed)' });
  for (let i = 0; i < 17; i++) {
    h.advance(MIN);
    h.reg.report('pool', { ok: false, error: 'compute-pool monitor not reachable at http://127.0.0.1:7720 (fetch failed)' });
    await h.w.tick();
  }
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].kind, 'down');
  assert.ok(!h.sent[0].body.includes('127.0.0.1'), 'no URL in the alert');
  const st = await h.w.status();
  assert.equal(st.failing, 1);
  assert.equal(st.summary, '1개 실패');
  assert.equal(st.collectors[0].view, 'down');
  assert.equal(st.collectors[0].alerted, true);
  h.reg.report('pool', { ok: true });
  await h.w.tick();
  assert.deepEqual(h.sent.map((m) => m.kind), ['down', 'recovered']);
  assert.equal((await h.w.status()).summary, '수집 정상');
  const log = (await readFile(join(h.dir, 'alerts.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.key), ['collector:pool', 'collector:pool']);
  assert.ok(!JSON.stringify(log).includes('secret-topic-123'));
});

test('watcher: the down/up state survives a restart; an empty registry after it is not a recovery', async () => {
  const h = await harness();
  h.reg.report('proxmox', { ok: false, error: 'HTTP 401 (token rejected)' });
  h.advance(16 * MIN);
  h.reg.report('proxmox', { ok: false, error: 'HTTP 401 (token rejected)' });
  await h.w.tick();
  assert.equal(h.sent.length, 1);
  const saved = JSON.parse(await readFile(h.statePath, 'utf8'));
  assert.equal(saved.collectors.proxmox.down, true);
  assert.equal(saved.collectors.proxmox.alerted, true);

  // "Restart": a fresh registry and watcher on the same state file.
  h.reg.clear();
  const w2 = h.make();
  h.advance(MIN);
  await w2.tick();
  assert.equal(h.sent.length, 1, 'nothing reported yet: no recovery, no second alert');
  assert.equal((await w2.status()).collectors.find((c) => c.name === 'proxmox')?.view, 'pending');
  h.advance(MIN);
  h.reg.report('proxmox', { ok: false, error: 'HTTP 401 (token rejected)' });
  await w2.tick();
  assert.equal(h.sent.length, 1, 'still the same outage: no repeat');
  h.reg.report('proxmox', { ok: true });
  await w2.tick();
  assert.deepEqual(h.sent.map((m) => m.kind), ['down', 'recovered']);
  assert.ok((await savedStatus(h.statePath))?.collectors.some((c) => c.name === 'proxmox' && c.view === 'ok'), 'the view for the MCP server');
});

test('watcher: a failed send is retried next minute; alerts off sends nothing but still tracks', async () => {
  let failing = true;
  const h = await harness({ fail: () => failing });
  h.reg.report('win-ports', { ok: false, error: 'unreachable' });
  h.advance(16 * MIN);
  h.reg.report('win-ports', { ok: false, error: 'unreachable' });
  await h.w.tick();
  assert.equal(h.sent.length, 1);
  failing = false;
  h.advance(MIN);
  await h.w.tick();
  assert.equal(h.sent.length, 2, 'retried');
  h.advance(MIN);
  await h.w.tick();
  assert.equal(h.sent.length, 2);

  const off = await harness({ alertsOn: false });
  off.reg.report('win-ports', { ok: false, error: 'unreachable' });
  off.advance(16 * MIN);
  off.reg.report('win-ports', { ok: false, error: 'unreachable' });
  await off.w.tick();
  assert.equal(off.sent.length, 0);
  assert.equal((await off.w.status()).collectors[0].view, 'down');
});

test('watcher: a failure run from before a long stop is not continuous', async () => {
  const h = await harness();
  h.reg.report('pool', { ok: false, error: 'x' });
  await h.w.tick();
  h.reg.clear();
  h.advance(3 * 60 * MIN); // Portboard was stopped for 3 h
  const w2 = h.make();
  h.reg.report('pool', { ok: false, error: 'x' });
  await w2.tick();
  assert.equal(h.sent.length, 0);
  h.advance(16 * MIN);
  h.reg.report('pool', { ok: false, error: 'x' });
  await w2.tick();
  assert.equal(h.sent.length, 1);
});

// ---------- expiry ----------

test('expiry: Proxmox token expire 0 = never, a date within 7 days = soon; 403 = unknown, never a guess', async () => {
  const now = 1_800_000_000_000;
  assert.equal(tokenPath('portboard@pve!ro'), '/access/users/portboard%40pve/token/ro');
  assert.equal(tokenPath('nonsense'), null);
  assert.equal(proxmoxTokenItem({ expire: 0, privsep: 1 }, now).status, 'never');
  assert.equal(proxmoxTokenItem({ privsep: 1 }, now).status, 'never');
  const soon = proxmoxTokenItem({ expire: Math.floor((now + 3 * DAY) / 1000) }, now);
  assert.equal(soon.status, 'soon');
  assert.equal(proxmoxTokenItem({ expire: Math.floor((now + 30 * DAY) / 1000) }, now).status, 'ok');
  assert.equal(proxmoxTokenItem({ expire: Math.floor((now - DAY) / 1000) }, now).status, 'expired');
  assert.equal(expiryStatus(null, now), 'never');

  const dir = await mkdtemp(join(tmpdir(), 'sw-pve-'));
  const path = join(dir, 'proxmox.json');
  await writeFile(path, JSON.stringify({ url: 'https://192.168.1.201:8006', tokenId: 'portboard@pve!ro', secret: 'SECRET-VALUE', fingerprint: 'AA'.repeat(32) }), { mode: 0o600 });
  const asked: string[] = [];
  const ok = await proxmoxExpiry(now, path, async (_c, p) => (asked.push(p), { expire: 0 }));
  assert.deepEqual(asked, ['/access/users/portboard%40pve/token/ro']);
  assert.equal(ok[0].status, 'never');
  // PVEAuditor: the token endpoint is 403, the full user list (Sys.Audit) has it — as on pve1 (2026-10-18).
  const users = [{ userid: 'other@pve', tokens: [{ tokenid: 'ro', expire: 1 }] }, { userid: 'portboard@pve', expire: 0, tokens: [{ tokenid: 'x', expire: 5 }, { tokenid: 'ro', expire: 0 }] }];
  const viaList = await proxmoxExpiry(now, path, async (_c, p) => {
    if (p.startsWith('/access/users?full=1')) return users;
    throw new Error('Proxmox /access/users → HTTP 403 (token lacks PVEAuditor)');
  });
  assert.equal(viaList[0].status, 'never');
  users[1].expire = Math.floor((now + 2 * DAY) / 1000);
  const userSoon = await proxmoxExpiry(now, path, async (_c, p) => (p.includes('full=1') ? users : Promise.reject(new Error('HTTP 403'))));
  assert.equal(userSoon[0].status, 'soon', 'the user account expiring ends the token too');
  assert.match(userSoon[0].note!, /user account/);
  const denied = await proxmoxExpiry(now, path, async () => {
    throw new Error('Proxmox /access/users → HTTP 403 (token lacks PVEAuditor)');
  });
  assert.equal(denied[0].status, 'unknown');
  assert.equal(denied[0].expiresAt, null);
  assert.ok(!JSON.stringify([ok, viaList, denied]).includes('SECRET-VALUE'));
  assert.deepEqual(await proxmoxExpiry(now, join(dir, 'missing.json')), [], 'no proxmox.json: nothing to report');
});

test('expiry: remote clients by their newest refresh token; no hashes or client ids in the items', () => {
  const now = 1_800_000_000_000;
  const state = {
    clients: { 'cid-A': { name: 'claude.ai', lastUsedAt: now - 25 * DAY }, 'cid-B': { name: 'inspector', lastUsedAt: now - DAY } },
    tokens: {
      ['a'.repeat(64)]: { kind: 'refresh', clientId: 'cid-A', clientName: 'claude.ai', expiresAt: now + 5 * DAY },
      ['b'.repeat(64)]: { kind: 'used', clientId: 'cid-A', clientName: 'claude.ai', expiresAt: now + 9 * DAY },
      ['c'.repeat(64)]: { kind: 'access', clientId: 'cid-B', clientName: 'inspector', expiresAt: now + 3600_000 },
      ['d'.repeat(64)]: { kind: 'refresh', clientId: 'cid-B', clientName: 'inspector', expiresAt: now + 2 * DAY },
      ['e'.repeat(64)]: { kind: 'refresh', clientId: 'cid-B', clientName: 'inspector', expiresAt: now + 29 * DAY },
    },
  };
  const items = remoteItems(state, now);
  assert.deepEqual(items.map((i) => [i.name, i.status]), [['remote MCP client claude.ai', 'soon'], ['remote MCP client inspector', 'ok']]);
  assert.match(items[0].note!, /last connected 600 h/);
  const text = JSON.stringify(items);
  for (const leak of ['aaaa', 'dddd', 'cid-A', 'cid-B']) assert.ok(!text.includes(leak), leak);
});

test('watcher: one expiry warning per credential and date; renewed → may warn again', async () => {
  let items: ExpiryItem[] = [{ key: 'proxmox-token', name: 'Proxmox API token', expiresAt: 10 * DAY + 3 * DAY, status: 'soon', note: null }];
  const h = await harness({ expiry: async () => items });
  await h.w.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].kind, 'warning');
  assert.match(h.sent[0].title, /Proxmox API token expires soon/);
  h.advance(2 * 60 * MIN);
  await h.w.tick();
  assert.equal(h.sent.length, 1, 'same date: no second warning');
  items = [{ ...items[0], expiresAt: 400 * DAY, status: 'ok' }];
  h.advance(2 * 60 * MIN);
  await h.w.tick();
  items = [{ ...items[0], expiresAt: h.now() + DAY, status: 'soon' }];
  h.advance(2 * 60 * MIN);
  await h.w.tick();
  assert.equal(h.sent.length, 2);
  const st = await h.w.status();
  assert.equal(st.expiry.items[0].status, 'soon');
  assert.equal(typeof st.expiry.items[0].expiresAt, 'string');
});

// ---------- MCP status ----------

test('statusReport: the collection section only when given; failing collectors and expiring tokens only', async () => {
  const base = { at: 'x', ports: null, devices: null, usage: null, watching: null, newDevices: null };
  assert.ok(!('collection' in statusReport(base)), 'remote / older cores: no new key');
  const h = await harness({ expiry: async () => [{ key: 'ssh-key', name: 'SSH key portboard_ro', expiresAt: null, status: 'never', note: 'SSH keys have no expiry' }] });
  h.reg.report('pool', { ok: true });
  h.reg.report('proxmox', { ok: false, error: 'HTTP 401 (token rejected)' });
  h.reg.report('win-ports', { ok: false, error: 'no-user', enabled: false });
  await h.w.tick();
  const out = statusReport({ ...base, collection: await h.w.status() });
  assert.deepEqual(out.collection?.failing.map((f) => [f.name, f.error]), [['proxmox', 'HTTP 401 (token rejected)']]);
  assert.deepEqual(out.collection?.notSetUp, ['win-ports']);
  assert.deepEqual(out.collection?.expiring, []);
  assert.equal(out.collection?.summary, '1개 실패');
  const missing = statusReport({ ...base, collection: null });
  assert.equal(missing.collection, null);
  assert.ok(missing.unavailable.includes('collection'));
});

test('runbooks (#31): expiry warnings and credential collectors link their rotation runbook; the status view carries it', async () => {
  const { downText, warningText } = await import('../src/core/selfwatch.ts');
  const rb = 'https://github.com/c10dev/portboard/blob/main/docs/runbooks/';
  const item = (key: string): ExpiryItem => ({ key, name: key, expiresAt: 1000 + DAY, status: 'soon', note: null });
  assert.ok(warningText(item('proxmox-token'), 1000).body.endsWith(`Runbook: ${rb}proxmox-token.md`));
  assert.ok(warningText(item('remote:abc'), 1000).body.endsWith(`Runbook: ${rb}remote-connector.md`));
  assert.ok(warningText(item('proxmox-token'), 1000).body.includes(`Renew it on ${SITE.pve.node}`), 'the old hint stays');
  assert.ok(downText('proxmox', 20 * MIN, 'HTTP 401 (token rejected)', null).body.endsWith(`${rb}proxmox-token.md`));
  assert.ok(downText('win-ports', 20 * MIN, null, null).body.endsWith(`${rb}ssh-readonly-keys.md`));
  assert.ok(!downText('pool', 20 * MIN, null, null).body.includes('runbooks'), 'no credential, no runbook');
  const { statusOf } = await import('../src/core/selfwatch.ts');
  const st = statusOf({ version: 1, lastCheck: 1, collectors: {}, warned: {}, expiry: { at: 1, items: [item('ssh-key'), item('ntfy'), item('other')] } }, [], 2);
  assert.deepEqual(st.expiry.items.map((i) => i.runbook), [`${rb}ssh-readonly-keys.md`, `${rb}ntfy-topic.md`, null]);
});

test('runtime memory: RSS next to the live JS heap, in MB', async () => {
  const { memoryMb } = await import('../src/features/selfwatch.ts');
  const MB = 2 ** 20;
  assert.deepEqual(memoryMb({ rss: 300 * MB, heapUsed: 40.4 * MB, heapTotal: 120 * MB, external: 9.6 * MB, arrayBuffers: 2 * MB }), { rssMb: 300, heapUsedMb: 40, heapTotalMb: 120, externalMb: 10, arrayBuffersMb: 2 });
  assert.ok(memoryMb().heapUsedMb > 0);
});
