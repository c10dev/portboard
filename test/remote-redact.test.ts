import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorktreeInfo, WorktreesDoc } from '../src/core/worktrees.ts';
import { DEFAULT_THRESHOLDS, emptyPressure, type MemorySample, type SessionRow } from '../src/core/memory.ts';
import type { DevServersDoc } from '../src/features/devservers.ts';
import { viewOf, type MemoryView } from '../src/features/memory.ts';
import { lanAlias, redactDevices, redactDevServers, redactMachines, redactMemory, redactPorts, redactStatus, redactUsage, redactWorktrees, scrubText, STRICT } from '../src/remote/redact.ts';
import type { MachineStatus } from '../src/core/machines.ts';
import { readRemoteResource } from '../src/remote/tools.ts';
import type { Devices } from '../src/core/devices.ts';
import { assertClean, devices, snap, usage } from './fixtures/remote-redact.ts';

test('list_ports projection drops pids, cmdlines, ssh commands and addresses, keeps names and tailnet URLs', () => {
  const out = redactPorts(snap, { include_system: true });
  assertClean('ports', out);
  const s = JSON.stringify(out);
  assert.match(s, /box\.tail0000\.ts\.net:3080/);
  assert.match(s, /https:\/\/box\.tail0000\.ts\.net:8780\//);
  assert.equal(out.ports[0].control, 'process');
  assert.equal(out.ports[1].control, 'systemd: acme.service');
  assert.equal(out.ports[0].name, 'Web UI on [loopback]:3080');
  assert.deepEqual(Object.keys(out.ports[0]).sort(), [
    'control', 'directUrl', 'http', 'kind', 'label', 'listening', 'name', 'pinned', 'port', 'scope', 'servedUrl',
  ]);
});

test('list_devices projection drops IPs, MACs, endpoints, routes, URLs and error details', () => {
  const out = redactDevices(devices);
  assertClean('devices', out);
  assert.equal(out.devices[1].path?.type, 'direct');
  assert.equal((out.devices[1].path as any).endpoint, undefined);
  assert.equal(out.devices[1].routesSubnets, true);
  assert.equal(out.devices[0].pool?.state, 'ok');
  assert.equal((out.devices[0].pool as any).detail, undefined);
  assert.deepEqual(out.devices[0].virt, { type: 'kvm', proxmox: true });
  assert.equal(out.proxmox.hosts[0].guests[0].name, 'nas');
  assert.equal(out.proxmox.hosts[0].device, lanAlias('lan:192.168.50.2'));
  assert.equal(out.proxmox.hosts[0].guests[0].device, lanAlias('lan:192.168.50.20'));
  assert.equal(out.proxmox.error, 'Proxmox API unreachable or refused the token');
});

test('who_uses_what projection aliases lan:<ip> ids consistently and drops pids from process names', () => {
  const out = redactUsage(usage);
  assertClean('usage', out);
  assert.equal(out.cards[0].id, lanAlias('lan:192.168.50.108'));
  assert.equal(out.cards[0].name, 'LAN device');
  assert.equal(out.cards[2].id, lanAlias('lan:192.168.50.20'));
  assert.equal(out.cards[2].name, 'nas', 'user-given names stay');
  assert.equal(out.byPort[22][0].id, lanAlias('lan:192.168.50.108'), 'byPort refers to the same alias as the card');
  assert.equal(out.byPort[22][0].name, 'LAN device');
  assert.equal(out.byPort[22][1].id, 'pve1~routed', 'ids with ~ are not mistaken for paths');
  assert.equal(out.byPort[22][1].via, lanAlias('lan:192.168.50.2'));
  assert.deepEqual(out.local.uses[0].processes, ['curl']);
  assert.equal((out as any).selfLanIps, undefined);
  assert.equal((out as any).pool, undefined);
});

test('lan aliases are the same across responses and tools, and hide the address', () => {
  const a = redactUsage(usage);
  const b = redactUsage(usage);
  const d = redactDevices(devices);
  assert.equal(a.cards[2].id, b.cards[2].id, 'two calls agree');
  assert.equal(a.cards[2].id, d.proxmox.hosts[0].guests[0].device, 'who_uses_what and list_devices agree');
  assert.match(lanAlias('lan:192.168.50.20'), /^lan-device-[0-9a-f]{6}$/);
  assert.notEqual(lanAlias('lan:192.168.50.20'), lanAlias('lan:192.168.50.21'));
  assert.doesNotMatch(lanAlias('lan:192.168.50.20'), /192\.168|50\.20/, 'the hex suffix may contain any digits, never the address');
});

test('flags loosen redaction only for what they name', () => {
  const addr = redactDevices(devices, { showAddresses: true, showProcesses: false });
  assert.deepEqual(addr.devices[0].tailscaleIps, ['100.101.102.103', 'fd7a:115c:a1e0::abcd']);
  assert.equal((addr.devices[1].path as any).endpoint, '203.0.113.9:41641');
  assert.doesNotMatch(JSON.stringify(addr), /root@pam|:8006/, 'credentials and the Proxmox URL stay out with any flag');

  const procs = redactPorts(snap, {}, { showAddresses: false, showProcesses: true });
  assert.equal(procs.ports[0].control, 'process: pid 4242');
  assert.doesNotMatch(JSON.stringify(procs), /100\.101|ssh -N/);

  const u = redactUsage(usage, { showAddresses: false, showProcesses: true });
  assert.deepEqual(u.local.uses[0].processes, ['curl (3790306)', 'curl (3790307)']);
  assert.equal(u.cards[0].id, lanAlias('lan:192.168.50.108'));
});

test('scrubText: addresses by category, without mangling times, dates and versions', () => {
  assert.equal(scrubText('192.168.1.5 10.0.0.1 172.20.1.1 100.64.10.1 127.0.0.1 8.8.8.8'), '[lan-ip] [lan-ip] [lan-ip] [tailnet-ip] [loopback] [ip]');
  assert.equal(scrubText('fd7a:115c:a1e0::10:1 and 2001:db8::1'), '[tailnet-ip] and [ip]');
  assert.equal(scrubText('nic BC:24:11:0A:0B:02'), 'nic [mac]');
  assert.equal(scrubText('192.168.1.0/24'), '[lan-ip]');
  for (const keep of ['2026-10-17T12:33:32.024Z', 'up 12:33:32', 'tailscale 1.104.1', 'docker: web_next', 'pve1~routed', 'SSH (sshd)', 'std::vector']) {
    assert.equal(scrubText(keep), keep);
  }
  assert.equal(scrubText('cwd /home/alice/projects/x'), 'cwd [path]');
  assert.equal(scrubText('run ssh -N -L 22:127.0.0.1:22 alice@box'), 'run [ssh command]');
  assert.equal(scrubText('token PVEAPIToken=root@pam!pb=1234-5678'), 'token [credential]');
  assert.equal(scrubText('192.168.1.5', { ...STRICT, showAddresses: true }), '192.168.1.5');
});

test('list_devices: other hosts\' ports keep port, reach and the tailnet URL; bind addresses and processes only with their flags', () => {
  const desk: any = {
    ...devices.devices[1],
    id: 'desk',
    name: 'desk',
    dnsName: 'desk.tail0000.ts.net',
    pool: {
      name: 'desktop', kind: 'ssh', addresses: ['192.168.50.7'], state: 'ok', inRotation: true, slots: 3, busy: 0,
      listening: [{ port: 3000, address: '100.64.0.7', process: 'next-server' }, { port: 5190, address: '127.0.0.1', process: 'node' }, { port: 53, address: '10.255.255.254' }],
      listeningAt: 1792241741159,
    },
    ports: {
      at: 1792241741159,
      ports: [
        { port: 53, scope: 'other', addresses: ['10.255.255.254'], processes: [], tailnet: false, lan: false, url: null },
        { port: 3000, scope: 'tailnet', addresses: ['100.64.0.7'], processes: ['next-server'], tailnet: true, lan: false, url: 'http://desk.tail0000.ts.net:3000' },
        { port: 5190, scope: 'loopback', addresses: ['127.0.0.1', '::1'], processes: ['node'], tailnet: false, lan: false, url: null },
      ],
    },
  };
  const withDesk: Devices = { ...devices, devices: [...devices.devices, desk] };
  const out = redactDevices(withDesk);
  assertClean('devices with ports', out);
  const d = out.devices[2] as any;
  assert.equal(out.devices[0].ports, null, 'this server: list_ports, not compute-pool');
  assert.equal(d.ports.at, 1792241741159);
  assert.deepEqual(d.ports.ports[1], { port: 3000, scope: 'tailnet', tailnet: true, lan: false, url: 'http://desk.tail0000.ts.net:3000' });
  assert.deepEqual(Object.keys(d.ports.ports[0]).sort(), ['lan', 'port', 'scope', 'tailnet', 'url']);
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /next-server|"processes"|"addresses"|listening|dnsName/, 'no process names, no raw pool.listening, no dnsName');

  const loose = redactDevices(withDesk, { showAddresses: true, showProcesses: true }).devices[2] as any;
  assert.deepEqual(loose.ports.ports[2].addresses, ['127.0.0.1', '::1']);
  assert.deepEqual(loose.ports.ports[1].processes, ['next-server']);
  const addrOnly = redactDevices(withDesk, { showAddresses: true, showProcesses: false }).devices[2] as any;
  assert.equal(addrOnly.ports.ports[1].processes, undefined);
});

