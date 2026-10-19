// 설정 체크리스트 (#32): each item's states from plain facts, that nothing secret can reach the output, and the
// read-only fact gathering against temp files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assess,
  claudeCodeFacts,
  collectFacts,
  loadMenubarSeen,
  macFacts,
  MAIN_CHECKOUT,
  menubarNoter,
  ownerDevicesFromStatus,
  MENUBAR_FRESH_MS,
  remoteFacts,
  setupFiles,
  usageFacts,
  type Facts,
} from '../src/core/onboarding.ts';
import type { PoolStatus } from '../src/core/pool.ts';
import type { SelfWatchStatus } from '../src/core/selfwatch.ts';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const DAY = 86_400_000;

const OWNER_DEVICES = [
  { name: 'dev-mac', os: 'macOS' },
  { name: 'iphone', os: 'iOS' },
  { name: 'nas', os: 'linux' },
  { name: 'pve1', os: 'linux' },
];

/** Everything set up */
const all = (): Facts => ({
  alertChannel: ['ntfy'],
  proxmox: { configured: true, error: null, looseMode: false, collector: { view: 'ok', lastError: null }, expiry: { status: 'never', expiresAt: null } },
  pvePorts: { view: 'ok', lastError: null },
  winPorts: { view: 'ok', lastError: null },
  macAgent: { present: true, connected: true, state: 'ok' },
  menubarSeenAt: NOW - 60_000,
  remote: { clients: 1, liveTokens: 2, publicUrl: true, unreadable: false },
  claudeCode: { registered: true },
  usage: { pinned: 1, labels: 0, alerts: 0, deviceAlerts: 0, names: 0 },
  writeDevices: { list: ['dev-mac', 'iphone'], error: null, path: '~/.config/portboard/access.json', ownerDevices: OWNER_DEVICES },
});

const item = (f: Facts, key: string) => assess(f, NOW).items.find((i) => i.key === key)!;

test('everything set up: n/n, every item ok with no action', () => {
  const c = assess(all(), NOW);
  assert.equal(c.ok, c.total);
  assert.equal(c.summary, `설정 ${c.total}/${c.total}`);
  assert.deepEqual(c.items.map((i) => i.key), ['alerts', 'proxmox', 'pve-ports', 'win-ports', 'mac-agent', 'menubar', 'remote', 'claude-code', 'write-devices', 'usage']);
  for (const i of c.items) {
    assert.equal(i.status, 'ok', i.key);
    assert.equal(i.action, null, i.key);
    assert.ok(i.detail.length > 0 && i.title.length > 0);
  }
});

