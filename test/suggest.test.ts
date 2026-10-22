import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alertSuggestions,
  cleanHostname,
  IDLE_DAYS,
  idleSuggestions,
  longLived,
  nameId,
  nameSuggestions,
  parseDefaultRoutes,
  parseDockerInspect,
  prefillName,
  rememberPeers,
  report,
  SUGGESTION_ID,
  vendorKind,
  type AlertCandidate,
  type AlertInputs,
  type IdleCandidate,
  type IdleInputs,
  type NameCard,
  type NameInputs,
  type UseRecord,
} from '../src/core/suggest.ts';
import { withLocale } from '../src/core/i18n.ts';
import { dismissSuggestion, loadPrefs, setPortPrefs } from '../src/core/prefs.ts';

const NOW = Date.parse('2026-10-18T09:00:00Z');

function port(p: Partial<AlertCandidate> & { port: number }, unit: string | null = null): AlertCandidate {
  return {
    name: `svc ${p.port}`, kind: 'app', listening: true, hidden: false, pinned: false, alert: false, container: null,
    processes: unit ? [{ unit }] : [{ unit: null }], probe: null, ...p,
  };
}

const INPUTS: AlertInputs = {
  transient: new Set(['pb-sd-dummy-a.service', 'pb-dev-portboard-1a2b.service']),
  selfUnits: new Set(['portboard.service']),
  containers: new Map([
    ['supabase_kong_webapp', { startedAt: NOW - 11 * 86400_000, restart: 'unless-stopped' }],
    ['scratch_redis', { startedAt: NOW - 3600_000, restart: null }],
    ['old_redis', { startedAt: NOW - 2 * 86400_000, restart: 'no' }],
  ]),
  now: NOW,
};

// ---------- alerts ----------

test('alerts: installed units and long-lived containers without an alert are suggested, one per unit', () => {
  const out = alertSuggestions([
    port({ port: 3080 }, 'agent-web.service'),
    port({ port: 7720, probe: { http: true } }, 'compute-pool-monitor.service'),
    port({ port: 7721 }, 'compute-pool-monitor.service'),
    port({ port: 54321, container: 'supabase_kong_webapp', processes: [] }),
    port({ port: 6380, container: 'old_redis', processes: [] }),
  ], INPUTS);
  assert.deepEqual(out.map((s) => [s.id, s.reasons, s.also]), [
    ['alert-3080', ['systemd'], []],
    ['alert-6380', ['docker'], []],
    ['alert-7720', ['systemd'], [7721]],
    ['alert-54321', ['docker'], []],
  ]);
  assert.match(out[0].text, /systemd 서비스 agent-web\.service/);
});

test('alerts: the HTTP port speaks for its unit, a pinned one before that', () => {
  const a = alertSuggestions([port({ port: 22000 }, 'syncthing.service'), port({ port: 8384, probe: { http: true } }, 'syncthing.service')], INPUTS);
  assert.deepEqual(a.map((s) => [s.port, s.also]), [[8384, [22000]]]);
  const b = alertSuggestions([port({ port: 22000, pinned: true }, 'syncthing.service'), port({ port: 8384, probe: { http: true } }, 'syncthing.service')], INPUTS);
  assert.deepEqual(b.map((s) => [s.port, s.reasons]), [[22000, ['pinned', 'systemd']]]);
});

test('alerts: left out — already watched (any port of the unit), Portboard, systemd-run, short-lived, bare, hidden, stopped, system', () => {
  const out = alertSuggestions([
    port({ port: 7720, alert: true }, 'compute-pool-monitor.service'),
    port({ port: 7721 }, 'compute-pool-monitor.service'),
    port({ port: 8790 }, 'portboard.service'),
    port({ port: 18891 }, 'pb-sd-dummy-a.service'),
    port({ port: 8811 }, 'pb-dev-portboard-1a2b.service'),
    port({ port: 6379, container: 'scratch_redis', processes: [] }),
    port({ port: 6390, container: 'unknown_ctr', processes: [] }),
    port({ port: 3000 }),
    port({ port: 9000, hidden: true }, 'thing.service'),
    port({ port: 9001, listening: false }, 'thing2.service'),
    port({ port: 22, kind: 'system', processes: [] }),
  ], INPUTS);
  assert.deepEqual(out, []);
});