// ---- portboard://status (resources/read on the remote server) ----

const extras = {
  watching: [
    { kind: 'port' as const, port: 3080, name: 'Web UI on 127.0.0.1:3080', down: true, since: '2026-10-17T12:00:00.000Z' },
    { kind: 'device' as const, name: 'laptop', down: false, since: null },
  ],
  newDevices: 2,
};

test('status resource: built from the redacted projections, no addresses, pids, paths or new-device names', () => {
  const out = redactStatus({ at: '2026-10-17T12:33:32.024Z', snap, devices, usage, extras });
  assertClean('status', out);
  assert.deepEqual(out.unavailable, []);
  assert.equal(out.host, 'box');
  assert.deepEqual(out.watchedDown, [{ kind: 'port', port: 3080, name: 'Web UI on [loopback]:3080', since: '2026-10-17T12:00:00.000Z' }]);
  assert.deepEqual(out.newDevices, { pending: 2 }, 'a count only, never the list');
  const port22 = out.services!.inUse!.find((r) => r.port === 22)!;
  assert.deepEqual(port22.users, ['LAN device', 'pve1 경유'], 'the address-named LAN card is renamed as in who_uses_what');
  assert.equal(out.pool!.available, devices.pool.available);
  for (const h of out.pool!.hosts) assert.deepEqual(Object.keys(h).sort(), ['inRotation', 'name', 'state']);
});