test('nothing set up: everything missing or warn, each with a next step', () => {
  const f: Facts = {
    alertChannel: [],
    proxmox: { configured: false, error: null, looseMode: false, collector: null, expiry: null },
    pvePorts: { view: 'setup', lastError: 'no-key' },
    winPorts: { view: 'setup', lastError: 'no-user' },
    macAgent: { present: false, connected: false, state: null },
    menubarSeenAt: null,
    remote: { clients: 0, liveTokens: 0, publicUrl: false, unreadable: false },
    claudeCode: { registered: false },
    usage: { pinned: 0, labels: 0, alerts: 0, deviceAlerts: 0, names: 0 },
    writeDevices: { list: null, error: null, path: '~/.config/portboard/access.json', ownerDevices: null },
  };
  const c = assess(f, NOW);
  assert.equal(c.ok, 0);
  assert.equal(c.summary, `설정 0/${c.total}`);
  for (const i of c.items) {
    // No write-device allowlist isn't missing setup but a risk to weigh: warn
    assert.equal(i.status, i.key === 'write-devices' ? 'warn' : 'missing', i.key);
    assert.ok(i.action, `${i.key} has no next step`);
    if (i.action!.kind === 'link') assert.match(i.action!.href, /^https:\/\//);
  }
  assert.match(item(f, 'pve-ports').detail, /portboard_ro/);
  assert.match(item(f, 'win-ports').detail, /Windows 사용자/);
  assert.match((item(f, 'claude-code').action as any).text, new RegExp(`^claude plugin marketplace add ${MAIN_CHECKOUT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} && claude plugin install portboard@portboard$`));
});

test('proxmox: invalid file, loose mode, failing API, expiry soon/expired/ok', () => {
  const f = all();
  f.proxmox = { ...f.proxmox, configured: false, error: 'proxmox.json: secret is missing' };
  assert.equal(item(f, 'proxmox').status, 'warn');
  f.proxmox = { ...all().proxmox, looseMode: true };
  assert.deepEqual(item(f, 'proxmox').action, { kind: 'command', text: 'chmod 600 ~/.config/portboard/proxmox.json' });
  f.proxmox = { ...all().proxmox, collector: { view: 'down', lastError: 'HTTP 401' } };
  assert.match(item(f, 'proxmox').detail, /실패.*HTTP 401/);
  f.proxmox = { ...all().proxmox, expiry: { status: 'soon', expiresAt: new Date(NOW + 3 * DAY).toISOString() } };
  assert.deepEqual([item(f, 'proxmox').status, item(f, 'proxmox').detail], ['warn', '토큰이 곧 만료돼요 (3일 남음)']);
  f.proxmox = { ...all().proxmox, expiry: { status: 'expired', expiresAt: new Date(NOW - DAY).toISOString() } };
  assert.equal(item(f, 'proxmox').status, 'warn');
  f.proxmox = { ...all().proxmox, expiry: { status: 'ok', expiresAt: new Date(NOW + 40 * DAY).toISOString() } };
  assert.deepEqual([item(f, 'proxmox').status, item(f, 'proxmox').detail], ['ok', '연결됨 · 40일 남음']);
  f.proxmox = { ...all().proxmox, expiry: null };
  assert.deepEqual([item(f, 'proxmox').status, item(f, 'proxmox').detail], ['ok', '연결됨']);
});

test('ssh keys: off counts as decided, failing is warn, not yet checked is warn without an action', () => {
  const f = all();
  f.pvePorts = { view: 'off', lastError: null };
  assert.equal(item(f, 'pve-ports').status, 'ok');
  f.pvePorts = { view: 'failing', lastError: 'timeout' };
  assert.deepEqual([item(f, 'pve-ports').status, item(f, 'pve-ports').action?.kind], ['warn', 'link']);
  f.winPorts = null;
  assert.deepEqual([item(f, 'win-ports').status, item(f, 'win-ports').action], ['warn', null]);
  f.winPorts = { view: 'setup', lastError: 'not-installed' };
  assert.match(item(f, 'win-ports').detail, /등록되지 않았어요/);
});

test('mac agent, menu bar, remote connector, claude code: the in-between states', () => {
  const f = all();
  f.macAgent = null;
  assert.equal(item(f, 'mac-agent').status, 'warn');
  f.macAgent = { present: true, connected: false, state: 'agent-away' };
  assert.match(item(f, 'mac-agent').detail, /agent-away/);

  f.menubarSeenAt = NOW - MENUBAR_FRESH_MS - DAY;
  assert.deepEqual([item(f, 'menubar').status, item(f, 'menubar').action?.kind], ['warn', 'command']);
  // the step is the native Mac app now (mac-app/build.sh), not the legacy SwiftBar installer
  assert.match((item(f, 'menubar').action as any).text, /:\S+\/ ~\/portboard\/ && ~\/portboard\/mac-app\/build\.sh --install$/);
  f.menubarSeenAt = null;
  assert.deepEqual([item(f, 'menubar').status, item(f, 'menubar').action?.kind], ['missing', 'command']);

  f.remote = { clients: 1, liveTokens: 0, publicUrl: true, unreadable: false };
  assert.equal(item(f, 'remote').status, 'warn');
  f.remote = { clients: 0, liveTokens: 0, publicUrl: true, unreadable: false };
  // 승인 코드 is made on the 설정 tab now (POST /api/remote/approval-code), not over SSH
  assert.deepEqual([item(f, 'remote').status, (item(f, 'remote').action as any).href], ['missing', 'settings.html#remote']);
  f.remote = { clients: 1, liveTokens: 0, publicUrl: true, unreadable: false };
  assert.equal((item(f, 'remote').action as any).href, 'settings.html#remote');
  f.remote = { clients: 0, liveTokens: 0, publicUrl: true, unreadable: false };
  f.remote = { clients: 0, liveTokens: 0, publicUrl: false, unreadable: false };
  assert.equal(item(f, 'remote').action?.kind, 'link');
  f.remote = { clients: 0, liveTokens: 0, publicUrl: false, unreadable: true };
  assert.equal(item(f, 'remote').status, 'warn');

  f.claudeCode = null;
  assert.equal(item(f, 'claude-code').status, 'warn');
  f.usage = { pinned: 0, labels: 2, alerts: 1, deviceAlerts: 1, names: 3 };
  assert.deepEqual([item(f, 'usage').status, item(f, 'usage').detail], ['ok', '이름 2 · 알림 2 · LAN 이름 3']);
});

// ---- facts from files ----

/** tailscale status --json, trimmed: this server, the owner's laptop and NAS, tagged nodes, another user's node */
const STATUS = JSON.stringify({
  Self: { ID: 'nSelf', UserID: 42, DNSName: 'devbox.tail.ts.net.', OS: 'linux' },
  User: { '42': { LoginName: 'owner@example.com' }, '7': { LoginName: 'tagged-devices' }, '9': { LoginName: 'guest@example.com' } },
  Peer: {
    k1: { ID: 'nMac', UserID: 42, DNSName: 'dev-mac.tail.ts.net.', HostName: 'Mac', OS: 'macOS' },
    k2: { ID: 'nNas', UserID: 42, DNSName: 'nas.tail.ts.net.', OS: 'linux' },
    k3: { ID: 'nTag', UserID: 7, DNSName: 'funnel-ingress-node.', Tags: ['tag:ingress'] },
    k4: { ID: 'nTag2', UserID: 42, DNSName: 'tagged-box.tail.ts.net.', Tags: ['tag:server'] },
    k5: { ID: 'nGuest', UserID: 9, DNSName: 'guest-laptop.tail.ts.net.', OS: 'windows' },
  },
});

const SECRETS = ['secret-topic-123', 'hook.example/abc', 'PVESECRET', 'root@pam!portboard', 'AA:BB', 'refresh-hash', 'ENVTOKEN', '/opt/secret-arg'];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pb-onboarding-'));
  const files = {
    alertChannel: join(dir, 'alerts.json'),
    remote: join(dir, 'remote.json'),
    claude: join(dir, 'claude.json'),
    claudeSettings: join(dir, 'claude-settings.json'),
    prefs: join(dir, 'prefs.json'),
    clients: join(dir, 'clients.json'),
    proxmox: join(dir, 'proxmox.json'),
    menubar: join(dir, 'menubar-seen.json'),
    access: join(dir, 'access.json'),
  };
  await writeFile(files.alertChannel, JSON.stringify({ ntfy: { server: 'https://ntfy.example', topic: 'secret-topic-123' }, webhook: { url: 'https://hook.example/abc' } }));
  await writeFile(
    files.remote,
    JSON.stringify({
      publicUrl: 'https://x.example:8443',
      clients: { c1: { name: 'Claude', redirectUris: [], createdAt: 1, lastUsedAt: 1 } },
      tokens: {
        'refresh-hash': { kind: 'refresh', clientId: 'c1', clientName: 'Claude', resource: '', scope: '', createdAt: 1, expiresAt: NOW + DAY },
        old: { kind: 'access', clientId: 'c1', clientName: 'Claude', resource: '', scope: '', createdAt: 1, expiresAt: NOW - 1 },
        used: { kind: 'used', clientId: 'c1', clientName: 'Claude', resource: '', scope: '', createdAt: 1, expiresAt: NOW + DAY },
      },
    }),
  );
  await writeFile(files.claude, JSON.stringify({ mcpServers: { other: {} }, projects: { '/x': { mcpServers: { portboard: { command: 'node', args: ['/opt/secret-arg'], env: { TOKEN: 'ENVTOKEN' } } } } } }));
  await writeFile(files.prefs, JSON.stringify({ ports: { '3000': { pinned: true, label: 'web' }, '8080': { alert: true } }, deviceAlerts: { mac: true } }));
  await writeFile(files.clients, JSON.stringify({ names: { 'ip:192.168.1.9': 'tv' } }));
  await writeFile(files.proxmox, JSON.stringify({ url: 'https://192.168.1.201:8006', tokenId: 'root@pam!portboard', secret: 'PVESECRET', fingerprint: `AA:BB:${'CC:'.repeat(29)}DD` }), { mode: 0o600 });
  await writeFile(files.menubar, JSON.stringify({ lastSeen: NOW - 1000 }));
  await writeFile(files.access, JSON.stringify({ writeDevices: ['dev-mac'] }), { mode: 0o600 });
  return { dir, files };
}

