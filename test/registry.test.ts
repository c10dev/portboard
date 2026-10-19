// The feature module registry (#21): what it lets through, and the security properties it must keep
// (docs/remote-mcp/SECURITY-REVIEW.md): the remote server only ever offers what is marked remote-safe, every write
// route needs the X-Portboard guard, and a preview never starts the alert checker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRegistry, FEATURES, MODULES, READ_ONLY, REGISTRY, uiTags } from '../src/features/registry.ts';
import { createRouter } from '../src/features/router.ts';
import { isEnabled } from '../src/features/jobs.ts';
import type { FeatureModule, Route, Tool } from '../src/features/types.ts';
import type { ServerContext } from '../src/features/context.ts';
import { resolvePaths } from '../src/core/paths.ts';
import { COLLECTORS } from '../src/core/health.ts';
import { TOOLS } from '../src/mcp/tools.ts';
import { REMOTE_PROMPTS, REMOTE_RESOURCES, REMOTE_TOOL_NAMES, REMOTE_TOOLS, handleRemoteMessage, type RemoteCore } from '../src/remote/tools.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('every entry point imports on its own (no import cycle hides behind test import order)', () => {
  // server.ts loads the registry first, the remote server remote/tools.ts, the stdio server rpc.ts: each must work
  // as the first module loaded.
  for (const f of ['src/features/registry.ts', 'src/remote/tools.ts', 'src/mcp/rpc.ts', 'src/mcp/resources.ts', 'src/mcp/tools.ts', 'src/remote/redact.ts', 'src/remote/http.ts', 'src/mcp/prompts.ts']) {
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(ROOT + f)})`], { stdio: 'pipe' });
  }
});

// ---- the remote surface ----

test('remote: exactly these tools, resources and prompts (changing this list is a security review)', async () => {
  assert.deepEqual(REMOTE_TOOLS.map((t) => t.name), ['list_ports', 'list_devices', 'free_port', 'who_uses_what']);
  assert.deepEqual([...REMOTE_TOOL_NAMES], ['list_ports', 'list_devices', 'free_port', 'who_uses_what']);
  assert.deepEqual(REMOTE_RESOURCES.map((r) => r.uri), ['portboard://status']);
  assert.deepEqual(REMOTE_PROMPTS.map((p) => p.name), ['server_status_summary', 'port_cleanup']);
  const core: RemoteCore = { snapshot: async () => assert.fail(), devices: async () => assert.fail(), freePorts: async () => assert.fail(), usage: async () => assert.fail() };
  const tl = (await handleRemoteMessage({ jsonrpc: '2.0', id: 1, method: 'resources/templates/list' }, core)) as any;
  assert.deepEqual(tl.result.resourceTemplates, []);
});

test('remote: every tool is listed read-only, and a shared one is read-only locally too', () => {
  for (const t of REMOTE_TOOLS) {
    assert.deepEqual(t.annotations, READ_ONLY, t.name);
    const local = REGISTRY.toolByName.get(t.name);
    if (local) assert.equal(local.def.annotations.readOnlyHint, true, `${t.name} is a write tool locally`);
  }
  // and nothing that writes is reachable: every remote name has a remote handler, no other name does
  assert.deepEqual([...REGISTRY.remoteCalls.keys()], REMOTE_TOOLS.map((t) => t.name));
});

const tool = (name: string, readOnlyHint: boolean, remote = false): Tool => ({
  def: { name, title: name, description: name, inputSchema: {}, annotations: { readOnlyHint } },
  call: async () => ({ content: [] }),
  ...(remote ? { remote: { call: async () => ({ content: [] }) } } : {}),
});

test('buildRegistry refuses a write tool marked remote, and a remote-only tool that is not read-only', () => {
  assert.throws(() => buildRegistry([{ name: 'x', tools: [tool('stop_all', false, true)] }]), /stop_all changes things and can't be offered remotely/);
  assert.throws(() => buildRegistry([{ name: 'x', remoteTools: [{ def: tool('nuke', false).def, call: async () => ({ content: [] }) }] }]), /remote tool nuke must be read-only/);
  // read-only is fine, and the remote copy is listed with READ_ONLY whatever the module wrote
  const reg = buildRegistry([{ name: 'x', tools: [tool('peek', true, true)] }]);
  assert.deepEqual(reg.remoteTools[0].annotations, READ_ONLY);
});

test('buildRegistry refuses duplicates and a non-GET route without write: true', () => {
  const handler = async () => ({ status: 200, body: null });
  assert.throws(() => buildRegistry([{ name: 'x', routes: [{ method: 'POST', path: '/api/x', handler } as unknown as Route] }]), /POST \/api\/x must be declared write: true/);
  assert.throws(() => buildRegistry([{ name: 'a', tools: [tool('t', true)] }, { name: 'b', tools: [tool('t', true)] }]), /duplicate tool t/);
  assert.throws(() => buildRegistry([{ name: 'a' }, { name: 'a' }]), /duplicate feature a/);
  assert.throws(() => buildRegistry([{ name: 'a', collectors: ['pool'] }, { name: 'b', collectors: ['pool'] }]), /duplicate collector pool/);
  assert.throws(
    () => buildRegistry([{ name: 'a', routes: [{ method: 'GET', path: '/api/x', handler }] }, { name: 'b', routes: [{ method: 'GET', path: '/api/x', handler }] }]),
    /duplicate route GET \/api\/x/,
  );
});

// ---- the write guard ----

/** A context whose every member throws: a handler that runs answers 500, never 403. */
const untouchable = new Proxy({}, { get: (_t, k) => assert.fail(`handler touched ctx.${String(k)}`) }) as ServerContext;
const request = (method: string, headers: Record<string, string> = {}) => ({ method, headers }) as any;
const concrete = (path: string) => path.replace(':port', '8080').replace(':device', 'mac');

test('every write route in the registry answers 403 without X-Portboard: 1, before its handler runs', async () => {
  const writes = REGISTRY.routes.filter((r) => r.method !== 'GET');
  assert.ok(writes.length >= 10, `only ${writes.length} write routes?`);
  const route = createRouter(REGISTRY.routes);
  for (const r of writes) {
    assert.equal(r.write, true, `${r.path} must say write: true`);
    for (const headers of [{}, { 'x-portboard': '0' }, { 'x-portboard': 'true' }]) {
      const reply = await route(request(r.method, headers), new URL(`http://x${concrete(r.path)}`), untouchable);
      assert.deepEqual(reply, { status: 403, body: { error: 'missing X-Portboard header' } }, `${r.method} ${r.path} ${JSON.stringify(headers)}`);
    }
  }
});

