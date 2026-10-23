import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PortEntry, Snapshot } from '../src/core/index.ts';
import type { Core } from '../src/mcp/tools.ts';
import { handleMessage } from '../src/mcp/rpc.ts';
import { checkArgs, getPrompt, PROMPTS } from '../src/mcp/prompts.ts';
import { parseResourceUri, statusReport } from '../src/mcp/resources.ts';
import { childEnv } from './fixtures/child-env.ts';

function entry(over: Partial<PortEntry>): PortEntry {
  return {
    port: 0, listening: true, scope: 'loopback', addresses: ['127.0.0.1'], owned: true, kind: 'app', container: null,
    composeProject: null, processes: [], systemOwner: null, group: null, role: null, name: 'x', detectedName: 'x',
    label: null, pinned: false, hidden: false, visible: true, probe: null, served: null,
    urls: { direct: null, served: null, ssh: '' }, canExpose: false, exposeBlocker: null, control: null,
    canRestart: false, canStop: false,
    ...over,
  } as PortEntry;
}

const snap: Snapshot = {
  at: '2026-10-17T00:00:00.000Z',
  host: { hostname: 'box', user: 'me' },
  tailscale: { available: true, dnsName: 'box.tail.ts.net', hostName: 'box', ips: [] },
  ports: [
    entry({ port: 22, scope: 'all', owned: false, kind: 'system', visible: false, name: 'SSH (sshd)' }),
    entry({ port: 3000, name: 'web' }),
    entry({ port: 8780, name: 'acme', alert: true } as Partial<PortEntry>),
    entry({ port: 9000, name: 'gone', listening: false }),
  ],
};

const pool = (name: string, state: string) => ({ name, kind: 'ssh', addresses: [], state, inRotation: state === 'ok', slots: 1, busy: 0 });

const devices: any = {
  at: 'now',
  pool: { available: true, source: 'hosts', url: 'x', healthAt: 1 },
  devices: [
    { id: 'box', name: 'box', self: true, online: true, pool: pool('box', 'ok') },
    { id: 'desktop', name: 'desktop', self: false, online: true, pool: pool('desktop', 'host-down') },
    { id: 'iphone', name: 'iphone', self: false, online: false, pool: null },
  ],
  proxmox: { configured: false, ok: false, hosts: [] },
};

const usage: any = {
  at: 'now',
  cards: [
    { id: 'iphone', name: 'iphone', kind: 'tailnet', nameKey: null, nameSource: null, online: true, uses: [{ port: 3000, service: 'web' }] },
    { id: 'lan:192.168.1.7', name: 'NAS', kind: 'lan', nameKey: 'mac:aa:bb:cc:dd:ee:ff', nameSource: 'user', online: true, uses: [{ port: 22, service: 'SSH' }] },
  ],
  local: { connections: 0, uses: [] },
  byPort: {
    22: [{ id: 'lan:192.168.1.7', name: 'NAS', kind: 'lan', connections: 1 }],
    3000: [{ id: 'iphone', name: 'iphone', kind: 'tailnet', connections: 2 }, { id: 'iphone', name: 'iphone', kind: 'tailnet', connections: 1 }],
  },
  idle: [{ port: 8780, service: 'acme', group: null }],
  idleServices: 1,
  history: { startedAt: null, byPort: {}, byDevice: {} },
};