const swView = (over: Partial<SelfWatchStatus> = {}): SelfWatchStatus => ({
  checkEverySec: 60,
  thresholdMin: 15,
  lastCheck: null,
  failing: 0,
  summary: '수집 정상',
  collectors: [
    { name: 'proxmox', label: 'Proxmox API', view: 'ok', enabled: true, ok: true, checkedAt: null, lastOk: null, lastError: null, failures: 0, failingSince: null, alerted: false },
    { name: 'pve-ports', label: 'pve1', view: 'setup', enabled: true, ok: false, checkedAt: null, lastOk: null, lastError: 'not-installed', failures: 3, failingSince: null, alerted: false },
  ],
  expiry: { checkedAt: null, items: [{ key: 'proxmox-token', name: 'Proxmox API token', expiresAt: new Date(NOW + 2 * DAY).toISOString(), status: 'soon', note: null }] },
  ...over,
});

const pool = (hosts: Partial<PoolStatus['hosts'][number]>[]): PoolStatus => ({
  available: true, source: 'hosts', url: '', healthAt: null,
  hosts: hosts.map((h) => ({ name: 'x', kind: 'ssh', addresses: [], state: 'ok', inRotation: true, slots: 1, busy: 0, ...h })),
});

test('collectFacts reads the files and the self-watch view, and the checklist carries no secret', async () => {
  const { files } = await fixture();
  const facts = await collectFacts({ files, now: NOW, env: {}, tailscaleStatus: async () => STATUS, selfwatch: async () => swView(), pool: async () => pool([{ name: 'mac', kind: 'agent', state: 'agent-busy', agent: { connected: true, available: false } }]) });
  assert.deepEqual(facts, {
    alertChannel: ['ntfy', 'webhook'],
    proxmox: { configured: true, error: null, looseMode: false, collector: { view: 'ok', lastError: null }, expiry: { status: 'soon', expiresAt: new Date(NOW + 2 * DAY).toISOString() } },
    pvePorts: { view: 'setup', lastError: 'not-installed' },
    winPorts: null,
    macAgent: { present: true, connected: true, state: 'agent-busy' },
    menubarSeenAt: NOW - 1000,
    remote: { clients: 1, liveTokens: 1, publicUrl: true, unreadable: false, attention: 1 },
    claudeCode: { registered: true, plugin: false },
    usage: { pinned: 1, labels: 1, alerts: 1, deviceAlerts: 1, names: 1 },
    writeDevices: { list: ['dev-mac'], error: null, path: files.access, ownerDevices: [{ name: 'dev-mac', os: 'macOS' }, { name: 'nas', os: 'linux' }] },
  });
  const out = JSON.stringify({ facts, list: assess(facts, NOW) });
  for (const s of SECRETS) assert.ok(!out.includes(s), `${s} leaked`);
});

