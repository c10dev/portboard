import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, TOOLS } from '../src/mcp/tools.ts';
import { callRemoteTool, handleRemoteMessage, readOnlyCore, REMOTE_INSTRUCTIONS, REMOTE_PROMPTS, REMOTE_TOOL_NAMES, REMOTE_TOOLS, type RemoteCore } from '../src/remote/tools.ts';
import { PROMPTS } from '../src/mcp/prompts.ts';

const WRITE_OR_LOGS = ['expose_port', 'unexpose_port', 'restart_service', 'stop_service', 'tail_logs', 'start_dev_server', 'stop_dev_server', 'remove_worktrees'];

function fakeCore(): RemoteCore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    snapshot: async () => {
      calls.push('snapshot');
      return { at: 'now', host: { hostname: 'box', user: 'me' }, tailscale: { available: false, dnsName: null, hostName: null, ips: [] } as any, ports: [] };
    },
    devices: async () => {
      calls.push('devices');
      return { at: 'now', pool: { available: false, source: null, url: '', healthAt: null, hosts: [] } as any, devices: [], proxmox: { configured: false, ok: false, hosts: [] } };
    },
    freePorts: async (count) => {
      calls.push('freePorts');
      return Array.from({ length: count }, (_, i) => 3000 + i);
    },
    usage: async () => {
      calls.push('usage');
      return { at: 'now', observingSince: 'then', cards: [], local: { connections: 0, uses: [] }, byPort: {}, idleServices: 0 } as any;
    },
  };
}

test('tools/list exposes exactly the allowlist, all read-only', async () => {
  const reply: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, fakeCore());
  const names = reply.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, [...REMOTE_TOOL_NAMES].sort());
  for (const t of reply.result.tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    for (const w of WRITE_OR_LOGS) assert.doesNotMatch(t.description, new RegExp(w), `${t.name} mentions ${w}`);
  }
});

test('allowlist drift: every shared remote tool exists in TOOLS and is read-only there too', () => {
  for (const name of REMOTE_TOOL_NAMES) {
    if (name === 'who_uses_what') continue;
    const shared = TOOLS.find((t) => t.name === name);
    assert.ok(shared, `${name} missing from src/mcp/tools.ts`);
    assert.equal(shared.annotations.readOnlyHint, true, `${name} is not read-only in src/mcp/tools.ts`);
  }
  for (const w of WRITE_OR_LOGS) assert.equal(REMOTE_TOOL_NAMES.has(w), false, w);
  assert.equal(REMOTE_TOOLS.length, REMOTE_TOOL_NAMES.size);
});

test('tools/call on write tools and logs is refused like an unknown tool, before touching the core', async () => {
  for (const name of [...WRITE_OR_LOGS, 'set_prefs', 'no_such_tool']) {
    const core = fakeCore();
    const reply: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: { port: 8780 } } }, core);
    assert.deepEqual(reply.error, { code: -32602, message: `unknown tool: ${name}` }, name);
    assert.deepEqual(core.calls, [], name);
  }
});

test('layer 3: the core handed to shared code cannot write or read logs', async () => {
  const core = readOnlyCore(fakeCore());
  for (const m of ['expose', 'unexpose', 'restart', 'stop'] as const) await assert.rejects(core[m](8780), /not available remotely/);
  await assert.rejects(core.logs(8780, 10), /not available remotely/);
  // Even if the allowlist were bypassed, the shared dispatcher would only get an error back.
  const r = await callTool('stop_service', { port: 8780 }, core);
  assert.equal(r.isError, true);
});

test('allowed tools answer through the redaction layer', async () => {
  const core = fakeCore();
  const ports: any = await callRemoteTool('list_ports', {}, core);
  assert.deepEqual(JSON.parse(ports.content[0].text).ports, []);
  const free: any = await callRemoteTool('free_port', { count: 2, preferred: 3000 }, core);
  assert.deepEqual(JSON.parse(free.content[0].text), { ports: [3000, 3001] });
  const bad: any = await callRemoteTool('free_port', { count: 99 }, core);
  assert.equal(bad.isError, true);
  const who: any = await callRemoteTool('who_uses_what', { port: 22 }, core);
  assert.deepEqual(JSON.parse(who.content[0].text).users, []);
  assert.deepEqual(core.calls, ['snapshot', 'freePorts', 'usage']);
});

