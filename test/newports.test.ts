// New dev-server notices (src/core/newports.ts, src/features/newports.ts): the first look seeds, a new port's onNew
// decides, Portboard's own ports, quiet windows and an `ss` failure never make a notice, port + command is debounced,
// the feed's cursor, and one channel message per look for `notify` (only where alerts may be sent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNewPorts, DEBOUNCE_MS, isSelf, newPortText, type NewPortView } from '../src/core/newports.ts';
import { httpSender, type Channel, type Message } from '../src/core/alerts.ts';
import { look, newPortsFeature } from '../src/features/newports.ts';

const view = (port: number, over: Partial<NewPortView> = {}): NewPortView => ({
  port,
  listening: true,
  name: `app ${port}`,
  onNew: 'notify',
  rules: { from: { onNew: 'default' } },
  processes: [{ pid: 1000 + port, cmdline: 'node /x/node_modules/.bin/vite', project: 'myapp', unit: null }],
  container: null,
  urls: { direct: null, served: null },
  canExpose: true,
  ...over,
});
const self = view(8790, { processes: [{ pid: 1, cmdline: 'node src/server.ts', project: 'portboard', unit: 'portboard.service' }] });

function clock(start = 1_760_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('the first look seeds: nothing that was already listening is new (Portboard restarting never notifies)', () => {
  const c = clock();
  const np = createNewPorts({ now: c.now, selfPid: 1 });
  assert.deepEqual(np.observe([self, view(5173), view(3001)]), []);
  c.advance(15_000);
  assert.deepEqual(np.observe([self, view(5173), view(3001)]), []);
  const added = np.observe([self, view(5173), view(3001), view(5191)]);
  assert.deepEqual(added.map((e) => [e.port, e.action, e.command, e.project, e.rule, e.open, e.canExpose]), [[5191, 'notify', 'node /x/node_modules/.bin/vite', 'myapp', 'default', null, true]]);
});

test('onNew decides: notify and openBrowserOnce make events, silent and ignore do not', () => {
  const np = createNewPorts({ selfPid: 1 });
  np.observe([self]);
  const added = np.observe([
    self,
    view(3001, { onNew: 'notify', urls: { direct: 'http://h.ts.net:3001', served: null } }),
    view(3002, { onNew: 'openBrowserOnce', rules: { from: { onNew: 'rule:3000-3010' } } }),
    view(3003, { onNew: 'silent' }),
    view(3004, { onNew: 'ignore' }),
  ]);
  assert.deepEqual(added.map((e) => [e.port, e.action, e.rule, e.open]), [[3001, 'notify', 'default', 'http://h.ts.net:3001'], [3002, 'openBrowserOnce', 'rule:3000-3010', null]]);
});

test("Portboard's own ports, quiet windows (restart_service) and a failed ss never make a notice", () => {
  const c = clock();
  const np = createNewPorts({ now: c.now, selfPid: 4242 });
  np.observe([view(5173)]);
  // its own units and process: a preview or the remote server coming up is not a dev server
  const own = [
    view(8794, { processes: [{ pid: 7, cmdline: 'node src/remote.ts', project: 'portboard', unit: 'portboard-remote.service' }] }),
    view(8808, { processes: [{ pid: 4242, cmdline: 'node src/server.ts', project: 'portboard', unit: null }] }),
    // a preview or a launchd agent: no unit and another pid; the snapshot marked it (PortEntry.isPortboard)
    view(8830, { processes: [{ pid: 900, cmdline: 'node src/server.ts', project: 'portboard', unit: null }], isPortboard: true }),
  ];
  assert.ok(own.every((p) => isSelf(p, 4242)));
  assert.ok(!isSelf(view(5173, { processes: [{ pid: 9, cmdline: 'x', project: null, unit: 'pb-dev-5173.service' }] }), 4242), "Portboard's transient dev units are dev servers");
  assert.deepEqual(np.observe([view(5173), ...own]), []);
  // restarted through Portboard: quiet.json has the port until a moment from now
  assert.deepEqual(np.observe([view(5173), ...own, view(3001)], { 3001: c.now() + 60_000 }), []);
  // `ss` failed: an empty list is not "everything went away", so nothing is new on the next look either
  assert.deepEqual(np.observe([]), []);
  assert.deepEqual(np.observe([view(5173), ...own, view(3001)]), []);
  assert.deepEqual(np.observe([view(5173, { listening: false })]), [], 'only serve entries left: same as a failed ss');
});

test('debounce: the same port and command again within DEBOUNCE_MS is quiet; after it, or with another command, it notifies', () => {
  const c = clock();
  const np = createNewPorts({ now: c.now, selfPid: 1 });
  np.observe([self]);
  assert.equal(np.observe([self, view(5173)]).length, 1);
  c.advance(15_000);
  np.observe([self]); // the dev server restarts on a file change
  c.advance(15_000);
  assert.equal(np.observe([self, view(5173)]).length, 0, 'same port + command: debounced');
  c.advance(15_000);
  np.observe([self]);
  const other = view(5173, { processes: [{ pid: 2, cmdline: 'node /y/node_modules/.bin/astro dev', project: 'site', unit: null }] });
  assert.equal(np.observe([self, other]).length, 1, 'another command on the same port is another server');
  c.advance(DEBOUNCE_MS);
  np.observe([self]);
  assert.equal(np.observe([self, view(5173)]).length, 1, 'after the window it notifies again');
});

test('feed: no since → only the cursor; since → newer events; ids keep growing across a restart', () => {
  const c = clock();
  const np = createNewPorts({ now: c.now, selfPid: 1 });
  const start = np.feed();
  assert.deepEqual(start, { latest: c.now() - 1, events: [] });
  np.observe([self]);
  const [a] = np.observe([self, view(3001)]);
  const [b] = np.observe([self, view(3001), view(3002)]);
  assert.equal(b.id, a.id + 1);
  assert.deepEqual(np.feed(), { latest: b.id, events: [] });
  assert.deepEqual(np.feed(start.latest).events.map((e) => e.port), [3001, 3002]);
  assert.deepEqual(np.feed(a.id).events.map((e) => e.port), [3002]);
  c.advance(60_000);
  const restarted = createNewPorts({ now: c.now, selfPid: 1 });
  assert.ok(restarted.feed().latest > b.id, "a restarted server's cursor is past every old id");
});

test('newPortText: one port gets 열기 or tailnet 공개 and a tap target on its row; several are one message; no command lines', () => {
  const np = createNewPorts({ selfPid: 1 });
  np.observe([self]);
  const [loop] = np.observe([self, view(5173)]);
  const m = newPortText([loop], 'https://h.ts.net:8443/');
  assert.equal(m.kind, 'new-port');
  assert.match(m.title, /5173 app 5173/);
  assert.equal(m.click, 'https://h.ts.net:8443/#5173');
  assert.deepEqual(m.actions, [{ action: 'http', label: 'tailnet 공개', url: 'https://h.ts.net:8443/api/ports/5173/expose', method: 'POST', headers: { 'X-Portboard': '1' }, clear: true }]);
  assert.ok(!m.body.includes('vite'), 'never the command line');
  const [open] = np.observe([self, view(5173), view(3001, { urls: { direct: null, served: 'https://h.ts.net:3001' } })]);
  assert.deepEqual(newPortText([open], null).actions, [{ action: 'view', label: '열기', url: 'https://h.ts.net:3001' }]);
  const many = newPortText([loop, open], 'https://h.ts.net:8443');
  assert.match(many.title, /2개/);
  assert.equal(many.actions, undefined);
  assert.equal(many.click, 'https://h.ts.net:8443/');
});

test('httpSender passes ntfy actions through (and leaves them out when there are none)', async () => {
  const bodies: any[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response('', { status: 200 });
  }) as typeof fetch;
  const c: Channel = { ntfyServer: 'https://ntfy.example', ntfyTopic: 'topic_1', webhookUrl: null };
  const m: Message = { key: 'new-port:5173', kind: 'new-port', title: 't', body: 'b', high: false, actions: [{ action: 'view', label: '열기', url: 'https://x' }] };
  await httpSender(f)(c, m);
  await httpSender(f)(c, { ...m, actions: undefined });
  assert.deepEqual(bodies[0].actions, [{ action: 'view', label: '열기', url: 'https://x' }]);
  assert.deepEqual(bodies[0].tags, ['rocket']);
  assert.equal('actions' in bodies[1], false);
});