test('collectFacts with nothing there: no files, no self-watch, no pool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-onboarding-empty-'));
  const files = Object.fromEntries(['alertChannel', 'remote', 'claude', 'claudeSettings', 'prefs', 'clients', 'proxmox', 'menubar', 'access'].map((k) => [k, join(dir, `${k}.json`)]));
  const facts = await collectFacts({ files, now: NOW, env: {}, tailscaleStatus: async () => null, selfwatch: async () => null, pool: async () => ({ available: false, source: null, url: '', healthAt: null, hosts: [] }) });
  assert.deepEqual(facts, {
    alertChannel: [],
    proxmox: { configured: false, error: null, looseMode: false, collector: null, expiry: null },
    pvePorts: null,
    winPorts: null,
    macAgent: null,
    menubarSeenAt: null,
    remote: { clients: 0, liveTokens: 0, publicUrl: false, unreadable: false },
    claudeCode: null,
    usage: { pinned: 0, labels: 0, alerts: 0, deviceAlerts: 0, names: 0 },
    writeDevices: { list: null, error: null, path: files.access, ownerDevices: null },
  });
});

test('fact helpers: broken JSON, mac by name, user-scope registration', () => {
  assert.equal(remoteFacts({ value: undefined }, NOW).unreadable, true);
  assert.equal(claudeCodeFacts({ value: undefined }), null);
  assert.deepEqual(claudeCodeFacts({ value: { mcpServers: { portboard: {} } } }), { registered: true, plugin: false });
  assert.deepEqual(claudeCodeFacts({ value: { mcpServers: {}, projects: { a: { mcpServers: { porty: {} } } } } }), { registered: false, plugin: false });
  // the plugin (claude-plugin/) replaces the user-scope registration
  assert.deepEqual(claudeCodeFacts({ value: {} }, { value: { enabledPlugins: { 'portboard@portboard': true } } }), { registered: false, plugin: true });
  assert.deepEqual(claudeCodeFacts(null, { value: { enabledPlugins: { 'portboard@portboard': true } } }), { registered: false, plugin: true });
  assert.deepEqual(claudeCodeFacts({ value: {} }, { value: { enabledPlugins: { 'portboard@portboard': false } } }), { registered: false, plugin: false });
  assert.deepEqual(macFacts(pool([{ name: 'desktop' }])), { present: false, connected: false, state: null });
  assert.deepEqual(macFacts(pool([{ name: 'mac', kind: 'agent', state: 'agent-away', agent: { connected: false, available: false } }])), { present: true, connected: false, state: 'agent-away' });
  assert.deepEqual(usageFacts({ ports: { '1': { hidden: true } } }, {}), { pinned: 0, labels: 0, alerts: 0, deviceAlerts: 0, names: 0 });
});

