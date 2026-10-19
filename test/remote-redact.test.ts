import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PortEntry, Snapshot } from '../src/core/index.ts';
import type { Devices } from '../src/core/devices.ts';
import type { DeviceCard, Usage } from '../src/core/usage.ts';
import { redactDevices, redactPorts, redactStatus, redactUsage, scrubText, STRICT } from '../src/remote/redact.ts';
import { readRemoteResource } from '../src/remote/tools.ts';

// Synthetic, live-shaped fixtures. Addresses are made up (RFC 1918, CGNAT, TEST-NET, locally administered MACs).

function entry(over: Partial<PortEntry>): PortEntry {
  return {
    port: 0,
    listening: true,
    scope: 'loopback',
    addresses: ['127.0.0.1'],
    owned: true,
    kind: 'app',
    container: null,
    processes: [],
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
  at: '2026-10-17T12:33:32.024Z',
  host: { hostname: 'box', user: 'alice' },
  tailscale: { available: true, dnsName: 'box.tail0000.ts.net', hostName: 'box', ips: ['100.101.102.103', 'fd7a:115c:a1e0::abcd'] } as any,
  ports: [
    entry({
      port: 3080,
      name: 'Web UI on 127.0.0.1:3080',
      scope: 'tailnet',
      addresses: ['100.101.102.103'],
      processes: [{ pid: 4242, cmdline: 'node /home/alice/projects/web/server.js --token=abc', cwd: '~/projects/web', project: 'web', unit: null, unitDescription: null }],
      control: { type: 'process', pids: [4242] },
      urls: { direct: 'http://box.tail0000.ts.net:3080', served: null, ssh: 'ssh -N -L 3080:127.0.0.1:3080 alice@box' },
      canStop: true,
    }),
    entry({
      port: 8780,
      name: 'acme',
      probe: { http: true, status: 200, title: 'ACME' },
      control: { type: 'systemd', unit: 'acme.service' },
      urls: { direct: null, served: 'https://box.tail0000.ts.net:8780/', ssh: 'ssh -N -L 8780:127.0.0.1:8780 alice@box' },
    }),
  ],
};

const devices: Devices = {
  at: '2026-10-17T12:33:32.024Z',
  pool: { available: false, source: null, url: 'http://127.0.0.1:7720', healthAt: null, error: 'connect ECONNREFUSED 10.9.8.7:7720' },
  devices: [
    {
      id: 'box',
      name: 'box',
      os: 'linux',
      self: true,
      online: true,
      lastSeen: null,
      tailscaleIps: ['100.101.102.103', 'fd7a:115c:a1e0::abcd'],
      path: null,
      lanIps: ['192.168.50.5'],
      lanVia: { '192.168.50.5': 'proxmox' },
      routes: [],
      virt: { type: 'kvm', proxmoxMac: true, macs: ['02:00:00:AA:BB:CC'] },
      pool: {
        name: 'box',
        kind: 'ssh',
        addresses: ['192.168.50.5'],
        state: 'ok',
        inRotation: true,
        slots: 2,
        busy: 1,
        detail: 'ssh alice@192.168.50.5 timed out',
        cpuPct: 12,
      },
      poolMatch: 'self',
    },
    {
      id: 'laptop',
      name: 'laptop',
      os: 'macOS',
      self: false,
      online: true,
      lastSeen: '2026-10-17T12:00:00Z',
      tailscaleIps: ['100.64.0.9'],
      path: { type: 'direct', endpoint: '203.0.113.9:41641' },
      lanIps: [],
      lanVia: {},
      routes: ['192.168.50.0/24'],
      pool: null,
      poolMatch: null,
    },
  ],
  proxmox: {
    configured: true,
    ok: false,
    error: 'HTTP 401 from https://192.168.50.2:8006 for root@pam!portboard',
    looseMode: true,
    url: 'https://192.168.50.2:8006',
    hosts: [
      {
        node: 'pve',
        status: 'online',
        ip: '192.168.50.2',
        cpu: 0.1,
        maxcpu: 8,
        mem: 1,
        maxmem: 2,
        disk: 1,
        maxdisk: 2,
        uptime: 10,
        device: 'lan:192.168.50.2',
        guests: [
          {
            vmid: 101,
            name: 'nas',
            type: 'lxc',
            node: 'pve',
            status: 'running',
            template: false,
            cpu: 0,
            maxcpu: 1,
            mem: 1,
            maxmem: 2,
            uptime: 5,
            macs: ['02:00:00:11:22:33'],
            ips: ['192.168.50.20/24'],
            lanIp: '192.168.50.20',
            device: 'lan:192.168.50.20',
            deviceMatch: 'ip',
          },
        ],
      },
    ],
  },
};

function card(over: Partial<DeviceCard>): DeviceCard {
  return {
    id: 'x',
    name: 'x',
    nameSource: 'tailscale',
    kind: 'tailnet',
    os: null,
    vendor: null,
    mac: null,
    randomMac: false,
    networks: [],
    addresses: [],
    tailscaleIps: [],
    lanIps: [],
    online: true,
    lastSeen: null,
    path: null,
    pool: null,
    poolMatch: null,
    nameKey: null,
    lanVia: {},
    routes: [],
    virt: null,
    guestOf: null,
    pveHost: null,
    uses: [],
    connections: 0,
    bytes: 0,
    ...over,
  } as DeviceCard;
}

const use = {
  port: 22,
  service: 'SSH',
  fullName: 'SSH (sshd)',
  kind: 'system' as const,
  url: 'tcp://box.tail0000.ts.net:22',
  via: 'direct' as const,
  servePort: null,
  connections: 2,
  bytesSent: 10,
  bytesReceived: 20,
  rttMs: 1.5,
  since: '2026-10-17T11:55:54.455Z',
  processes: ['curl (3790306)'],
  routed: false,
};

const usage: Usage = {
  at: '2026-10-17T12:33:32.024Z',
  observingSince: '2026-10-17T11:00:00.000Z',
  cards: [
    card({
      id: 'lan:192.168.50.108',
      name: '192.168.50.108',
      nameSource: 'ip',
      kind: 'lan',
      mac: '16:22:4f:0a:0b:06',
      addresses: ['192.168.50.108'],
      lanIps: ['192.168.50.108'],
      nameKey: 'mac:16:22:4f:0a:0b:06',
      uses: [use],
      connections: 2,
    }),
    card({ id: 'laptop', name: 'laptop', tailscaleIps: ['100.64.0.9'], addresses: ['100.64.0.9'], uses: [{ ...use, port: 8780, service: 'acme' }] }),
    card({ id: 'lan:192.168.50.20', name: 'nas', nameSource: 'user', kind: 'lan', addresses: ['192.168.50.20'] }),
  ],
  local: { connections: 1, uses: [{ ...use, port: 8790, service: 'Portboard', processes: ['curl (3790306)', 'curl (3790307)'] }] },
  byPort: {
    22: [
      { id: 'lan:192.168.50.108', name: '192.168.50.108', kind: 'lan', connections: 2 },
      { id: 'pve1~routed', name: 'pve1 경유', kind: 'routed', via: 'lan:192.168.50.2', connections: 1 },
    ],
    8780: [{ id: 'laptop', name: 'laptop', kind: 'tailnet', connections: 1 }],
  },
  idleServices: 3,
  pool: devices.pool,
  selfLanIps: ['192.168.50.5'],
  proxmox: { configured: true, ok: true, hosts: 1 },
};

// What must never appear in a strict-policy result.
const LEAKS: [string, RegExp][] = [
  ['IPv4', /\b\d{1,3}(?:\.\d{1,3}){3}\b/],
  ['IPv6', /fd7a:|::[0-9a-f]/i],
  ['MAC', /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i],
  ['home path', /\/home\/|~\//],
  ['ssh command', /ssh -N|alice@/],
  ['pid', /\bpid\b|\(\d{3,}\)|4242/],
  ['cmdline', /--token|server\.js/],
  ['proxmox token id', /root@pam/],
  ['proxmox / pool URL', /:8006|:7720/],
  ['looseMode', /looseMode/],
  ['nameKey', /nameKey|mac:/],
];

function assertClean(label: string, value: unknown) {
  const s = JSON.stringify(value);
  for (const [what, re] of LEAKS) assert.doesNotMatch(s, re, `${label}: ${what} leaked: ${s.match(re)?.[0]}`);
}

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
  assert.equal(out.proxmox.hosts[0].device, 'lan-device-1');
  assert.equal(out.proxmox.hosts[0].guests[0].device, 'lan-device-2');
  assert.equal(out.proxmox.error, 'Proxmox API unreachable or refused the token');
});

test('who_uses_what projection aliases lan:<ip> ids consistently and drops pids from process names', () => {
  const out = redactUsage(usage);
  assertClean('usage', out);
  assert.equal(out.cards[0].id, 'lan-device-1');
  assert.equal(out.cards[0].name, 'LAN device');
  assert.equal(out.cards[2].id, 'lan-device-2');
  assert.equal(out.cards[2].name, 'nas', 'user-given names stay');
  assert.equal(out.byPort[22][0].id, 'lan-device-1', 'byPort refers to the same alias as the card');
  assert.equal(out.byPort[22][0].name, 'LAN device');
  assert.equal(out.byPort[22][1].id, 'pve1~routed', 'ids with ~ are not mistaken for paths');
  assert.equal(out.byPort[22][1].via, 'lan-device-3');
  assert.deepEqual(out.local.uses[0].processes, ['curl']);
  assert.equal((out as any).selfLanIps, undefined);
  assert.equal((out as any).pool, undefined);
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
  assert.equal(u.cards[0].id, 'lan-device-1');
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
