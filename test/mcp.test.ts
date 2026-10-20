import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ActionResult, PortEntry, Snapshot } from '../src/core/index.ts';
import { callTool, parsePort, type Core } from '../src/mcp/tools.ts';
import { parseListArgs, summarize } from '../src/mcp/views.ts';
import { handleMessage } from '../src/mcp/rpc.ts';

function entry(over: Partial<PortEntry>): PortEntry {
  return {
    port: 0,
    listening: true,
    scope: 'loopback',
    addresses: ['127.0.0.1'],
    owned: true,
    kind: 'app',
    container: null,
    composeProject: null,
    processes: [],
    systemOwner: null,
    group: null,
    role: null,
    name: 'x',
    detectedName: 'x',
    label: null,
    pinned: false,
    hidden: false,
    visible: true,
    probe: null,
    served: null,
    urls: { direct: null, served: null, ssh: '' },
    canExpose: false,
    exposeBlocker: null,
    control: null,
    canRestart: false,
    canStop: false,
    ...over,
  } as PortEntry;
}

const snap: Snapshot = {
  at: '2026-10-17T00:00:00.000Z',
  host: { hostname: 'box', user: 'me' },
  tailscale: { available: true, dnsName: 'box.tail.ts.net', hostName: 'box', ips: [] },
  ports: [
    entry({ port: 22, scope: 'all', owned: false, kind: 'system', visible: false, name: 'sshd', exposeBlocker: 'already reachable on tailnet' }),
    entry({
      port: 3000,
      scope: 'all',
      container: 'web_next',
      name: 'docker: web_next',
      probe: { http: true, status: 307, title: null },
      urls: { direct: 'http://box.tail.ts.net:3000', served: null, ssh: '' },
      exposeBlocker: 'already reachable on tailnet',
    }),
    entry({
      port: 8780,
      name: 'acme',
      probe: { http: true, status: 200, title: 'ACME Control' },
      processes: [{ pid: 1, cmdline: 'node', cwd: null, project: 'acme', unit: 'acme.service', unitDescription: null }],
      canExpose: true,
      control: { type: 'systemd', unit: 'acme.service' },
      canRestart: true,
      canStop: true,
    }),
    entry({ port: 5432, name: 'postgres', probe: null, exposeBlocker: 'not an HTTP server' }),
  ],
};

function fakeCore(results: Partial<Record<'expose' | 'unexpose' | 'restart' | 'stop', ActionResult>> = {}) {
  const calls: string[] = [];
  const core: Core = {
    snapshot: async () => snap,
    expose: async (port) => (calls.push(`expose ${port}`), results.expose ?? { ok: true, message: 'ok' }),
    unexpose: async (port) => (calls.push(`unexpose ${port}`), results.unexpose ?? { ok: true, message: 'ok' }),
    restart: async (port) => (calls.push(`restart ${port}`), results.restart ?? { ok: true, message: 'ok' }),
    stop: async (port) => (calls.push(`stop ${port}`), results.stop ?? { ok: true, message: 'ok' }),
    logs: async (port, lines) => (calls.push(`logs ${port} ${lines}`), { ok: true, source: 'journalctl', lines: ['a', 'b'] }),
    freePorts: async (count, preferred) => (calls.push(`free ${count} ${preferred}`), [3001]),
    devices: async () => (calls.push('devices'), { at: 'now', pool: { available: false, source: null, url: 'x', healthAt: null }, devices: [] }),
    usage: async () => { throw new Error('not used here'); },
    history: async () => ({ startedAt: null, byPort: {}, byDevice: {} }),
    setClientName: async (key, name) => calls.push(`name ${key} ${name}`),
  };
  return { core, calls };
}

const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

test('summarize hides system ports by default and reports how many', () => {
  const s = summarize(snap);
  assert.deepEqual(s.ports.map((p) => p.port), [3000, 8780, 5432]);
  assert.equal(s.hiddenPorts, 1);
  assert.equal(s.tailnet, 'box.tail.ts.net');
  assert.deepEqual(summarize(snap, { include_system: true }).ports.map((p) => p.port), [22, 3000, 8780, 5432]);
});