test('setup files are production paths in a preview too (a preview channel never exists)', () => {
  const f = setupFiles({ PORTBOARD_PORT: '8808' }, '/home/x');
  assert.deepEqual(f, { alertChannel: '/home/x/.local/state/compute-pool/alerts.json', remote: '/home/x/.config/portboard/remote.json', claude: '/home/x/.claude.json', claudeSettings: '/home/x/.claude/settings.json' });
  assert.equal(setupFiles({ PORTBOARD_ALERT_CHANNEL: '/t/a.json' }, '/home/x').alertChannel, '/t/a.json');
});

test('menu bar noter: only its User-Agent, at most every 10 minutes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-menubar-'));
  const path = join(dir, 'sub', 'menubar-seen.json');
  let t = NOW;
  const note = menubarNoter(path, () => t);
  assert.equal(note({ headers: { 'user-agent': 'node' } }), null);
  await note({ headers: { 'user-agent': 'portboard-menubar/1' } });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { lastSeen: NOW });
  t += 60_000;
  assert.equal(note({ headers: { 'user-agent': 'portboard-menubar/1' } }), null);
  t += 10 * 60_000;
  await note({ headers: { 'user-agent': 'portboard-menubar/1' } });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { lastSeen: t });
});

test('menu bar noter: the Mac app (portboard-mac/<version>) counts like the SwiftBar plugin; its web view does not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-macapp-'));
  const path = join(dir, 'menubar-seen.json');
  const note = menubarNoter(path, () => NOW);
  // WKWebView appends the app name to Safari's User-Agent: that is the dashboard page, not the poller
  assert.equal(note({ headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) portboard-mac/1.0.0' } }), null);
  assert.equal(note({ headers: { 'user-agent': 'portboard-macintosh' } }), null);
  await note({ headers: { 'user-agent': 'portboard-mac/1.0.0' } });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { lastSeen: NOW });
  assert.equal(await loadMenubarSeen(path), NOW);
  assert.equal(assess({ ...all(), menubarSeenAt: await loadMenubarSeen(path) }, NOW).items.find((i) => i.key === 'menubar')?.status, 'ok');
});

