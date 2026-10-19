import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChecker,
  dur,
  httpSender,
  loadChannel,
  loadQuiet,
  parseChannel,
  quietly,
  RATE_MS,
  step,
  type Channel,
  type CheckerDeps,
  type Message,
  type Observation,
  type PortView,
  type WatchState,
} from '../src/core/alerts.ts';
import { loadPrefs, setDeviceAlert, setPortPrefs } from '../src/core/prefs.ts';
import { callTool, type Core } from '../src/mcp/tools.ts';
import { L } from './fixtures/locale.ts';

const TOPIC = 'pb-secret-topic-1234567890';
const HOOK = 'https://hooks.example.com/services/T000/B000/XXXXSECRET';
const CHANNEL: Channel = { ntfyServer: 'https://ntfy.example.com', ntfyTopic: TOPIC, webhookUrl: null };
const MIN = 60_000;

const down = (o: Partial<Observation> = {}): Observation => ({ key: 'port:8780', name: 'uploader', ok: false, reason: 'listen', ...o });
const up = (o: Partial<Observation> = {}): Observation => ({ key: 'port:8780', name: 'uploader', ok: true, ...o });

/** Feed observations 30 s apart; returns the messages and the final state */
function run(obs: Observation[], start = 0, quietUntil = 0, from?: WatchState) {
  let s = from;
  const messages: (Message & { at: number })[] = [];
  obs.forEach((o, i) => {
    const at = start + i * 30_000;
    const r = step(s, o, at, quietUntil);
    s = r.next;
    if (r.message) messages.push({ ...r.message, at });
  });
  return { state: s!, messages };
}

test('channel: same parsing rules as compute-pool, null without a topic or webhook', async () => {
  assert.deepEqual(parseChannel(JSON.stringify({ ntfy: { server: 'https://ntfy.example.com/', topic: TOPIC } })), CHANNEL);
  assert.deepEqual(parseChannel(JSON.stringify({ ntfy: { topic: TOPIC } }))?.ntfyServer, 'https://ntfy.sh');
  assert.equal(parseChannel(JSON.stringify({ ntfy: { topic: 'has spaces' } })), null);
  assert.equal(parseChannel(JSON.stringify({ webhook: { url: 'ftp://x' } })), null);
  assert.equal(parseChannel('{not json'), null);
  assert.equal(parseChannel('{}'), null);
  assert.equal(parseChannel(JSON.stringify({ webhook: { url: HOOK } }))?.webhookUrl, HOOK);
  assert.equal(await loadChannel(join(tmpdir(), 'portboard-no-such-file.json')), null);
});

test('state machine: one failed check is not an outage, two send one down alert', () => {
  const one = run([up(), down(), up()]);
  assert.deepEqual(one.messages, []);
  assert.equal(one.state.down, false);

  const out = run([up(), down(), down(), down(), down()]);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].kind, 'down');
  assert.equal(out.messages[0].title, 'portboard: 8780 uploader is down');
  assert.equal(out.messages[0].high, true);
  assert.match(out.messages[0].body, /nothing is listening/);
  assert.equal(out.state.down, true);
});

test('state machine: recovery reports the downtime from the first failed check', () => {
  const obs = [up(), ...Array(7).fill(down()), up()]; // first failure at 30 s, back at 4 min → 3.5 min ≈ 4 min
  const { messages, state } = run(obs);
  assert.deepEqual(messages.map((m) => m.kind), ['down', 'recovered']);
  assert.equal(messages[1].title, 'portboard: 8780 uploader is back (down 4m)');
  assert.equal(messages[1].body, '8780 uploader is answering again after 4 min.');
  assert.equal(messages[1].high, false);
  assert.equal(state.down, false);
  assert.equal(state.since, null);
});

test('state machine: HTTP ports that stop answering say so', () => {
  const { messages } = run([up({ http: true }), down({ reason: 'http' }), down({ reason: 'http' })]);
  assert.match(messages[0].body, /listening, but HTTP does not answer/);
});