function fakeCore(over: Partial<Core> = {}) {
  const calls: string[] = [];
  const core: Core = {
    snapshot: async () => (calls.push('snapshot'), snap),
    devices: async () => (calls.push('devices'), devices),
    usage: async () => (calls.push('usage'), usage),
    history: async () => ({ startedAt: null, byPort: {}, byDevice: {} }),
    alerts: async () => ({
      watching: [
        { key: 'port:8780', kind: 'port', port: 8780, name: 'acme', down: true, since: '2026-10-17T01:00:00.000Z', alerted: true, quietUntil: null },
        { key: 'port:3000', kind: 'port', port: 3000, name: 'web', down: false, since: null, alerted: false, quietUntil: null },
      ],
    }),
    newDevices: async () => ({
      settings: {} as any, alertsOn: true, seededAt: null, known: 3,
      pending: [{ key: 'k', kind: 'lan', name: 'Apple 기기', vendor: 'Apple', ip: '192.168.1.9', cardId: null, nameKey: null, scope: 'connection', since: '2026-10-17T02:00:00.000Z', service: { port: 3000, name: 'web' }, notified: null }],
    }),
    serviceDetail: async (port) => {
      calls.push(`detail ${port}`);
      if (port !== 3000) return null;
      return { at: 'now', port, name: 'web', listening: true, entry: snap.ports[1], usingNow: [], lastUsed: [], historySince: null, watched: false, watch: null, uptime: null, events: [] };
    },
    expose: async () => ({ ok: true, message: '' }),
    unexpose: async () => ({ ok: true, message: '' }),
    restart: async () => ({ ok: true, message: '' }),
    stop: async () => ({ ok: true, message: '' }),
    logs: async () => ({ ok: true, source: 'x', lines: [] }),
    freePorts: async () => [3001],
    setClientName: async () => null,
    ...over,
  };
  return { core, calls };
}

const rpc = async (method: string, params: unknown, core = fakeCore().core): Promise<any> => handleMessage({ jsonrpc: '2.0', id: 1, method, params }, core);
const read = async (uri: unknown, core = fakeCore().core) => {
  const r = await rpc('resources/read', { uri }, core);
  return r.error ? r : { ...r, json: JSON.parse(r.result.contents[0].text) };
};

test('resources/list: status first, then listening visible ports and every device (ids percent-encoded)', async () => {
  const r = await rpc('resources/list', {});
  const uris = r.result.resources.map((x: any) => x.uri);
  assert.deepEqual(uris, ['portboard://status', 'portboard://port/3000', 'portboard://port/8780', 'portboard://device/box', 'portboard://device/desktop', 'portboard://device/iphone']);
  for (const x of r.result.resources) {
    assert.equal(x.mimeType, 'application/json');
    assert.match(x.name, /^[\w-]+$/, 'names are ASCII');
  }
  assert.equal(r.result.resources[0].title, '서버 상태 요약');
  assert.equal(r.result.resources.at(-1).title, 'iphone (offline)');

  const lan = await rpc('resources/list', {}, fakeCore({ devices: async () => ({ ...devices, devices: [{ ...devices.devices[0], id: 'lan:192.168.1.7' }] }) }).core);
  assert.equal(lan.result.resources.at(-1).uri, 'portboard://device/lan%3A192.168.1.7');
});

test('resources/list survives failing sources: the status entry is always there', async () => {
  const boom = async () => Promise.reject(new Error('down'));
  const r = await rpc('resources/list', {}, fakeCore({ snapshot: boom, devices: boom }).core);
  assert.deepEqual(r.result.resources.map((x: any) => x.uri), ['portboard://status']);
});

test('resources/templates/list: port and device', async () => {
  const r = await rpc('resources/templates/list', {});
  assert.deepEqual(r.result.resourceTemplates.map((t: any) => t.uriTemplate), ['portboard://port/{port}', 'portboard://device/{id}']);
});

test('portboard://status: devices, pool health, services in use, watched ports down, new devices', async () => {
  const { json, result } = await read('portboard://status');
  assert.equal(result.contents[0].uri, 'portboard://status');
  assert.equal(json.host, 'box');
  assert.deepEqual(json.devices, { online: 2, total: 3, offline: ['iphone'] });
  assert.equal(json.pool.healthy, false, 'host-down makes the pool unhealthy');
  assert.deepEqual(json.pool.hosts.map((h: any) => h.state), ['ok', 'host-down']);
  assert.equal(json.services.listening, 2, 'visible listening ports only');
  assert.deepEqual(json.services.inUse, [
    { port: 22, service: 'SSH (sshd)', users: ['NAS'] },
    { port: 3000, service: 'web', users: ['iphone'] },
  ]);
  assert.equal(json.services.idle, 1);
  assert.deepEqual(json.watchedDown, [{ kind: 'port', port: 8780, name: 'acme', since: '2026-10-17T01:00:00.000Z' }]);
  assert.equal(json.newDevices.pending, 1);
  assert.deepEqual(json.newDevices.devices[0], { name: 'Apple 기기', kind: 'lan', since: '2026-10-17T02:00:00.000Z', service: { port: 3000, name: 'web' } });
  assert.deepEqual(json.unavailable, []);
});