test('router: path, port range, method, guard, body — in that order, as before the registry', async () => {
  const ran: string[] = [];
  const routes: Route[] = [
    { method: 'GET', path: '/api/list', handler: async () => (ran.push('list'), { status: 200, body: 'list' }) },
    { method: 'GET', path: '/api/ports/:port/detail', handler: async ({ params }) => (ran.push(`detail ${params.port}`), { status: 200, body: params.port }) },
    { method: 'POST', path: '/api/ports/:port/act', write: true, body: { limit: 8 }, handler: async ({ body }) => (ran.push('act'), { status: 200, body }) },
    { method: 'POST', path: '/api/devices/:device/alert', write: true, handler: async ({ params }) => ({ status: 200, body: params.device }) },
  ];
  const route = createRouter(routes);
  const at = (method: string, path: string, headers?: Record<string, string>) => route(request(method, headers), new URL(`http://x${path}`), untouchable);
  assert.equal(await at('GET', '/api/nope'), null, 'unknown path: not ours (static / 404 next)');
  assert.equal(await at('POST', '/api/list'), null, 'a GET-only path without parameters never said 405');
  assert.deepEqual(await at('GET', '/api/ports/70000/detail'), { status: 400, body: { error: 'bad port' } });
  assert.deepEqual(await at('POST', '/api/ports/0/act'), { status: 400, body: { error: 'bad port' } });
  assert.equal(await at('GET', '/api/ports/abc/detail'), null);
  assert.deepEqual(await at('POST', '/api/ports/80/detail'), { status: 405, body: { error: 'use GET' } });
  assert.deepEqual(await at('GET', '/api/ports/80/act'), { status: 405, body: { error: 'use POST' } });
  assert.deepEqual(await at('POST', '/api/ports/80/act'), { status: 403, body: { error: 'missing X-Portboard header' } });
  assert.equal(await at('POST', '/api/devices/-x/alert'), null, 'device ids start with a letter or digit');
  assert.deepEqual(await at('GET', '/api/ports/80/detail'), { status: 200, body: 80 });
  assert.deepEqual(ran, ['detail 80']);
});

test('router: a route pattern with an unknown parameter is refused when compiled', () => {
  assert.throws(() => createRouter([{ method: 'GET', path: '/api/:what', handler: async () => ({ status: 200, body: null }) }]), /unknown parameter :what/);
});

// ---- jobs: preview profile ----