test('rate limit: at most one down alert per 10 minutes, recovery alerts always go out', () => {
  // down → back → down again 3 minutes later: the second outage is not announced (yet), its recovery isn't either
  const flap = run([down(), down(), up(), up(), up(), up(), down(), down(), down(), up()]);
  assert.deepEqual(flap.messages.map((m) => m.kind), ['down', 'recovered']);

  // ...but an outage that outlasts the window is announced once the window is over
  const s = flap.state;
  const later = run(Array(25).fill(down()), 5 * MIN, 0, s);
  assert.equal(later.messages.length, 1);
  assert.ok(later.messages[0].at - flap.messages[0].at >= RATE_MS);
  const back = step(later.state, up(), later.messages[0].at + MIN);
  assert.equal(back.message?.kind, 'recovered');
});

test('suppression: a portboard stop/restart is quiet for its window, a service that stays down still alerts after', () => {
  const quietUntil = 2 * MIN;
  // restart takes 40 s: nothing at all
  assert.deepEqual(run([down(), down(), up()], 0, quietUntil).messages, []);
  // stays down: the first checks after the window count from scratch, then one alert
  const { messages } = run(Array(8).fill(down()), 0, quietUntil);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].at, 2.5 * MIN); // checks at 2:00 and 2:30 are the two failures
  assert.match(messages[0].body, /down for 3 min/); // ...but it has been gone since 0:00
});

test('devices: offline / back online wording', () => {
  const d = (ok: boolean): Observation => ({ key: 'device:desktop-pc', name: 'desktop-pc', ok, reason: 'offline' });
  const { messages } = run([d(false), d(false), d(false), d(true)]);
  assert.equal(messages[0].title, 'portboard: desktop-pc is offline');
  assert.equal(messages[1].title, 'portboard: desktop-pc is back online (offline 2m)');
  assert.equal(dur(65 * MIN), '1 h 5 min');
});

interface Harness {
  deps: CheckerDeps;
  sent: Message[];
  views: PortView[];
  clock: { t: number };
  http: Map<number, boolean>;
  dir: string;
  channel: { value: Channel | null };
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'portboard-alerts-'));
  const sent: Message[] = [];
  const views: PortView[] = [];
  const clock = { t: Date.parse('2026-10-17T00:00:00Z') };
  const http = new Map<number, boolean>();
  const channel = { value: CHANNEL as Channel | null };
  const deps: CheckerDeps = {
    ports: async () => views,
    devices: async () => [],
    watched: async () => ({ ports: { 8780: {}, 5281: { label: '라벨' } }, devices: [] }),
    channel: async () => channel.value,
    send: async (_c, m) => {
      sent.push(m);
      return [{ channel: 'ntfy', ok: true }];
    },
    httpOk: async (_h, port) => http.get(port) ?? false,
    now: () => clock.t,
    statePath: join(dir, 'alerts-state.json'),
    quietPath: join(dir, 'quiet.json'),
    logPath: join(dir, 'alerts.jsonl'),
  };
  return { deps, sent, views, clock, http, dir, channel };
}

const view = (port: number, o: Partial<PortView> = {}): PortView => ({
  port, listening: true, name: `svc${port}`, scope: 'loopback', addresses: ['127.0.0.1'], probe: { http: true }, ...o,
});

test('checker: missing ports go down, names survive the outage, labels win, state survives a restart', async () => {
  const h = await harness();
  h.views.push(view(8780, { name: 'uploader' }), view(5281), view(8790, { name: 'Portboard' }));
  const c1 = createChecker(h.deps);
  await c1.tick();
  h.views.splice(0, 2); // both stop listening
  for (let i = 0; i < 3; i++) {
    h.clock.t += 30_000;
    await c1.tick();
  }
  assert.deepEqual(h.sent.map((m) => m.title).sort(), ['portboard: 5281 라벨 is down', 'portboard: 8780 uploader is down']);

  // a new process (portboard restarted) reads the state file: no second down alert, recovery still comes
  const c2 = createChecker(h.deps);
  h.clock.t += 30_000;
  await c2.tick();
  assert.equal(h.sent.length, 2);
  h.views.push(view(8780, { name: 'uploader' }));
  h.clock.t += 30_000;
  await c2.tick();
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2].title, 'portboard: 8780 uploader is back (down 2m)');

  const st = await c2.status();
  assert.deepEqual(st.watching.map((w) => [w.port, w.down]), [[5281, true], [8780, false]]);
  const log = (await readFile(h.deps.logPath!, 'utf8')).trim().split('\n');
  assert.equal(log.length, 3);
});