test('portboard://status: a source that fails or is missing nulls only its section', async () => {
  const { json } = await read('portboard://status', fakeCore({ devices: async () => Promise.reject(new Error('pool down')), alerts: undefined }).core);
  assert.equal(json.devices, null);
  assert.equal(json.pool, null);
  assert.equal(json.watchedDown, null);
  assert.deepEqual(json.unavailable, ['devices', 'watching']);
  assert.equal(json.services.inUse.length, 2);
});

test('statusReport: an all-ok pool is healthy; agent-busy and agent-away are normal', () => {
  const out = statusReport({
    at: 'now', ports: null, usage: null, watching: null, newDevices: 0,
    devices: { pool: { available: true }, devices: [{ name: 'mac', self: false, online: true, pool: { name: 'mac', state: 'agent-busy', inRotation: false } }] },
  });
  assert.equal(out.pool!.healthy, true);
  assert.equal(out.services, null);
  assert.deepEqual(out.newDevices, { pending: 0 });
});

test('portboard://port/{port}: service_detail report; unknown port is not found; malformed is invalid', async () => {
  const { core, calls } = fakeCore();
  const ok = await read('portboard://port/3000', core);
  assert.equal(ok.json.port, 3000);
  assert.equal(ok.json.service.name, 'web');
  const missing = await read('portboard://port/4444', core);
  assert.equal(missing.error.code, -32002);
  assert.match(missing.error.message, /nothing is known about port 4444/);
  assert.deepEqual(calls, ['detail 3000', 'detail 4444']);
  for (const bad of ['portboard://port/0', 'portboard://port/70000', 'portboard://port/abc', 'portboard://port/80.5']) {
    assert.equal((await read(bad, core)).error.code, -32602, bad);
  }
  assert.deepEqual(calls, ['detail 3000', 'detail 4444'], 'malformed URIs never reach the core');
});

test('portboard://device/{id}: by Tailscale id or name, a LAN card through usage, unknown is not found', async () => {
  const desk = await read('portboard://device/desktop');
  assert.equal(desk.json.device.name, 'desktop');
  assert.equal(desk.json.usage, null);
  const phone = await read('portboard://device/iphone');
  assert.deepEqual(phone.json.usage.usingNow, [3000]);
  const nas = await read('portboard://device/lan%3A192.168.1.7');
  assert.equal(nas.json.device, null);
  assert.equal(nas.json.usage.name, 'NAS');
  assert.equal((await read('portboard://device/nope')).error.code, -32002);
  assert.equal((await read('portboard://device/a%20b')).error.code, -32602);
  assert.equal((await read('portboard://device/%E0%A4%A')).error.code, -32602);
});

test('resources/read: unknown URIs are not found, a non-string uri is invalid', async () => {
  for (const uri of ['portboard://nope', 'portboard://status/x', 'file:///etc/passwd', 'portboard://port/1/2']) {
    assert.equal((await read(uri)).error.code, -32002, uri);
  }
  for (const uri of [undefined, 42, '', null]) assert.equal((await read(uri)).error.code, -32602, String(uri));
  assert.deepEqual(parseResourceUri('portboard://device/pool%3Amac'), { kind: 'device', id: 'pool:mac' });
});

test('prompts/list: four prompts with ASCII names and Korean titles', async () => {
  const r = await rpc('prompts/list', {});
  assert.deepEqual(r.result.prompts.map((p: any) => [p.name, p.title]), [
    ['server_status_summary', '서버 상태 요약'],
    ['port_cleanup', '포트 정리 제안'],
    ['new_dev_server', '새 개발 서버 띄우기'],
    ['why_not_open', '왜 안 열려?'],
  ]);
  for (const p of r.result.prompts) {
    assert.equal(p.text, undefined, 'the text function is not serialised');
    for (const a of p.arguments) assert.equal(typeof a.required, 'boolean');
  }
  assert.deepEqual(r.result.prompts.find((p: any) => p.name === 'why_not_open').arguments.map((a: any) => [a.name, a.required]), [['port', true], ['from', false]]);
});