test('alerts: a pinned port is suggested whatever runs it, a pinned systemd-run one too', () => {
  const out = alertSuggestions([port({ port: 3000, pinned: true }), port({ port: 18891, pinned: true }, 'pb-sd-dummy-a.service')], INPUTS);
  assert.deepEqual(out.map((s) => [s.id, s.reasons]), [['alert-3000', ['pinned']], ['alert-18891', ['pinned']]]);
  assert.match(out[0].text, /^고정한 포트예요/);
});

test('longLived: restart policy or a day up', () => {
  assert.equal(longLived({ startedAt: NOW, restart: 'always' }, NOW), true);
  assert.equal(longLived({ startedAt: NOW - 86400_000, restart: 'no' }, NOW), true);
  assert.equal(longLived({ startedAt: NOW - 3600_000, restart: 'no' }, NOW), false);
  assert.equal(longLived({ startedAt: null, restart: null }, NOW), false);
  assert.equal(longLived(undefined, NOW), false);
});

// ---------- names ----------

function card(c: Partial<NameCard> & { id: string; kind: string }): NameCard {
  return {
    name: c.id, nameSource: 'ip', os: null, vendor: null, mac: null, randomMac: false, addresses: [], lanIps: [],
    nameKey: null, path: null, guestOf: null, ...c,
  };
}

/** The production 기기 tab on 2026-10-18, trimmed */
const CARDS: NameCard[] = [
  card({ id: 'lan:192.168.1.108', kind: 'lan', name: '개인 Wi-Fi 주소 기기', mac: '16:22:4f:0a:0b:06', randomMac: true, addresses: ['192.168.1.108'], lanIps: ['192.168.1.108'], nameKey: 'ip:192.168.1.108' }),
  card({ id: 'desktop-pc', kind: 'tailnet', nameSource: 'tailscale', os: 'windows', lanIps: ['192.168.1.7'], path: { type: 'direct', endpoint: '192.168.1.1:31668' } }),
  card({ id: 'dev-mac', kind: 'tailnet', nameSource: 'tailscale', os: 'macOS', path: { type: 'direct', endpoint: '192.168.1.108:41641' } }),
  card({ id: 'iphone', kind: 'tailnet', nameSource: 'tailscale', os: 'iOS', path: { type: 'direct', endpoint: '192.168.1.105:41641' } }),
  card({ id: 'lan:192.168.1.204', kind: 'lan', name: 'jellyfin', nameSource: 'proxmox', vendor: 'Proxmox Server Solutions GmbH', mac: 'bc:24:11:0a:0b:05', lanIps: ['192.168.1.204'], nameKey: 'mac:bc:24:11:0a:0b:05', guestOf: { type: 'lxc', vmid: 204 } }),
  card({ id: 'devbox', kind: 'self', nameSource: 'tailscale' }),
];
const NAME_INPUTS: NameInputs = { notPeers: new Set(['192.168.1.205', '192.168.1.1']), hostnames: new Map() };

test('names: a LAN address that is a tailnet peer\'s direct endpoint gets the peer\'s name', () => {
  const out = nameSuggestions(CARDS, [], NAME_INPUTS);
  assert.deepEqual(out.map((s) => [s.id, s.key, s.device, s.name, s.source, s.confidence, s.os]), [
    ['name-ip-192-168-1-108', 'ip:192.168.1.108', 'lan:192.168.1.108', 'dev-mac', 'tailscale', 'high', 'macOS'],
  ]);
  assert.equal(out[0].current, '개인 Wi-Fi 주소 기기');
  assert.match(out[0].text, /dev-mac \(macOS\)/);
});

test('names: the gateway (a NATed endpoint), this server, a shared endpoint and a peer\'s own LAN IP name nothing', () => {
  const router = card({ id: 'lan:192.168.1.1', kind: 'lan', name: 'ipTIME 기기', vendor: 'EFM Networks', addresses: ['192.168.1.1'], nameKey: 'mac:b0:38:6c:0a:0b:07' });
  const out = nameSuggestions([...CARDS, router], [], NAME_INPUTS);
  assert.equal(out.find((s) => s.key === router.nameKey)?.source, 'vendor', 'the router gets no tailnet name');
  assert.equal(out.find((s) => s.key === router.nameKey)?.name, 'ipTIME 네트워크 장비');

  const twin = card({ id: 'ipad', kind: 'tailnet', nameSource: 'tailscale', path: { type: 'direct', endpoint: '192.168.1.108:41641' } });
  assert.deepEqual(nameSuggestions([...CARDS, twin], [], NAME_INPUTS), [], 'two peers behind one address: no guess');

  const own = card({ id: 'pc', kind: 'tailnet', nameSource: 'tailscale', lanIps: ['192.168.1.50'], path: { type: 'direct', endpoint: '192.168.1.50:41641' } });
  const lan50 = card({ id: 'lan:192.168.1.50', kind: 'lan', addresses: ['192.168.1.50'], nameKey: 'ip:192.168.1.50' });
  assert.deepEqual(nameSuggestions([own, lan50], [], NAME_INPUTS), [], 'that address is already merged into the peer\'s card');
});