test('checker: a listening HTTP port whose GET / fails is down; one that never spoke HTTP is fine while listening', async () => {
  const h = await harness();
  h.deps.watched = async () => ({ ports: { 8780: {}, 5432: {} }, devices: [] });
  h.views.push(view(8780), view(5432, { probe: null }));
  const c = createChecker(h.deps);
  await c.tick();
  h.views[0] = view(8780, { probe: { http: false } }); // snapshot's 1 s probe gave up
  h.http.set(8780, true); // ...but the checker's own probe answers: not down
  for (let i = 0; i < 3; i++) {
    h.clock.t += 30_000;
    await c.tick();
  }
  assert.equal(h.sent.length, 0);
  h.http.set(8780, false);
  for (let i = 0; i < 2; i++) {
    h.clock.t += 30_000;
    await c.tick();
  }
  assert.deepEqual(h.sent.map((m) => m.title), ['portboard: 8780 svc8780 is down']);
  assert.match(h.sent[0].body, /HTTP does not answer/);
});

test('checker: an empty listener list (ss failed) is no observation, not every port down', async () => {
  const h = await harness();
  h.views.push(view(8780), view(5281));
  const c = createChecker(h.deps);
  await c.tick();
  h.views.length = 0;
  for (let i = 0; i < 4; i++) {
    h.clock.t += 30_000;
    await c.tick();
  }
  assert.equal(h.sent.length, 0);
  assert.ok((await c.status()).watching.every((w) => !w.down && !w.since));
});

test('checker: no channel means no sends and no outage lost', async () => {
  const h = await harness();
  h.channel.value = null;
  const c = createChecker(h.deps);
  for (let i = 0; i < 4; i++) {
    h.clock.t += 30_000;
    await c.tick();
  }
  assert.equal(h.sent.length, 0);
  const st = await c.status();
  assert.deepEqual(st.channel, { configured: false, kinds: [] });
  assert.deepEqual(await c.test(), { ok: false, message: L('알림 채널 없음', 'No alert channel'), sent: [] });
});

test('checker: a down alert that could not be delivered is retried on the next check', async () => {
  const h = await harness();
  h.deps.watched = async () => ({ ports: { 8780: {} }, devices: [] });
  let fail = true;
  h.deps.send = async (_c, m) => {
    h.sent.push(m);
    return [{ channel: 'ntfy', ok: !fail, ...(fail ? { error: 'HTTP 502' } : {}) }];
  };
  h.views.push(view(8790)); // something else listens, so 8780 missing is real
  const c = createChecker(h.deps);
  for (let i = 0; i < 2; i++) {
    h.clock.t += 30_000;
    await c.tick();
  }
  fail = false;
  for (let i = 0; i < 3; i++) {
    h.clock.t += 30_000;
    await c.tick();
  }
  assert.deepEqual(h.sent.map((m) => m.kind), ['down', 'down']);
});

test('checker: quiet file from a portboard restart suppresses the alert', async () => {
  const h = await harness();
  h.deps.watched = async () => ({ ports: { 8780: {} }, devices: [] });
  h.views.push(view(8780));
  const c = createChecker(h.deps);
  await c.tick();
  const restart = quietly(async () => {
    h.views.length = 0;
    return { ok: true, message: 'restarting' };
  }, h.deps.quietPath);
  await restart(8780);
  const q = await loadQuiet(h.deps.quietPath);
  assert.ok(q[8780] > Date.now() + 60_000);
  h.deps.now = () => Date.now(); // the quiet window is wall-clock
  await c.tick();
  await c.tick();
  await c.tick();
  assert.equal(h.sent.length, 0);
  assert.ok((await c.status()).watching[0].quietUntil);

  // a failed stop leaves no quiet window behind
  await quietly(async () => ({ ok: false, message: 'nope' }), h.deps.quietPath)(5281);
  assert.equal((await loadQuiet(h.deps.quietPath))[5281], undefined);
});

