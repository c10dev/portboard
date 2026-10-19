// Synthetic, live-shaped redaction fixtures and the leak check, shared by test/remote-redact.test.ts and
// test/remote-dashboard.test.ts (the same objects served by a fake dashboard must come out just as clean).

import assert from 'node:assert/strict';
import type { PortEntry, Snapshot } from '../../src/core/index.ts';
import type { Devices } from '../../src/core/devices.ts';
import type { DeviceCard, Usage } from '../../src/core/usage.ts';

// Synthetic, live-shaped fixtures. Addresses are made up (RFC 1918, CGNAT, TEST-NET, locally administered MACs).

export function entry(over: Partial<PortEntry>): PortEntry {
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

export const snap: Snapshot = {
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

export const devices: Devices = {
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

export function card(over: Partial<DeviceCard>): DeviceCard {
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

export const use = {
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

export const usage: Usage = {
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
export const LEAKS: [string, RegExp][] = [
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

export function assertClean(label: string, value: unknown) {
  const s = JSON.stringify(value);
  for (const [what, re] of LEAKS) assert.doesNotMatch(s, re, `${label}: ${what} leaked: ${s.match(re)?.[0]}`);
}