test('names: user-named and Proxmox-named devices are left alone; hostname beats vendor; same name is no suggestion', () => {
  const named = card({ id: 'lan:192.168.1.30', kind: 'lan', name: '거실 NAS', nameSource: 'user', vendor: 'Synology Incorporated', addresses: ['192.168.1.30'], nameKey: 'mac:00:11:32:00:00:01' });
  const nas = card({ id: 'lan:192.168.1.31', kind: 'lan', name: 'Synology 기기', nameSource: 'vendor', vendor: 'Synology Incorporated', addresses: ['192.168.1.31'], nameKey: 'mac:00:11:32:00:00:02' });
  const printer = card({ id: 'lan:192.168.1.40', kind: 'lan', name: 'Brother 기기', nameSource: 'vendor', vendor: 'Brother industries, LTD.', addresses: ['192.168.1.40'], nameKey: 'mac:00:80:77:00:00:01' });
  const hp = card({ id: 'lan:192.168.1.41', kind: 'lan', name: 'HP 기기', nameSource: 'vendor', vendor: 'HP Inc.', addresses: ['192.168.1.41'], nameKey: 'mac:50:81:40:00:00:01' });
  const out = nameSuggestions([...CARDS, named, nas, printer, hp], [], { ...NAME_INPUTS, hostnames: new Map([['192.168.1.31', 'diskstation.lan.']]) });
  assert.deepEqual(out.map((s) => [s.device, s.name, s.source]), [
    ['lan:192.168.1.108', 'dev-mac', 'tailscale'],
    ['lan:192.168.1.31', 'diskstation', 'hostname'],
    ['lan:192.168.1.40', 'Brother 프린터', 'vendor'],
  ]);
});

test('names: a 새 기기 seen only in the neighbour table is a target too, once', () => {
  const pending = [
    { key: 'mac:00:11:32:00:00:09', kind: 'lan', name: 'Synology 기기', vendor: 'Synology Incorporated', ip: '192.168.1.60', cardId: null, nameKey: 'mac:00:11:32:00:00:09' },
    { key: 'ip:192.168.1.108', kind: 'lan', name: '개인 Wi-Fi 주소 기기', vendor: null, ip: '192.168.1.108', cardId: 'lan:192.168.1.108', nameKey: 'ip:192.168.1.108' },
    { key: 'ts:ipad', kind: 'tailnet', name: 'ipad', vendor: null, ip: null, cardId: 'ipad', nameKey: null },
  ];
  const out = nameSuggestions(CARDS, pending, NAME_INPUTS);
  assert.deepEqual(out.map((s) => [s.key, s.name]), [['ip:192.168.1.108', 'dev-mac'], ['mac:00:11:32:00:00:09', 'Synology NAS']]);
});

test('names: a peer seen at a LAN address is remembered while the same MAC is there, for 7 days', () => {
  const seen = rememberPeers(new Map(), CARDS, NAME_INPUTS.notPeers, NOW);
  assert.deepEqual([...seen], [['192.168.1.108', { peer: 'dev-mac', os: 'macOS', mac: '16:22:4f:0a:0b:06', at: NOW }]], 'iphone has no LAN card, the router is no peer');
  // Later the Mac's endpoint is the router (hairpin NAT): nothing matches now, the memory does.
  const later = CARDS.map((c) => (c.id === 'dev-mac' ? { ...c, path: { type: 'direct' as const, endpoint: '192.168.1.1:41641' } } : c));
  assert.deepEqual(nameSuggestions(later, [], NAME_INPUTS), []);
  const kept = rememberPeers(seen, later, NAME_INPUTS.notPeers, NOW + 3600_000);
  assert.deepEqual(nameSuggestions(later, [], { ...NAME_INPUTS, seen: kept }).map((s) => [s.device, s.name]), [['lan:192.168.1.108', 'dev-mac']]);
  // Another device got that address (another MAC): no name
  const other = later.map((c) => (c.id === 'lan:192.168.1.108' ? { ...c, mac: '3a:00:00:00:00:01' } : c));
  assert.deepEqual(nameSuggestions(other, [], { ...NAME_INPUTS, seen: kept }), []);
  // Expired
  assert.equal(rememberPeers(kept, later, NAME_INPUTS.notPeers, NOW + 8 * 86400_000).size, 0);
});