test('the channel secret never shows up in status, test results or the log', async () => {
  const h = await harness();
  const channelFile = join(h.dir, 'channel.json');
  await writeFile(channelFile, JSON.stringify({ ntfy: { server: 'https://ntfy.example.com', topic: TOPIC }, webhook: { url: HOOK } }));
  // a fetch that fails with the URL in its error, like undici does for some failures
  const leaky: typeof fetch = async (url) => {
    throw Object.assign(new Error(`request to ${String(url)} failed`), { cause: new Error(`connect ECONNREFUSED ${String(url)}`) });
  };
  const c = createChecker({ ...h.deps, channel: () => loadChannel(channelFile), send: httpSender(leaky) });
  const result = await c.test();
  const status = await c.status();
  const log = await readFile(h.deps.logPath!, 'utf8');
  for (const out of [JSON.stringify(result), JSON.stringify(status), log]) {
    assert.ok(!out.includes(TOPIC), out);
    assert.ok(!out.includes(HOOK), out);
    assert.ok(!out.includes('XXXXSECRET'), out);
  }
  assert.equal(result.ok, false);
  assert.deepEqual(status.channel, { configured: true, kinds: ['ntfy', 'webhook'] });
  assert.match(result.message, /\*\*\*/);
});

test('httpSender: ntfy JSON publish (UTF-8 safe), high priority for down, Slack-style webhook', async () => {
  const calls: { url: string; body: any; headers: any }[] = [];
  const fake: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers });
    return new Response('ok', { status: 200 });
  };
  const send = httpSender(fake);
  const sent = await send({ ...CHANNEL, webhookUrl: HOOK }, { key: 'port:1', kind: 'down', title: 'portboard: 1 한글 is down', body: 'b', high: true });
  assert.deepEqual(sent, [{ channel: 'ntfy', ok: true }, { channel: 'webhook', ok: true }]);
  assert.equal(calls[0].url, 'https://ntfy.example.com/');
  assert.deepEqual(calls[0].body, { topic: TOPIC, title: 'portboard: 1 한글 is down', message: 'b', priority: 4, tags: ['warning'] });
  assert.deepEqual(calls[1].body, { text: 'portboard: 1 한글 is down\nb' });
  await send(CHANNEL, { key: 'port:1', kind: 'recovered', title: 't', body: 'b', high: false });
  assert.deepEqual([calls[2].body.priority, calls[2].body.tags], [3, ['white_check_mark']]);
});

test('prefs: alert flag on ports, deviceAlerts kept across port edits', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'portboard-')), 'prefs.json');
  await setDeviceAlert('desktop-pc', true, path);
  await setPortPrefs(8780, { alert: true, label: 'uploader' }, path);
  let prefs = await loadPrefs(path);
  assert.deepEqual(prefs.ports, { 8780: { alert: true, label: 'uploader' } });
  assert.deepEqual(prefs.deviceAlerts, { 'desktop-pc': true });
  await setPortPrefs(8780, { alert: false }, path);
  await setDeviceAlert('desktop-pc', false, path);
  prefs = await loadPrefs(path);
  assert.deepEqual(prefs.ports, { 8780: { label: 'uploader' } });
  assert.equal(prefs.deviceAlerts, undefined);
});

test('MCP set_alert validates and calls the core', async () => {
  const calls: string[] = [];
  const core = { setAlert: async (port: number, on: boolean) => (calls.push(`${port} ${on}`), on) } as unknown as Core;
  const r = await callTool('set_alert', { port: 8780, on: true }, core);
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, port: 8780, alert: true });
  assert.equal((await callTool('set_alert', { port: 8780 }, core)).isError, true);
  assert.equal((await callTool('set_alert', { port: 0, on: true }, core)).isError, true);
  assert.deepEqual(calls, ['8780 true']);
});