test('status resource: showAddresses loosens it like the tools, and only then', () => {
  const strict = JSON.stringify(redactStatus({ at: 'now', snap, devices, usage, extras }));
  assert.doesNotMatch(strict, /192\.168\.50\.108/);
  const loose = JSON.stringify(redactStatus({ at: 'now', snap, devices, usage, extras }, { showAddresses: true, showProcesses: false }));
  assert.match(loose, /192\.168\.50\.108/);
  assert.doesNotMatch(loose, /root@pam|:8006|--token|\/home\//, 'credentials, URLs of the APIs and paths stay out with any flag');
});

test('status resource over resources/read: failing sources are null without their error text', async () => {
  const fail = (msg: string) => async () => Promise.reject(new Error(msg));
  const core = {
    snapshot: async () => snap,
    devices: fail('ECONNREFUSED 192.168.50.2:8006 root@pam!portboard'),
    usage: async () => usage,
    freePorts: async () => [],
    statusExtras: fail('ENOENT /home/alice/.local/state/portboard/alerts-state.json'),
  };
  const r: any = await readRemoteResource('portboard://status', core);
  assert.equal(r.contents[0].uri, 'portboard://status');
  assert.equal(r.contents[0].mimeType, 'application/json');
  const out = JSON.parse(r.contents[0].text);
  assertClean('status with failures', out);
  assert.doesNotMatch(r.contents[0].text, /ECONNREFUSED|ENOENT|alerts-state/);
  assert.deepEqual(out.unavailable, ['devices', 'watching', 'newDevices']);
  assert.equal(out.devices, null);
  assert.equal(out.pool, null);
  assert.equal(out.services.listening, 2);
});

// ---- list_worktrees, list_dev_servers, memory_usage (#8) ----

const wt = (over: Partial<WorktreeInfo>): WorktreeInfo => ({
  path: '/home/alice/projects/web/.claude/worktrees/agent-1',
  short: '~/projects/web/.claude/worktrees/agent-1',
  head: '0123456789abcdef0123456789abcdef01234567',
  branch: 'feat/login',
  detached: false,
  main: false,
  locked: false,
  prunable: false,
  changes: 0,
  lastCommit: 'fix: talk to 192.168.50.9 with --token=abc (Secret commit message)',
  sizeKb: 204800,
  mergedByAncestry: true,
  pr: null,
  inUse: [],
  keep: [],
  removable: true,
  ...over,
});

const worktreesDoc: WorktreesDoc = {
  at: '2026-10-17T12:30:00.000Z',
  scanning: false,
  tookMs: 812,
  repos: [
    {
      name: 'web',
      path: '/home/alice/projects/web',
      short: '~/projects/web',
      remote: 'https://alice:ghp_secret@github.com/acme/web.git',
      defaultBranch: 'main',
      prsKnown: true,
      error: null,
      worktrees: [
        wt({ path: '/home/alice/projects/web', short: '~/projects/web', branch: 'main', main: true, keep: ['메인 체크아웃'], removable: false }),
        wt({}),
        wt({ path: '/srv/wt/web-pr', short: '/srv/wt/web-pr', branch: 'feat/pay', changes: 3, mergedByAncestry: false, pr: { number: 42, state: 'OPEN', headMatches: true }, inUse: [4242], keep: ['변경 3개', '프로세스 1개 실행 중', 'PR #42 열림'], removable: false }),
        wt({ path: '/home/alice/projects/web/.claude/worktrees/gone', branch: null, detached: true, prunable: true, changes: null, sizeKb: null, mergedByAncestry: null, removable: false }),
      ],
    },
    {
      name: 'api',
      path: '/opt/src/api',
      short: '/opt/src/api',
      remote: null,
      defaultBranch: null,
      prsKnown: false,
      error: 'fatal: not a repository: /opt/src/api/.git',
      worktrees: [],
    },
  ],
  totals: { repos: 2, worktrees: 4, removable: 1, prunable: 1, removableKb: 204800 },
};

const devServersDoc: DevServersDoc = {
  running: [
    {
      unit: 'pb-dev-worktrees-agent-1-0a1b2c3d.service',
      path: '/home/alice/projects/web/.claude/worktrees/agent-1',
      active: true,
      state: 'active/running',
      description: 'Portboard dev: web@feat/login :5173 (dev)',
      port: 5173,
      since: '2026-10-17T11:00:00.000Z',
      owner: 'web@feat/login',
    },
    { unit: 'pb-dev-tmp-x-0a0a0a0a.service', path: '/tmp/x', active: false, state: 'failed/failed', description: 'Portboard dev: ?', port: null, since: null, owner: null },
  ],
  startable: {
    '/home/alice/projects/web/.claude/worktrees/agent-1': { scripts: { dev: 'vite --host 100.64.0.1 --token=abc', start: 'node server.js' }, preferred: 'dev', owner: 'web@feat/login' },
    '/srv/wt/web-pr': { scripts: { serve: 'serve -l 192.168.50.5:3000' }, preferred: 'serve', owner: 'web@feat/pay' },
  },
};

const session = (over: Partial<SessionRow>): SessionRow => ({
  pid: 4242,
  id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  title: 'Secret project plan',
  project: 'acme-secret',
  cwd: '/home/dev/projects/acme-secret',
  version: '2.1.299',
  stale: false,
  startedAt: '2026-10-17T08:00:00.000Z',
  uptimeSec: 16200,
  lastActive: '2026-10-17T10:00:00.000Z',
  idleMin: 150,
  cpuPct: 0,
  idle: true,
  helper: false,
  mb: 900,
  breakdown: { cli: 400, mcp: 300, servers: 150, tools: 50 },
  procs: 9,
  mcp: ['supabase-mcp-secret'],
  ...over,
});

const memorySample: Omit<MemorySample, 'cpu'> = {
  at: '2026-10-17T12:33:00.000Z',
  mem: { totalMb: 16384, usedMb: 12000, cacheMb: 2000, freeMb: 400, availableMb: 1300, availablePct: 8, shmemMb: 100, swapTotalMb: 4096, swapUsedMb: 3900, swapPct: 95 },
  psi: { some: { avg10: 4, avg60: 6.5, avg300: 3, total: 1 }, full: { avg10: 1, avg60: 1.2, avg300: 0.5, total: 1 } },
  groups: [
    { key: 'claude', label: 'Claude 세션', mb: 5000, procs: 40 },
    { key: 'mcp', label: 'MCP 서버', mb: 2400, procs: 12 },
    { key: 'services', label: '서비스', mb: 1500, procs: 6 },
    { key: 'docker', label: 'docker', mb: 1200, procs: 4 },
    { key: 'other', label: '기타', mb: 800, procs: 30 },
  ],
  rssMb: 10900,
  sessions: [
    session({}),
    session({ pid: 5151, title: 'Fix /home/alice/projects/web login', project: 'web', version: '2.1.295', stale: true, idle: false, idleMin: 2 }),
    session({ pid: 6161, title: null, project: null, helper: true }),
  ],
  newestVersion: '2.1.299',
  mcp: [
    { name: 'supabase-mcp-secret', label: 'supabase-mcp-secret', instances: 3, mb: 1200, orphans: 1, sessions: 3, procs: 6 },
    { name: 'playwright', label: '@playwright/mcp', instances: 3, mb: 1200, orphans: 0, sessions: 3, procs: 6 },
  ],
  services: [
    { name: 'web dev', ports: [5173], unit: 'pb-dev-worktrees-agent-1-0a1b2c3d.service', dev: true, unused: true, mb: 600, startedAt: '2026-10-15T08:00:00.000Z', uptimeSec: 200000, session: 'Secret project plan' },
    { name: 'acme', ports: [8780], unit: 'acme.service', dev: false, unused: false, mb: 300, startedAt: null, uptimeSec: null, session: null },
  ],
  docker: [{ name: 'supabase_db', mb: 900 }],
  other: [{ name: 'python3-secret-worker', count: 3, mb: 500 }],
};

const memoryView: MemoryView = viewOf(
  memorySample,
  { version: 1, pressure: { ...emptyPressure(), active: true, reasons: ['available', 'swap'] }, history: [], view: null },
  DEFAULT_THRESHOLDS,
  null,
);

// Paths (scrubbed or not: a projection that needs the scrub for a path copied one), commit messages, remote URLs,
// pids, error texts and commit ids.
const WORKTREE_LEAKS: [string, RegExp][] = [
  ['path', /\/home\/|~\/|\/srv\/|\/opt\/|\.claude\/worktrees|\[path\]/],
  ['commit message', /Secret commit|talk to/],
  ['remote URL', /ghp_secret|github\.com/],
  ['pid', /4242/],
  ['error text', /fatal|not a repository/],
  ['commit id', /0123456789abcdef/],
];
const DEV_LEAKS: [string, RegExp][] = [
  ['path', /\/home\/|\/srv\/|\/tmp\/|\.claude|\[path\]/],
  ['unit', /pb-dev-|\.service/],
  ['description', /Portboard dev/],
  ['command', /vite|server\.js|--token|serve -l|--host/],
];
const MEMORY_NAMES = /Secret project plan|acme-secret|supabase-mcp-secret|python3-secret-worker|@playwright\/mcp|"title"|"project"|"session"|"text"|"other":\[|"mcpServers":\[/;

function assertNone(label: string, value: unknown, leaks: [string, RegExp][]) {
  assertClean(label, value);
  const s = JSON.stringify(value);
  for (const [what, re] of leaks) assert.doesNotMatch(s, re, `${label}: ${what} leaked: ${s.match(re)?.[0]}`);
}

test('list_worktrees projection: repo, branch, state, PR, changed, size, removable and why; no paths, commits or pids', () => {
  const out = redactWorktrees(worktreesDoc);
  assertNone('worktrees', out, WORKTREE_LEAKS);
  assert.deepEqual(out.totals, { repos: 2, worktrees: 4, removable: 1, missing: 1, removableMb: 200 });
  const web = out.repos[0];
  assert.equal(web.repo, 'web');
  assert.equal(web.worktrees.length, 3, 'the main checkout is left out');
  assert.deepEqual(web.worktrees[0], { branch: 'feat/login', detached: false, state: 'merged', pr: null, changed: false, sizeMb: 200, inUse: false, removable: true, keep: [] });
  assert.deepEqual(web.worktrees[1], {
    branch: 'feat/pay',
    detached: false,
    state: 'unmerged',
    pr: { number: 42, state: 'OPEN', headMatches: true },
    changed: true,
    sizeMb: 200,
    inUse: true,
    removable: false,
    keep: ['변경 3개', '프로세스 1개 실행 중', 'PR #42 열림'],
  });
  assert.equal(web.worktrees[2].state, 'missing');
  assert.equal(web.worktrees[2].changed, null);
  assert.deepEqual(out.repos[1], { repo: 'api', defaultBranch: null, prsKnown: false, scanFailed: true, worktrees: [] });
  assert.deepEqual(Object.keys(web).sort(), ['defaultBranch', 'prsKnown', 'repo', 'scanFailed', 'worktrees']);

  assert.deepEqual(redactWorktrees(worktreesDoc, { repo: 'api' }).repos.map((r) => r.repo), ['api']);
  assert.deepEqual(redactWorktrees(worktreesDoc, { removableOnly: true }).repos[0].worktrees.map((w) => w.branch), ['feat/login']);
});

test('list_dev_servers projection: owner, state, port, since and script names; no paths, units or commands', () => {
  const out = redactDevServers(devServersDoc);
  assertNone('dev servers', out, DEV_LEAKS);
  assert.deepEqual(out.running[0], { owner: 'web@feat/login', active: true, state: 'active/running', port: 5173, since: '2026-10-17T11:00:00.000Z' });
  assert.equal(out.running[1].owner, null);
  assert.deepEqual(out.startable, [
    { owner: 'web@feat/login', scripts: ['dev', 'start'], preferred: 'dev' },
    { owner: 'web@feat/pay', scripts: ['serve'], preferred: 'serve' },
  ]);
});

test('memory_usage projection: groups, totals and pressure; no titles, projects, process names or suggestion texts', () => {
  const out = redactMemory(memoryView);
  assertNone('memory', out, [['names', MEMORY_NAMES], ['pid', /4242|5151|6161/], ['session id', /0f0e0d0c/]]);
  assert.deepEqual(out.memory, { totalGb: 16, usedGb: 11.7, availableGb: 1.3, availablePct: 8, swapTotalGb: 4, swapPct: 95, psi: { someAvg60: 6.5, fullAvg60: 1.2 } });
  assert.equal(out.pressure.active, true);
  assert.deepEqual(out.pressure.reasons, ['available', 'swap']);
  assert.deepEqual(out.pressure.thresholds, { availablePct: 10, psiSome60: 5, swapPct: 90, sustainMin: 5 });
  assert.deepEqual(out.groups.map((g) => [g.group, g.gb, g.processes]), [['claude', 4.9, 40], ['mcp', 2.3, 12], ['services', 1.5, 6], ['docker', 1.2, 4], ['other', 0.8, 30]]);
  assert.deepEqual(out.totals, {
    rssGb: 10.6, sessions: 3, idleSessions: 2, staleVersion: 1, newestVersion: '2.1.299', mcpServers: 2, mcpInstances: 6, mcpGb: 2.3, mcpOrphans: 1, services: 2, devServers: 1, docker: 1,
  });
  assert.deepEqual(out.sessions[1], { version: '2.1.295', stale: true, helper: false, idle: false, idleMin: 2, mb: 900, mcpMb: 300, uptimeH: 4.5 });
  assert.deepEqual(out.services[0], { name: 'web dev', ports: [5173], mb: 600, dev: true, unused: true });
  assert.deepEqual(out.docker, [{ name: 'supabase_db', mb: 900 }]);
  assert.ok(out.suggestions.length > 0);
  for (const s of out.suggestions) assert.deepEqual(Object.keys(s).sort(), ['kind', 'mb']);
  assert.equal(redactMemory(memoryView, 1).sessions.length, 1, 'top limits the rows');
});

test('#8 flags: showProcesses adds memory names (never pids or paths), showAddresses adds none; worktrees and dev servers never loosen', () => {
  const procs = redactMemory(memoryView, 10, { showAddresses: false, showProcesses: true });
  assert.equal(procs.sessions[0].title, 'Secret project plan');
  assert.equal(procs.sessions[0].project, 'acme-secret');
  assert.equal(procs.sessions[1].title, 'Fix [path] login', 'a path in a title is still scrubbed');
  assert.deepEqual(procs.mcpServers?.map((m) => m.name), ['supabase-mcp-secret', '@playwright/mcp']);
  assert.deepEqual(procs.other, [{ name: 'python3-secret-worker', count: 3, mb: 500 }]);
  assert.equal(procs.services[0].session, 'Secret project plan');
  assert.ok(procs.suggestions.every((s) => typeof s.text === 'string'));
  assert.doesNotMatch(JSON.stringify(procs), /4242|0f0e0d0c|"pid"|\/home\//, 'no pids, session ids or paths even then');

  assert.deepEqual(redactMemory(memoryView, 10, { showAddresses: true, showProcesses: false }), redactMemory(memoryView), 'showAddresses changes nothing here');

  const loose = { showAddresses: true, showProcesses: true };
  assert.deepEqual(redactWorktrees(worktreesDoc, {}, loose), redactWorktrees(worktreesDoc), 'no flag adds a worktree field');
  assert.deepEqual(redactDevServers(devServersDoc, loose), redactDevServers(devServersDoc), 'no flag adds a dev-server field');
});

// ---- machine_status ----

const MACH_NOW = Date.parse('2026-10-31T12:00:00.000Z');
const machAt = (agoSec: number) => new Date(MACH_NOW - agoSec * 1000).toISOString();
const machine = (over: Partial<MachineStatus>): MachineStatus => ({
  id: 'nodeid-k3j2h1',
  name: 'mac',
  kind: 'mac',
  reach: 'agent',
  online: true,
  checkedAt: machAt(5),
  stale: false,
  error: null,
  load: { cores: 10, load1: 2.5, memTotalMb: 32000, memAvailMb: 12000, diskFreePct: 30, uptimeSec: 3600 },
  claude: {
    cliVersion: '2.1.299',
    active: 1,
    idle: 1,
    source: 'ps',
    sessions: [
      { id: '0f0e0d0c', project: 'secret-client-project', worktree: 'secret-client-project@feat/acquisition', idleMin: 0, cpuPct: 12, mb: 800, startedAt: machAt(3600), idle: false },
      { id: '9a8b7c6d', project: 'notes', worktree: null, idleMin: 75, cpuPct: null, mb: null, startedAt: null, idle: true },
    ],
  },
  worktrees: [
    { owner: 'shop-web@feat/pay', repo: 'shop-web', remote: 'c10dev-private/shop-web', branch: 'feat/pay', path: '/Users/alice/projects/shop-web/.claude/worktrees/pay', main: false, dirty: 3, lastCommit: '2026-10-30T09:00:00Z', inUse: true, claude: true, reservedPort: 4105, ahead: 2, behind: 0 },
    { owner: 'shop-web@main', repo: 'shop-web', remote: 'c10dev-private/shop-web', branch: 'main', path: '~/projects/shop-web', main: true, dirty: null, lastCommit: null, inUse: false, claude: false, reservedPort: null, ahead: null, behind: null },
  ],
  ports: { listening: 12, devServers: 1 },
  capabilities: ['macos', 'xcode'],
  maxSessions: 2,
  launch: [{ via: 'remote-control', note: 'claude --remote-control on mac, at /Users/alice/projects' }],
  ...over,
});
const machinesDoc = {
  at: machAt(30),
  machines: [
    machine({ id: 'devbox', name: 'devbox', kind: 'linux', reach: 'local', checkedAt: machAt(30), launch: [{ via: 'local', note: '' }] }),
    machine({}),
    machine({ id: 'agent:desktop', name: 'desktop', kind: 'wsl', online: false, checkedAt: machAt(900), stale: true, error: 'timeout', claude: null, worktrees: null, ports: null, load: null }),
    machine({
      id: 'cloud', name: 'cloud', kind: 'cloud', reach: 'none', checkedAt: null, load: null, worktrees: null, ports: null, maxSessions: null, capabilities: ['sandbox'],
      claude: { cliVersion: null, active: 1, idle: 0, source: 'github', sessions: [{ id: null, project: 'shop-web', worktree: 'shop-web@claude/secret-feature', idleMin: 4, cpuPct: null, mb: null, startedAt: null, idle: false, remote: 'c10dev-private/shop-web' }] },
      launch: [{ via: 'cloud', note: '' }, { via: 'teleport', note: '' }],
    }),
  ],
};
const MACHINE_LEAKS: [string, RegExp][] = [
  ['path', /\/Users\/|\/home\/|~\/|\.claude\/worktrees|\[path\]/],
  ['session id', /0f0e0d0c|9a8b7c6d/],
  ['git remote', /c10dev-private/],
  ['tailnet id', /nodeid-k3j2h1/],
  ['launch note', /remote-control on/],
  ['commit date', /2026-10-30T09/],
  ['dirty count', /"dirty"/],
];

test('machine_status projection: names, load, session counts, checkouts as repo@branch; no ids, paths, remotes or session names', () => {
  const out = redactMachines(machinesDoc, {}, STRICT, MACH_NOW);
  assertNone('machines', out, [...MACHINE_LEAKS, ['session project', /secret-client-project|acquisition|claude\/secret-feature/]]);
  assert.equal(out.at, machAt(30));
  assert.deepEqual(out.machines.map((m) => [m.name, m.kind, m.reach, m.online, m.dataAgeSec, m.stale, m.error]), [
    ['devbox', 'linux', 'local', true, 30, false, null],
    ['mac', 'mac', 'agent', true, 5, false, null],
    ['desktop', 'wsl', 'agent', false, 900, true, 'timeout'],
    ['cloud', 'cloud', 'none', true, null, false, null],
  ]);
  const mac = out.machines[1];
  assert.deepEqual(mac.claude, {
    cliVersion: '2.1.299', active: 1, idle: 1, estimate: false,
    sessions: [{ idle: false, idleMin: 0, cpuPct: 12, mb: 800 }, { idle: true, idleMin: 75, cpuPct: null, mb: null }],
  });
  assert.deepEqual(mac.worktrees, [
    { repo: 'shop-web', branch: 'feat/pay', main: false, changed: true, inUse: true, claude: true, ahead: 2, behind: 0, reservedPort: 4105 },
    { repo: 'shop-web', branch: 'main', main: true, changed: null, inUse: false, claude: false, ahead: null, behind: null, reservedPort: null },
  ]);
  assert.deepEqual(mac.launch, ['remote-control']);
  assert.deepEqual(mac.capabilities, ['macos', 'xcode']);
  assert.deepEqual(Object.keys(mac).sort(), ['capabilities', 'claude', 'dataAgeSec', 'error', 'kind', 'launch', 'load', 'maxSessions', 'name', 'online', 'ports', 'reach', 'stale', 'worktrees']);
  assert.equal(out.machines[3].claude!.estimate, true);
  // the data aged since the save: stale is recomputed at read time
  assert.equal(redactMachines(machinesDoc, {}, STRICT, MACH_NOW + 120_000).machines[0].stale, true);
  // one machine, some parts
  const one = redactMachines(machinesDoc, { machine: 'MAC', include: ['load'] }, STRICT, MACH_NOW);
  assert.deepEqual(one.machines.map((m) => m.name), ['mac']);
  assert.deepEqual(['load', 'claude', 'worktrees', 'ports'].filter((k) => k in one.machines[0]), ['load']);
  assert.equal(redactMachines(machinesDoc, { machine: 'nodeid-k3j2h1' }, STRICT, MACH_NOW).machines.length, 0, 'not by the tailnet id');
});

test('machine_status with showProcesses: session projects and worktrees; still no ids, paths or remotes', () => {
  const out = redactMachines(machinesDoc, {}, { showAddresses: false, showProcesses: true }, MACH_NOW);
  assertNone('machines (showProcesses)', out, MACHINE_LEAKS);
  assert.deepEqual(out.machines[1].claude!.sessions[0], { project: 'secret-client-project', worktree: 'secret-client-project@feat/acquisition', idle: false, idleMin: 0, cpuPct: 12, mb: 800 });
  assert.equal(out.machines[3].claude!.sessions[0].worktree, 'shop-web@claude/secret-feature');
});