test('cleanHostname / vendorKind / nameId', () => {
  assert.equal(cleanHostname('diskstation.lan.'), 'diskstation');
  assert.equal(cleanHostname('Galaxy-S24.local'), 'Galaxy-S24');
  for (const junk of ['localhost', '192.168.1.5', 'android-1a2b3c4d5e6f7a8b.lan', 'ip-192-168-1-5', '']) assert.equal(cleanHostname(junk), null, junk);
  assert.equal(vendorKind('Seiko Epson Corporation'), 'Epson 프린터');
  assert.equal(vendorKind('Raspberry Pi Trading Ltd'), 'Raspberry Pi');
  assert.equal(vendorKind('Apple, Inc.'), null);
  assert.equal(nameId('mac:bc:24:11:0a:0b:05'), 'name-mac-bc-24-11-0a-0b-05');
  assert.equal(nameId('ip:fe80::1'), 'name-ip-fe80-1');
  for (const id of ['alert-8080', nameId('mac:bc:24:11:0a:0b:05'), nameId('ip:192.168.1.108'), nameId('ip:2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff')]) {
    assert.match(id, SUGGESTION_ID);
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/, 'fits the router\'s :device segment');
  }
  assert.doesNotMatch('alert-x', SUGGESTION_ID);
  assert.doesNotMatch('name-../prefs', SUGGESTION_ID);
});

test('prefillName: the suggestion, else the Proxmox guest name, else empty; a user name stays', () => {
  const [mac] = nameSuggestions(CARDS, [], NAME_INPUTS);
  assert.equal(prefillName(CARDS[0], mac), 'dev-mac');
  assert.equal(prefillName(CARDS[4], undefined), 'jellyfin');
  assert.equal(prefillName({ name: 'HP 기기', nameSource: 'vendor' }, undefined), '');
  assert.equal(prefillName({ name: '내 노트북', nameSource: 'user' }, mac), '내 노트북');
});

// ---------- idle ----------

const DAY = 86400_000;

function svc(p: Partial<IdleCandidate> & { port: number }, unit: string | null = null, pid = p.port): IdleCandidate {
  return {
    name: `svc ${p.port}`, kind: 'app', listening: true, hidden: false, pinned: false, container: null,
    processes: [{ pid, unit, cmdline: `/usr/bin/node server-${p.port}.js` }], ...p,
  };
}

const use = (port: number, daysAgo: number, name = 'dev-mac'): UseRecord => ({ port, name, lastSeen: NOW - daysAgo * DAY });

function idleInputs(o: Partial<IdleInputs> = {}): IdleInputs {
  return {
    historySince: NOW - 30 * DAY,
    uses: [],
    started: new Map(),
    containers: new Map(),
    selfUnits: new Set(['portboard.service']),
    selfPid: 999_999,
    now: NOW,
    ...o,
  };
}

test('idle: units, containers and processes nobody used for 14 days, with last use and owner; one per unit', () => {
  const out = idleSuggestions([
    svc({ port: 3080 }, 'agent-web.service'),
    svc({ port: 7720 }, 'compute-pool-monitor.service', 7720),
    svc({ port: 7721 }, 'compute-pool-monitor.service', 7720),
    svc({ port: 54321, container: 'supabase_kong_webapp', processes: [] }),
    svc({ port: 8000 }),
    svc({ port: 5173 }, 'pb-dev-portboard-1a2b.service'),
  ], idleInputs({
    uses: [use(3080, 20), use(3080, 21, 'ipad'), use(7721, 16, 'local'), use(54321, 2), use(5173, 15)],
    started: new Map([[7720, NOW - 60 * DAY], [8000, NOW - 40 * DAY]]),
  }));
  assert.deepEqual(out.map((s) => [s.id, s.owner, s.also, s.idleDays, s.lastDevice]), [
    ['idle-3080', { type: 'unit', name: 'agent-web.service' }, [], 20, 'dev-mac'],
    ['idle-5173', { type: 'unit', name: 'pb-dev-portboard-1a2b.service' }, [], 15, 'dev-mac'],
    ['idle-7720', { type: 'unit', name: 'compute-pool-monitor.service' }, [7721], 16, 'local'],
    ['idle-8000', { type: 'process', name: 'node' }, [], null, null],
  ]);
  const [web] = out;
  assert.equal(web.kind, 'idle');
  assert.equal(web.days, IDLE_DAYS);
  assert.equal(web.lastUsed, new Date(NOW - 20 * DAY).toISOString());
  assert.match(web.text, /agent-web\.service/);
  assert.match(web.text, /20/);
  assert.match(out[3].text, /14/, 'never seen: says how long the history covers');
  assert.ok(out.every((s) => SUGGESTION_ID.test(s.id)));
});