test('#8 worktrees, dev servers and memory: read from RemoteCore only, read-only listed, and fail closed', async () => {
  for (const name of ['list_worktrees', 'list_dev_servers', 'memory_usage']) {
    const t = REMOTE_TOOLS.find((x) => x.name === name)!;
    assert.equal(t.annotations.readOnlyHint, true, name);
    assert.doesNotMatch(t.description, /\b(start_dev_server|stop_dev_server|remove_worktrees|refresh)\b/, `${name}: the remote description names nothing it can't do`);
    // A core without the method (an older remote.ts) answers an error, never the local tool through shared code.
    const r: any = await callRemoteTool(name, {}, fakeCore());
    assert.equal(r.isError, true, name);
    assert.equal(r.content[0].text, `${name} is not available here`);
  }
  assert.deepEqual(Object.keys((REMOTE_TOOLS.find((x) => x.name === 'list_worktrees')!.inputSchema as any).properties), ['repo', 'removable_only'], 'no refresh remotely');

  const calls: string[] = [];
  const core: RemoteCore = {
    ...fakeCore(),
    worktrees: async () => (calls.push('worktrees'), null),
    devServers: async () => (calls.push('devServers'), { running: [], startable: { '/home/me/projects/web': { scripts: { dev: 'vite' }, preferred: 'dev', owner: 'web@main' } } }),
    memory: async () => (calls.push('memory'), null),
  };
  const wt: any = await callRemoteTool('list_worktrees', { repo: 'web' }, core);
  assert.deepEqual(JSON.parse(wt.content[0].text).repos, [], 'no saved scan yet: an empty answer with a note, not a scan');
  const refresh: any = await callRemoteTool('list_worktrees', { refresh: true }, core);
  assert.equal(refresh.isError, true, 'refresh would start a scan: refused');
  const bad: any = await callRemoteTool('list_worktrees', { repo: 3 }, core);
  assert.equal(bad.isError, true);
  const dev: any = await callRemoteTool('list_dev_servers', {}, core);
  assert.deepEqual(JSON.parse(dev.content[0].text), { running: [], startable: [{ owner: 'web@main', scripts: ['dev'], preferred: 'dev' }] });
  const mem: any = await callRemoteTool('memory_usage', { top: 5 }, core);
  assert.equal(JSON.parse(mem.content[0].text).at, null);
  const badTop: any = await callRemoteTool('memory_usage', { top: 99 }, core);
  assert.equal(badTop.isError, true);
  assert.deepEqual(calls, ['worktrees', 'devServers', 'memory']);

  // The writes next to them stay refused, before touching the core.
  for (const name of ['start_dev_server', 'stop_dev_server', 'remove_worktrees']) {
    const r: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name, arguments: { path: '/x', repo: '/x', paths: ['/x'] } } }, core);
    assert.deepEqual(r.error, { code: -32602, message: `unknown tool: ${name}` }, name);
  }
  assert.deepEqual(calls, ['worktrees', 'devServers', 'memory']);
});

test('core errors come back generic (no paths or addresses)', async () => {
  const core = { ...fakeCore(), devices: async () => Promise.reject(new Error('ENOENT /home/me/.config/portboard/proxmox.json 192.168.1.2')) };
  const r: any = await callRemoteTool('list_devices', {}, core);
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'list_devices failed on the server');
});

test('initialize carries read-only instructions; ping, unknown methods and notifications are delegated', async () => {
  const init: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, fakeCore());
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.instructions, REMOTE_INSTRUCTIONS);
  for (const w of WRITE_OR_LOGS) assert.doesNotMatch(REMOTE_INSTRUCTIONS, new RegExp(w));
  assert.deepEqual(await handleRemoteMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }, fakeCore()), { jsonrpc: '2.0', id: 2, result: {} });
  const unknown: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 3, method: 'sampling/createMessage' }, fakeCore());
  assert.equal(unknown.error.code, -32601);
  assert.deepEqual(init.result.capabilities, { tools: {}, resources: {}, prompts: {} });
  assert.equal(await handleRemoteMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, fakeCore()), null);
});

// ---- resources and prompts ----

const LOCAL_ONLY_TOOLS = TOOLS.map((t) => t.name).filter((n) => !REMOTE_TOOL_NAMES.has(n));

test('resources: only portboard://status is listed, no templates', async () => {
  const list: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, fakeCore());
  assert.deepEqual(list.result.resources.map((r: any) => r.uri), ['portboard://status']);
  const tpl: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 2, method: 'resources/templates/list' }, fakeCore());
  assert.deepEqual(tpl.result, { resourceTemplates: [] });
});

test('resources/read: port and device URIs fail exactly like an unknown URI, before touching the core', async () => {
  const failure = async (uri: unknown) => {
    const core = fakeCore();
    const r: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri } }, core);
    assert.deepEqual(core.calls, [], String(uri));
    return r.error;
  };
  for (const uri of ['portboard://port/8780', 'portboard://port/abc', 'portboard://device/laptop', 'portboard://device/lan%3A192.168.1.2', 'portboard://nope', 'file:///etc/passwd']) {
    assert.deepEqual(await failure(uri), { code: -32002, message: `resource not found: ${uri}` }, uri);
  }
  assert.equal((await failure(42)).code, -32602);
  assert.equal((await failure(undefined)).code, -32602);
});

test('resources/read portboard://status reads only the read-only sources', async () => {
  const core = fakeCore();
  const r: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'portboard://status' } }, core);
  const out = JSON.parse(r.result.contents[0].text);
  assert.deepEqual(core.calls.sort(), ['devices', 'snapshot', 'usage']);
  assert.deepEqual(out.unavailable, ['watching', 'newDevices'], 'no statusExtras in this core: those sections are null');
});