test('summarize returns the compact per-port shape', () => {
  const [web, acme, pg] = summarize(snap).ports;
  assert.deepEqual(web, {
    port: 3000,
    name: 'docker: web_next',
    listening: true,
    scope: 'all',
    kind: 'app',
    label: null,
    pinned: false,
    alert: false,
    http: 307,
    directUrl: 'http://box.tail.ts.net:3000',
    servedUrl: null,
    canExpose: false,
    exposeBlocker: 'already reachable on tailnet',
    control: null,
    canRestart: false,
    canStop: false,
  });
  assert.equal(acme.http, 200);
  assert.equal(acme.canExpose, true);
  assert.equal(acme.control, 'systemd: acme.service');
  assert.equal(acme.canRestart, true);
  assert.equal(pg.http, null);
});

test('summarize query matches port, name, container, title, project and unit, case-insensitively', () => {
  const ports = (query: string) => summarize(snap, { query }).ports.map((p) => p.port);
  assert.deepEqual(ports('878'), [8780]);
  assert.deepEqual(ports('WEB_NEXT'), [3000]);
  assert.deepEqual(ports('acme control'), [8780]);
  assert.deepEqual(ports('acme.service'), [8780]);
  assert.deepEqual(ports('postgres'), [5432]);
  assert.deepEqual(ports('sshd'), []); // system, hidden
  assert.deepEqual(summarize(snap, { query: 'sshd', include_system: true }).ports.map((p) => p.port), [22]);
  assert.deepEqual(ports('  '), [3000, 8780, 5432]);
});

test('parsePort accepts integers and digit strings in range only', () => {
  assert.deepEqual(parsePort({ port: 8780 }), { ok: true, value: 8780 });
  assert.deepEqual(parsePort({ port: '8780' }), { ok: true, value: 8780 });
  for (const bad of [{}, { port: 0 }, { port: 65536 }, { port: 80.5 }, { port: '80a' }, { port: '' }, { port: null }, null, undefined]) {
    assert.equal(parsePort(bad).ok, false, JSON.stringify(bad));
  }
});

test('parseListArgs checks types', () => {
  assert.deepEqual(parseListArgs(undefined), { ok: true, value: { query: undefined, include_system: undefined } });
  assert.equal(parseListArgs({ query: 3 }).ok, false);
  assert.equal(parseListArgs({ include_system: 'yes' }).ok, false);
  assert.equal(parseListArgs([]).ok, false);
});

test('expose_port passes ActionResult through, enableUrl included, and flags failure as isError', async () => {
  const fail = { ok: false, message: 'Serve is not enabled', enableUrl: 'https://login.tailscale.com/f/serve?node=abc' };
  const { core, calls } = fakeCore({ expose: fail });
  const r = await callTool('expose_port', { port: '8780' }, core);
  assert.equal(r.isError, true);
  assert.deepEqual(payload(r), fail);
  assert.deepEqual(calls, ['expose 8780']);

  const ok = await callTool('unexpose_port', { port: 8780 }, core);
  assert.equal(ok.isError, undefined);
  assert.deepEqual(payload(ok), { ok: true, message: 'ok' });
});

test('invalid tool arguments never reach the core', async () => {
  const { core, calls } = fakeCore();
  const r = await callTool('expose_port', { port: 70000 }, core);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /between 1 and 65535/);
  assert.deepEqual(calls, []);
});

test('core exceptions become tool errors', async () => {
  const core: Core = { ...fakeCore().core, snapshot: async () => Promise.reject(new Error('ss missing')) };
  const r = await callTool('list_ports', {}, core);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ss missing/);
});