test('prompts/get: Korean text that names the tools, with the arguments filled in', async () => {
  const s = await rpc('prompts/get', { name: 'server_status_summary' });
  assert.equal(s.result.messages.length, 1);
  assert.equal(s.result.messages[0].role, 'user');
  assert.equal(s.result.messages[0].content.type, 'text');
  assert.match(s.result.messages[0].content.text, /portboard:\/\/status/);
  assert.match(s.result.messages[0].content.text, /요약/);

  const why = (await rpc('prompts/get', { name: 'why_not_open', arguments: { port: '3000', from: 'iPhone' } })).result.messages[0].content.text;
  assert.match(why, /port 3000/);
  assert.match(why, /iPhone/);
  for (const t of ['list_ports', 'tail_logs', 'expose_port', 'who_uses', 'list_devices']) assert.match(why, new RegExp(t));

  const dev = (await rpc('prompts/get', { name: 'new_dev_server', arguments: { preferred: '5173', project: 'web' } })).result.messages[0].content.text;
  assert.match(dev, /free_port\(preferred: 5173\)/);
  assert.match(dev, /expose_port/);
  assert.match(dev, /servedUrl/);
  assert.match((await rpc('prompts/get', { name: 'new_dev_server' })).result.messages[0].content.text, /free_port\(\)/);

  assert.match((await rpc('prompts/get', { name: 'port_cleanup', arguments: { days: '14' } })).result.messages[0].content.text, /14일/);
  assert.match((await rpc('prompts/get', { name: 'port_cleanup' })).result.messages[0].content.text, /7일/);
});

test('prompts/get: argument validation and unknown names are -32602', async () => {
  const err = async (name: unknown, args?: unknown) => (await rpc('prompts/get', { name, arguments: args })).error;
  assert.deepEqual(await err('why_not_open', {}), { code: -32602, message: 'missing required argument: port' });
  assert.deepEqual(await err('why_not_open', { port: '' }), { code: -32602, message: 'missing required argument: port' }, 'blank counts as absent');
  for (const port of ['0', '65536', 'abc', '80.5', '-1', '1e3']) assert.equal((await err('why_not_open', { port }))?.code, -32602, port);
  assert.equal((await err('why_not_open', { port: true }))?.code, -32602);
  assert.equal((await err('new_dev_server', { preferred: '80' }))?.code, -32602, 'preferred starts at 1024');
  assert.equal((await err('port_cleanup', { days: '31' }))?.code, -32602);
  assert.match((await err('why_not_open', { port: '1', bogus: 'x' })).message, /unknown argument/);
  assert.equal((await err('why_not_open', 'port=1'))?.code, -32602);
  assert.deepEqual(await err('rm_rf'), { code: -32602, message: 'unknown prompt: rm_rf' });
  assert.equal((await err(7))?.code, -32602);
  // Lenient where it is harmless: a number for a port, padding, blank optionals.
  const why = PROMPTS.find((p) => p.name === 'why_not_open')!;
  assert.deepEqual(checkArgs(why, { port: 8780, from: '  ' }), { port: '8780' });
  assert.deepEqual(checkArgs(why, { port: ' 0080 ' }), { port: '80' });
  assert.equal(getPrompt('server_status_summary', undefined).description, '서버 상태 요약');
});

test('stdio server: capabilities, templates, prompts and a not-found read, over the real process', async (t) => {
  const { env, done } = await childEnv();
  t.after(done);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'], env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  child.stdin.end(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'resources/templates/list' },
      { jsonrpc: '2.0', id: 3, method: 'prompts/list' },
      { jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'why_not_open', arguments: { port: '8790' } } },
      { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'portboard://nope' } },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\n',
  );
  assert.equal(await exited, 0);
  const byId = new Map(out.trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  assert.equal(byId.get(1).result.protocolVersion, '2024-11-05');
  assert.deepEqual(byId.get(1).result.capabilities, { tools: {}, resources: {}, prompts: {} });
  assert.equal(byId.get(2).result.resourceTemplates.length, 2);
  assert.equal(byId.get(3).result.prompts.length, 4);
  assert.match(byId.get(4).result.messages[0].content.text, /port 8790/);
  assert.equal(byId.get(5).error.code, -32002);
});