test('prompts: the two summary prompts only, with texts that name only remote tools', async () => {
  const list: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/list' }, fakeCore());
  assert.deepEqual(list.result.prompts.map((p: any) => p.name), ['server_status_summary', 'port_cleanup']);
  for (const p of list.result.prompts) {
    const local = PROMPTS.find((x) => x.name === p.name)!;
    assert.equal(p.title, local.title, 'same title as the local server');
    assert.deepEqual(p.arguments, [], `${p.name}: no arguments remotely`);
    const got: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: p.name } }, fakeCore());
    const text = got.result.messages[0].content.text;
    assert.equal(got.result.messages[0].role, 'user');
    for (const t of LOCAL_ONLY_TOOLS) assert.doesNotMatch(text, new RegExp(`\\b${t}\\b`), `${p.name} mentions ${t}`);
    assert.doesNotMatch(text, /portboard:\/\/(port|device)/, `${p.name} points at a local-only resource`);
    for (const t of LOCAL_ONLY_TOOLS) assert.doesNotMatch(p.description, new RegExp(`\\b${t}\\b`));
  }
  for (const t of LOCAL_ONLY_TOOLS) assert.doesNotMatch(REMOTE_INSTRUCTIONS, new RegExp(`\\b${t}\\b`), t);
  assert.equal(REMOTE_PROMPTS.length, 2);
});

test('prompts/get: local-only prompts are refused like unknown ones; arguments are checked', async () => {
  for (const name of ['new_dev_server', 'why_not_open', 'no_such_prompt']) {
    const r: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name, arguments: { port: '8780' } } }, fakeCore());
    assert.deepEqual(r.error, { code: -32602, message: `unknown prompt: ${name}` });
  }
  const extra: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'port_cleanup', arguments: { days: '7' } } }, fakeCore());
  assert.equal(extra.error.code, -32602, 'the local days argument does not exist remotely');
});

test('machine_status: from RemoteCore.machines only (the saved list), fresh refused, fails closed without it', async () => {
  const t = REMOTE_TOOLS.find((x) => x.name === 'machine_status')!;
  assert.equal(t.annotations.readOnlyHint, true);
  assert.deepEqual(Object.keys((t.inputSchema as any).properties), ['machine', 'include'], 'no fresh remotely');
  assert.doesNotMatch(t.description, /\b(fresh|where_to_run|find_worktree)\b/);
  const none: any = await callRemoteTool('machine_status', {}, fakeCore());
  assert.deepEqual([none.isError, none.content[0].text], [true, 'machine_status is not available here']);

  const calls: string[] = [];
  const at = new Date().toISOString();
  const saved = {
    at,
    machines: [{
      id: 'devbox', name: 'devbox', kind: 'linux', reach: 'local', online: true, checkedAt: at, stale: false, error: null, load: null,
      claude: { cliVersion: null, active: 0, idle: 0, source: 'proc', sessions: [{ id: 'abcdef12', project: 'p', worktree: 'p@main', idleMin: 1, cpuPct: null, mb: null, startedAt: null, idle: false }] },
      worktrees: [], ports: null, capabilities: [], maxSessions: 4, launch: [{ via: 'local', note: '/home/me' }],
    }],
  } as any;
  let doc: any = null;
  const core: RemoteCore = { ...fakeCore(), machines: async () => (calls.push('machines'), doc) };
  const empty: any = await callRemoteTool('machine_status', {}, core);
  assert.deepEqual(JSON.parse(empty.content[0].text).machines, [], 'nothing saved yet: an empty answer with a note, not a read of the agents');
  doc = saved;
  const out = JSON.parse(((await callRemoteTool('machine_status', { include: ['claude'] }, core)) as any).content[0].text);
  assert.deepEqual(out.machines[0].claude.sessions, [{ idle: false, idleMin: 1, cpuPct: null, mb: null }]);
  assert.equal(out.note, undefined);
  assert.doesNotMatch(JSON.stringify(out), /abcdef12|\/home\/me|p@main/);
  doc = { ...saved, at: new Date(Date.now() - 30 * 60_000).toISOString() };
  assert.match(JSON.parse(((await callRemoteTool('machine_status', {}, core)) as any).content[0].text).note, /30 minutes old/);
  for (const [args, re] of [[{ fresh: true }, /fresh is not available remotely/], [{ machine: 3 }, /machine must be/], [{ include: ['paths'] }, /include must be/], [{ machine: 'nope' }, /no machine named nope/]] as const) {
    const r: any = await callRemoteTool('machine_status', args, core);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, re);
  }
  assert.equal(calls.length, 4, 'fresh, a bad machine and bad include are refused before the core');
  // the local-only machine tools stay unknown remotely, before the core
  for (const name of ['find_worktree', 'where_to_run']) {
    const r: any = await handleRemoteMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: { repo: 'x' } } }, core);
    assert.deepEqual(r.error, { code: -32602, message: `unknown tool: ${name}` }, name);
  }
  assert.equal(calls.length, 4);
});