test('handleMessage: initialize negotiates version, notifications get no reply, unknowns are errors', async () => {
  const { core } = fakeCore();
  const init: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, core);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {}, resources: {}, prompts: {} });
  const future: any = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, core);
  assert.equal(future.result.protocolVersion, '2025-11-25');

  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, core), null);
  assert.deepEqual(await handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, core), { jsonrpc: '2.0', id: 3, result: {} });
  const missing: any = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'sampling/createMessage' }, core);
  assert.equal(missing.error.code, -32601);
  const unknownTool: any = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf' } }, core);
  assert.equal(unknownTool.error.code, -32602);

  const list: any = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_ports', arguments: { query: 'acme' } } }, core);
  assert.deepEqual(payload(list.result).ports.map((p: any) => p.port), [8780]);
});

test('stdio server answers initialize and tools/list, then exits when stdin closes', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  child.stdin.end(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\n',
  );
  assert.equal(await exited, 0);
  const replies = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(replies.map((r) => r.id).sort(), [1, 2]);
  const tools = replies.find((r) => r.id === 2).result.tools;
  assert.deepEqual(tools.map((t: any) => t.name), [
    'list_ports',
    'expose_port',
    'unexpose_port',
    'restart_service',
    'stop_service',
    'tail_logs',
    'list_devices',
    'who_uses',
    'list_usage',
    'name_device',
    'free_port',
    'set_alert',
    'list_new_devices',
    'service_detail',
    'list_cleanup_candidates',
    'cleanup_servers',
    'list_worktrees',
    'remove_worktrees',
    'list_reservations',
    'reserve_port',
    'release_port',
    'list_dev_servers',
    'start_dev_server',
    'stop_dev_server',
    'write_launch_config',
    'setup_status',
    'digest_preview',
    'set_digest',
    'list_suggestions',
    'adoption_stats',
    'list_port_rules',
    'set_port_rule',
    'memory_usage',
  ]);
});

test('restart_service / stop_service route to the core and pass failures through as isError', async () => {
  const { core, calls } = fakeCore({ stop: { ok: false, message: 'refusing to stop portboard itself' } });
  assert.equal((await callTool('restart_service', { port: 8780 }, core)).isError, undefined);
  const stopped = await callTool('stop_service', { port: '8790' }, core);
  assert.equal(stopped.isError, true);
  assert.match(stopped.content[0].text, /portboard itself/);
  assert.deepEqual(calls, ['restart 8780', 'stop 8790']);
});

test('tail_logs and free_port validate optional integers', async () => {
  const { core, calls } = fakeCore();
  assert.deepEqual(payload(await callTool('tail_logs', { port: 8780 }, core)).lines, ['a', 'b']);
  await callTool('tail_logs', { port: 8780, lines: '20' }, core);
  assert.equal((await callTool('tail_logs', { port: 8780, lines: 5000 }, core)).isError, true);
  assert.deepEqual(payload(await callTool('free_port', {}, core)), { ports: [3001] });
  await callTool('free_port', { preferred: 8000, count: 3 }, core);
  assert.equal((await callTool('free_port', { preferred: 80 }, core)).isError, true);
  assert.deepEqual(calls, ['logs 8780 100', 'logs 8780 20', 'free 1 undefined', 'free 3 8000']);
});

test('pinned or user-visible entries show; hidden ones only with include_system', () => {
  const s2: Snapshot = {
    ...snap,
    ports: [entry({ port: 4000, hidden: true, visible: false }), entry({ port: 46389, kind: 'ephemeral', pinned: true, visible: true })],
  };
  assert.deepEqual(summarize(s2).ports.map((p) => p.port), [46389]);
  assert.equal(summarize(s2).hiddenPorts, 1);
  assert.deepEqual(summarize(s2, { include_system: true }).ports.map((p) => p.port), [4000, 46389]);
});

test('list_devices returns the core document', async () => {
  const { core, calls } = fakeCore();
  const r = await callTool('list_devices', {}, core);
  assert.equal(r.isError, undefined);
  assert.deepEqual(payload(r).devices, []);
  assert.deepEqual(calls, ['devices']);
});