test('a preview never starts the alert checker; production does unless PORTBOARD_ALERTS=off', () => {
  const alerts = REGISTRY.jobs.find((j) => j.name === 'alerts');
  assert.ok(alerts, 'the alerts feature declares its checker as a job');
  const at = (env: Record<string, string>) => isEnabled(alerts, resolvePaths(env, '/home/x'));
  assert.equal(at({ PORTBOARD_PORT: '8808' }), false, 'preview');
  assert.equal(at({ PORTBOARD_PORT: '8808', PORTBOARD_PREVIEW_ALERTS: '1' }), true, 'preview with explicit opt-in');
  assert.equal(at({}), true, 'production');
  assert.equal(at({ PORTBOARD_ALERTS: 'off' }), false, 'production with alerts off');
  // what a preview starts, so a new job that should be gated gets noticed here
  const preview = resolvePaths({ PORTBOARD_PORT: '8808' }, '/home/x');
  assert.deepEqual(REGISTRY.jobs.filter((j) => isEnabled(j, preview)).map((j) => j.name), ['usage-sample', 'host-ports', 'selfwatch', 'worktrees-scan', 'adoption-scan', 'new-ports', 'memory']);
});

// ---- consistency ----

test('local tools/list order (FEATURES order) is the order clients have always seen', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), [
    'list_ports', 'expose_port', 'unexpose_port', 'restart_service', 'stop_service', 'tail_logs', 'list_devices',
    'who_uses', 'list_usage', 'name_device', 'free_port', 'set_alert', 'list_new_devices', 'service_detail',
    'list_cleanup_candidates', 'cleanup_servers', 'list_worktrees', 'remove_worktrees',
    'list_reservations', 'reserve_port', 'release_port', 'list_dev_servers', 'start_dev_server', 'stop_dev_server',
    'setup_status',
    'digest_preview', 'set_digest',
    'list_suggestions',
    'adoption_stats',
    'list_port_rules', 'set_port_rule',
    'memory_usage',
  ]);
});

// ---- adding a feature: no shared append point (parallel branches used to conflict on the end of FEATURES) ----

test('registry.ts: feature imports and MODULES are alphabetical, so a new feature goes in its own place, not at the end', () => {
  const src = readFileSync(`${ROOT}src/features/registry.ts`, 'utf8');
  const files = [...src.matchAll(/^import \{ \w+ \} from '\.\/([\w-]+\.ts)';$/gm)].map((m) => m[1]);
  assert.deepEqual(files, [...files].sort(), 'imports from ./<feature>.ts sorted by file name');
  const list = /export const MODULES: FeatureModule\[\] = \[\n([\s\S]*?)\];/.exec(src);
  assert.ok(list, 'MODULES list');
  const ids = list[1].split('\n').map((l) => l.trim().replace(/,$/, '')).filter(Boolean);
  const lower = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
  assert.deepEqual(ids, [...ids].sort(lower), 'MODULES sorted by name, ignoring case');
  assert.equal(ids.length, files.length, 'every imported feature is in MODULES');
  assert.equal(MODULES.length, FEATURES.length);
});

test('every feature has its own order number (two branches picking the same one show up here after the merge)', () => {
  const seen = new Map<number, string>();
  for (const f of MODULES) {
    assert.ok(Number.isFinite(f.order), `${f.name}: order`);
    assert.ok(!seen.has(f.order), `${f.name} and ${seen.get(f.order)} both have order ${f.order}`);
    seen.set(f.order, f.name);
  }
  assert.deepEqual(FEATURES.map((f) => f.order), MODULES.map((f) => f.order).sort((a, b) => a - b));
});

test('each health.ts collector is declared by exactly one feature, and nothing else is', () => {
  assert.deepEqual([...REGISTRY.collectors].sort(), Object.keys(COLLECTORS).sort());
});

test('the stdio server gets every Core method from some feature', () => {
  const core = Object.assign({}, ...FEATURES.map((f: FeatureModule) => f.mcpCore?.() ?? {}));
  assert.deepEqual(Object.keys(core).sort(), [
    'adoption', 'alerts', 'cleanup', 'collection', 'devServers', 'devices', 'digest', 'expose', 'freePorts', 'history', 'logs', 'memory', 'newDevices', 'owners', 'portRules', 'releasePort', 'removeWorktrees', 'reservations', 'reservePort',
    'restart', 'serviceDetail', 'setAlert', 'setClientName', 'setDigest', 'setPortRule', 'setupStatus', 'snapshot', 'startDevServer', 'stop', 'stopDevServer', 'suggestions', 'unexpose', 'usage', 'worktrees',
  ]);
});