test('idle: nothing while the history is younger than the threshold, even for old services', () => {
  const ports = [svc({ port: 3080 }, 'agent-web.service'), svc({ port: 8000 })];
  const started = new Map([[3080, NOW - 90 * DAY], [8000, NOW - 90 * DAY]]);
  assert.deepEqual(idleSuggestions(ports, idleInputs({ historySince: NOW - 3 * DAY, started })), []);
  assert.deepEqual(idleSuggestions(ports, idleInputs({ historySince: null, started })), []);
  assert.equal(idleSuggestions(ports, idleInputs({ historySince: NOW - 14 * DAY, started })).length, 2, 'exactly the threshold is enough');
});

test('idle: a port the history never saw needs a service older than the threshold, else it is just new', () => {
  const ports = [
    svc({ port: 8000 }),
    svc({ port: 8001 }),
    svc({ port: 6380, container: 'old_redis', processes: [] }),
    svc({ port: 6381, container: 'scratch_redis', processes: [] }),
  ];
  const out = idleSuggestions(ports, idleInputs({
    started: new Map([[8000, NOW - 3 * DAY]]), // 8001: start time unknown
    containers: new Map([['old_redis', { startedAt: NOW - 20 * DAY, restart: 'no' }], ['scratch_redis', { startedAt: NOW - 3600_000, restart: null }]]),
  }));
  assert.deepEqual(out.map((s) => [s.id, s.owner]), [['idle-6380', { type: 'container', name: 'old_redis' }]]);
});

test('idle: pinned, hidden, system, stopped and Portboard\'s own ports are left out; a used port keeps its whole unit', () => {
  const old = new Map([[1, NOW - 60 * DAY]]);
  const out = idleSuggestions([
    svc({ port: 4000, pinned: true }, null, 1),
    svc({ port: 4001, hidden: true }, null, 1),
    svc({ port: 22, kind: 'system', processes: [] }),
    svc({ port: 4002, listening: false }, null, 1),
    svc({ port: 7777 }, 'portboard.service', 1),
    svc({ port: 7778 }, 'portboard-remote.service', 1),
    svc({ port: 7779 }, 'pb-preview-x.service', 1),
    svc({ port: 7780 }, null, 4242),
    svc({ port: 7781, isPortboard: true }, null, 1),
    svc({ port: 9000 }, 'two-ports.service', 1),
    svc({ port: 9001, pinned: true }, 'two-ports.service', 1),
    svc({ port: 9100 }, 'busy.service', 1),
    svc({ port: 9101 }, 'busy.service', 1),
  ], idleInputs({
    started: new Map([...old, [4242, NOW - 60 * DAY]]),
    uses: [use(9101, 1)],
    selfUnits: new Set(['portboard.service', 'pb-preview-x.service']),
    selfPid: 4242,
  }));
  assert.deepEqual(out, []);
});

test('idle: a dismissed one is counted, not shown', () => {
  const idle = idleSuggestions([svc({ port: 3080 }, 'agent-web.service'), svc({ port: 3081 }, 'other.service')], idleInputs({ uses: [use(3080, 20), use(3081, 20)] }));
  const r = report(idle, new Set(['idle-3080']), NOW);
  assert.deepEqual(r.suggestions.map((s) => s.id), ['idle-3081']);
  assert.equal(r.dismissed, 1);
});

test('idle: English text names the owner, the days and the last device', () => {
  const [s] = withLocale('en', () => idleSuggestions([svc({ port: 54321, container: 'supabase_kong_webapp', processes: [] })], idleInputs({ uses: [use(54321, 18, 'dev-mac')] })));
  assert.equal(s.text, 'Container supabase_kong_webapp: nobody has connected for 18 days (last: dev-mac).');
});

// ---------- together ----------

test('report: dismissed suggestions are counted, not shown', () => {
  const alerts = alertSuggestions([port({ port: 3080 }, 'agent-web.service'), port({ port: 8080 }, 'supabase-mcp-tunnel.service')], INPUTS);
  const r = report([...alerts, ...nameSuggestions(CARDS, [], NAME_INPUTS)], new Set(['alert-8080']), NOW);
  assert.deepEqual(r.suggestions.map((s) => s.id), ['alert-3080', 'name-ip-192-168-1-108']);
  assert.equal(r.dismissed, 1);
  assert.equal(r.at, '2026-10-18T09:00:00.000Z');
});

