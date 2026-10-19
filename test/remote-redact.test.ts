import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanAlias, redactDevices, redactPorts, redactStatus, redactUsage, scrubText, STRICT } from '../src/remote/redact.ts';
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
  assert.doesNotMatch(lanAlias('lan:192.168.50.20'), /192|168/);
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