test('look: one message per look for the notify events, only with alerts on and a channel; logged like other alerts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-newports-'));
  const logPath = join(dir, 'alerts.jsonl');
  const sent: Message[] = [];
  const channel: Channel = { ntfyServer: 'https://ntfy.example', ntfyTopic: 'topic_1', webhookUrl: null };
  let ports = [self, view(5173)];
  const deps = (alertsOn: boolean) => ({
    ports: async () => ports,
    quiet: async () => ({}),
    alertsOn,
    channel: async () => channel,
    send: async (_c: Channel, m: Message) => {
      sent.push(m);
      return [{ channel: 'ntfy' as const, ok: true }];
    },
    dashboard: async () => 'https://h.ts.net:8443',
    logPath,
  });
  const np = createNewPorts({ selfPid: 1 });
  assert.deepEqual(await look(np, deps(true)), []);
  ports = [self, view(5173), view(3001), view(3002), view(3003, { onNew: 'openBrowserOnce' })];
  assert.equal((await look(np, deps(true))).length, 3);
  assert.equal(sent.length, 1, 'one message for the look');
  assert.match(sent[0].title, /2개/, 'openBrowserOnce is not pushed');
  assert.match(await readFile(logPath, 'utf8'), /"kind":"new-port"/);
  ports = [...ports, view(3004)];
  assert.equal((await look(np, deps(false))).length, 1, 'a preview still makes the event');
  assert.equal(sent.length, 1, '...but sends nothing');
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/new-ports: a cursor without since, events after it with since, 400 on a bad since; the job runs in every profile', async () => {
  const route = newPortsFeature.routes!.find((r) => r.path === '/api/new-ports')!;
  const get = (q: string) => route.handler({ url: new URL(`http://x/api/new-ports${q}`), params: {} as any, body: null, req: {} as any }, {} as any);
  const first = await get('');
  assert.equal(first.status, 200);
  assert.deepEqual((first.body as any).events, []);
  assert.equal(typeof (first.body as any).latest, 'number');
  assert.equal((await get(`?since=${(first.body as any).latest}`)).status, 200);
  assert.equal((await get('?since=abc')).status, 400);
  const job = newPortsFeature.jobs!.find((j) => j.name === 'new-ports')!;
  assert.equal(job.enabled, undefined, 'events in previews too; the message is gated by alertsOn');
});