test('ui: declared scripts exist, and no page also loads them itself (they would run twice)', () => {
  for (const u of REGISTRY.ui) {
    assert.ok(existsSync(`${ROOT}public/${u.script}`), u.script);
    for (const page of u.pages) {
      // #settings: the 설정 modal, which imports these itself (features/settings-modal.js SECTIONS)
      if (page === '#settings') continue;
      const html = readFileSync(`${ROOT}public/${page}`, 'utf8');
      assert.ok(html.includes('</body>'), `${page} has no </body> to insert before`);
      assert.ok(!html.includes(`src="${u.script}"`), `${page} loads ${u.script} itself`);
    }
  }
  assert.equal(uiTags('index.html'), '  <script src="features/nav.js" type="module"></script>\n  <script src="features/selfwatch.js" type="module"></script>\n  <script src="features/owners.js" type="module"></script>\n  <script src="features/onboarding.js" type="module"></script>\n  <script src="features/digest.js" type="module"></script>\n  <script src="features/suggestions.js" type="module"></script>\n  <script src="features/newports.js" type="module"></script>\n  <script src="features/audit.js" type="module"></script>\n  <script src="features/settings-modal.js" type="module"></script>\n');
  // the shell's sidebar (features/nav.js) is on every page, service.html has nothing else
  // the shell's sidebar (nav) and its footer chips (selfwatch, onboarding) are on every page
  assert.equal(uiTags('service.html'), '  <script src="features/nav.js" type="module"></script>\n  <script src="features/selfwatch.js" type="module"></script>\n  <script src="features/onboarding.js" type="module"></script>\n  <script src="features/newports.js" type="module"></script>\n  <script src="features/settings-modal.js" type="module"></script>\n');
  for (const page of ['devices.html', 'dev.html']) for (const s of ['nav', 'selfwatch', 'onboarding']) assert.ok(uiTags(page).includes(`features/${s}.js`), `${page} ${s}`);
  assert.ok(uiTags('dev.html').includes('<script src="features/adoption.js" type="module"></script>'));
});

test('claude (#42): local REST for the plugin hooks — nothing remote, port-advice is a read route', () => {
  const f = FEATURES.find((x) => x.name === 'claude');
  assert.ok(f);
  assert.ok(!f.tools?.some((t) => t.remote) && !f.remoteTools?.length && !f.remoteResources && !f.remotePrompts?.length);
  assert.ok(f.routes?.some((r) => r.method === 'GET' && r.path === '/api/claude/port-advice'));
  assert.ok(f.routes?.every((r) => r.path.startsWith('/api/claude/')));
});

test('claude-session (#43): after the 0.9.0 features, no tools, ui or jobs; its routes, and session-end is a guarded write', () => {
  const names = FEATURES.map((x) => x.name);
  assert.ok(names.indexOf('claude-session') > names.indexOf('suggestions'));
  const f = FEATURES.find((x) => x.name === 'claude-session')!;
  assert.equal(f.tools, undefined);
  assert.equal(f.ui, undefined);
  assert.equal(f.jobs, undefined);
  assert.deepEqual(f.routes!.map((r) => `${r.method} ${r.path}`), ['POST /api/claude/session-end', 'GET /api/claude/sessions', 'POST /api/claude/settings']);
  assert.ok(REGISTRY.routes.some((r) => r.path === '/api/claude/session-end' && r.write === true));
});

test('remote-connector (#31): no tools/jobs, its script only on the 설정 page, and its revokes and approval code are guarded writes', async () => {
  assert.deepEqual(FEATURES.map((f) => f.name).slice(-4), ['remote-connector', 'access', 'write-devices', 'settings']);
  assert.ok(uiTags('#settings').includes('<script src="features/remote-connector.js" type="module"></script>'), 'a section of the 설정 modal');
  assert.ok(!uiTags('index.html').includes('remote-connector'));
  assert.ok(!uiTags('devices.html').includes('remote-connector'), 'moved to the 설정 tab');
  const routes = REGISTRY.routes.filter((r) => r.path.startsWith('/api/remote/'));
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), ['GET /api/remote/clients', 'POST /api/remote/clients/:device/revoke', 'POST /api/remote/tokens/:device/revoke', 'POST /api/remote/approval-code']);
  // The derived ids (c-/g- + 16 hex) fit the `:device` slug; a raw CIMD client_id or a dotted value does not.
  const route = createRouter(REGISTRY.routes);
  const call = (p: string) => route(request('POST', {}), new URL(`http://x${p}`), untouchable);
  assert.equal((await call('/api/remote/clients/c-0123456789abcdef/revoke'))?.status, 403);
  assert.equal((await call('/api/remote/tokens/g-0123456789abcdef/revoke'))?.status, 403);
  assert.equal(await call('/api/remote/tokens/a.b/revoke'), null);
});