test('parsers: docker inspect and the default route', () => {
  const info = parseDockerInspect('/supabase_db_webapp\t2026-10-07T03:23:54.942102983Z\tunless-stopped\n/x\t0001-01-01T00:00:00Z\t\n');
  assert.deepEqual(info.get('supabase_db_webapp'), { startedAt: Date.parse('2026-10-07T03:23:54.942Z'), restart: 'unless-stopped' });
  assert.deepEqual(info.get('x'), { startedAt: null, restart: null });
  assert.deepEqual(parseDefaultRoutes('default via 192.168.1.1 dev ens18 proto static\n10.0.0.0/8 via 10.1.1.1 dev x\n'), ['192.168.1.1']);
});

test('prefs: a dismissal survives other prefs writes', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-suggest-')), 'prefs.json');
  await dismissSuggestion('alert-3080', NOW, path);
  await setPortPrefs(3080, { pinned: true }, path);
  await dismissSuggestion('name-ip-192-168-1-108', NOW, path);
  const prefs = await loadPrefs(path);
  assert.deepEqual(Object.keys(prefs.suggestions?.dismissed ?? {}), ['alert-3080', 'name-ip-192-168-1-108']);
  assert.equal(prefs.ports['3080'].pinned, true);
  assert.match(await readFile(path, 'utf8'), /"alert-3080": "2026-10-18T09:00:00.000Z"/);
});

// ---------- wiring ----------

test('POST /api/suggestions/:id/dismiss refuses what isn\'t a suggestion id, before touching prefs', async () => {
  const { createRouter } = await import('../src/features/router.ts');
  const { REGISTRY } = await import('../src/features/registry.ts');
  const route = createRouter(REGISTRY.routes);
  const ctx = new Proxy({}, { get: (_t, k) => assert.fail(`touched ctx.${String(k)}`) }) as any;
  const at = (path: string) => route({ method: 'POST', headers: { 'x-portboard': '1' } } as any, new URL(`http://x${path}`), ctx);
  assert.deepEqual(await at('/api/suggestions/bogus-1/dismiss'), { status: 400, body: { error: 'id must be a suggestion id (alert-<port>, idle-<port> or name-<key>)' } });
  assert.equal(await at('/api/suggestions/name-../dismiss'), null, 'not even routed');
});

test('list_suggestions and list_new_devices: the suggestion reaches MCP, list_new_devices only adds a field', async () => {
  const { callTool } = await import('../src/mcp/tools.ts');
  const sug = report(nameSuggestions(CARDS, [], NAME_INPUTS), new Set(), NOW);
  const pending = [
    { key: 'ip:192.168.1.108', kind: 'lan', name: '개인 Wi-Fi 주소 기기', vendor: null, ip: '192.168.1.108', cardId: 'lan:192.168.1.108', nameKey: 'ip:192.168.1.108', scope: 'connection', since: '2026-10-18T08:00:00.000Z', service: null, notified: null },
    { key: 'ts:ipad', kind: 'tailnet', name: 'ipad', vendor: null, ip: null, cardId: 'ipad', nameKey: null, scope: 'connection', since: '2026-10-18T07:00:00.000Z', service: null, notified: null },
  ];
  const core = {
    suggestions: async () => sug,
    newDevices: async () => ({ settings: { connections: true, neighbors: false }, alertsOn: true, seededAt: null, known: 2, pending }),
  } as any;
  const listed = JSON.parse((await callTool('list_suggestions', {}, core)).content[0].text);
  assert.deepEqual(listed.suggestions.map((s: any) => s.id), ['name-ip-192-168-1-108']);
  const nd = JSON.parse((await callTool('list_new_devices', {}, core)).content[0].text);
  assert.deepEqual(nd.pending[0].suggestedName, { name: 'dev-mac', source: 'tailscale', text: sug.suggestions[0].text });
  assert.equal('suggestedName' in nd.pending[1], false);
  assert.deepEqual({ ...nd.pending[0], suggestedName: undefined }, { ...pending[0], suggestedName: undefined });
  const noSuggest = JSON.parse((await callTool('list_new_devices', {}, { newDevices: core.newDevices } as any)).content[0].text);
  assert.deepEqual(noSuggest.pending, pending);
});