test('runbooks (#31): items holding a secret link to its rotation runbook; the connector also to 토큰 관리', () => {
  const c = assess(all(), NOW);
  const links = Object.fromEntries(c.items.map((i) => [i.key, (i.links ?? []).map((l) => l.href)]));
  const rb = 'https://github.com/c10dev/portboard/blob/main/docs/runbooks/';
  assert.deepEqual(links.alerts, [`${rb}ntfy-topic.md`]);
  assert.deepEqual(links.proxmox, [`${rb}proxmox-token.md`]);
  assert.deepEqual(links['pve-ports'], [`${rb}ssh-readonly-keys.md`]);
  assert.deepEqual(links['win-ports'], [`${rb}ssh-readonly-keys.md`]);
  assert.deepEqual(links.remote, ['settings.html#remote', `${rb}remote-connector.md`]);
  assert.equal(links['write-devices'][0], 'settings.html#write-devices');
  assert.deepEqual(links.usage, []);
  for (const href of Object.values(links).flat()) {
    if (href.startsWith(rb)) assert.ok(existsSync(new URL(`../docs/runbooks/${href.slice(rb.length)}`, import.meta.url)), href);
  }
});

// ---- 쓰기 허용 기기 (security review v1.0, M1) ----

test('write devices: unset is a warn naming every owner-login device, with a command allowing the personal ones', () => {
  const f = { ...all(), writeDevices: { list: null, error: null, path: '~/.config/portboard/access.json', ownerDevices: OWNER_DEVICES } };
  const i = item(f, 'write-devices');
  assert.equal(i.status, 'warn');
  assert.match(i.detail, /^쓰기 가능한 기기 제한 안 됨/);
  for (const d of OWNER_DEVICES) assert.ok(i.detail.includes(d.name), d.name);
  assert.match(i.detail, /4대/);
  assert.equal(i.action?.kind, 'command');
  assert.equal((i.action as any).text, `umask 077; printf '%s\\n' '{"writeDevices":["dev-mac","iphone"]}' > ~/.config/portboard/access.json`);
  // without tailscale status: still a warn, with placeholders to fill in
  const blind = item({ ...f, writeDevices: { ...f.writeDevices, ownerDevices: null } }, 'write-devices');
  assert.equal(blind.status, 'warn');
  assert.match(blind.detail, /서버 포함/);
  assert.match((blind.action as any).text, /<노트북 이름>/);
});

test('write devices: set is ok and says how many owner devices stay read-only; a broken file is a warn', () => {
  const ok = item(all(), 'write-devices');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.action, null);
  assert.match(ok.detail, /dev-mac, iphone만/);
  assert.match(ok.detail, /다른 소유자 기기 2대는 읽기 전용/);
  const loose = item({ ...all(), writeDevices: { list: null, error: '권한이 600이 아니에요 (chmod 600)', path: '~/.config/portboard/access.json', ownerDevices: [] } }, 'write-devices');
  assert.equal(loose.status, 'warn');
  assert.equal((loose.action as any).text, 'chmod 600 ~/.config/portboard/access.json');
});

test('ownerDevicesFromStatus: untagged peers of the owner user, not this server, not tagged, not other users', () => {
  assert.deepEqual(ownerDevicesFromStatus(STATUS), [{ name: 'dev-mac', os: 'macOS' }, { name: 'nas', os: 'linux' }]);
  assert.deepEqual(ownerDevicesFromStatus(STATUS, 'GUEST@example.com'), [{ name: 'guest-laptop', os: 'windows' }], 'PORTBOARD_OWNER_LOGIN wins');
  assert.equal(ownerDevicesFromStatus(null), null);
  assert.equal(ownerDevicesFromStatus('{torn'), null);
});
