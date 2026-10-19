import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKeyscan, sameMachine } from '../src/core/hostkeys.ts';
import {
  checkConfig, matchGuests, parseClusterStatus, parseGuestConfig, parseNodeStatus, parseResources, pveGet, proxmoxStatus, resetProxmoxCache,
  type ProxmoxStatus,
} from '../src/core/proxmox.ts';

// ---- host keys ----

const SCAN = [
  '# 192.168.1.201:22 SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4',
  '192.168.1.201 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleHostKeyForTestsOnly0000000000000000',
  '192.168.1.201 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=',
  '[100.64.10.8]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleHostKeyForTestsOnly0000000000000000',
  'garbage line',
].join('\n');

test('parseKeyscan groups keys per host and strips [host]:port', () => {
  const m = parseKeyscan(SCAN);
  assert.equal(m.get('192.168.1.201')?.length, 2);
  assert.match(m.get('100.64.10.8')?.[0] ?? '', /^ssh-ed25519 AAAAC3/);
  assert.equal(m.size, 2);
});

test('sameMachine ties a LAN IP to the tailnet device presenting the same host key', () => {
  const keys = new Map<string, string[]>([
    ['192.168.1.201', ['ssh-ed25519 PVE']],
    ['100.64.10.8', ['ssh-ed25519 PVE']],
    ['192.168.1.7', []],
    ['100.64.10.3', ['ssh-ed25519 MAC']],
  ]);
  const peers = [{ name: 'dev-mac', ips: ['100.64.10.3'] }, { name: 'pve1', ips: ['100.64.10.8'] }];
  const m = sameMachine(['192.168.1.201', '192.168.1.7', '192.168.1.99'], peers, (ip) => keys.get(ip));
  assert.deepEqual([...m], [['192.168.1.201', 'pve1']]);
});

// ---- Proxmox parsing (shapes from the PVE API docs) ----

const RESOURCES = [
  { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online', cpu: 0.07, maxcpu: 12, mem: 5.8e10, maxmem: 6.7e10, disk: 9.7e9, maxdisk: 6.8e10, uptime: 891982 },
  { id: 'qemu/205', type: 'qemu', vmid: 205, name: 'devbox', node: 'pve1', status: 'running', cpu: 0.05, maxcpu: 10, mem: 5.1e10, maxmem: 5.4e10, uptime: 800000 },
  { id: 'lxc/203', type: 'lxc', vmid: 203, name: 'nas', node: 'pve1', status: 'running', cpu: 0.001, maxcpu: 2, mem: 1.1e8, maxmem: 1.07e9, uptime: 800000 },
  { id: 'lxc/204', type: 'lxc', vmid: 204, name: 'jellyfin', node: 'pve1', status: 'running', mem: 2.5e8, maxmem: 1.07e9 },
  { id: 'qemu/202', type: 'qemu', vmid: 202, name: 'docker-vm', node: 'pve1', status: 'stopped', maxmem: 8.6e9 },
  { id: 'qemu/9000', type: 'qemu', vmid: 9000, name: 'tmpl', node: 'pve1', status: 'stopped', template: 1 },
  { id: 'storage/pve1/local', type: 'storage', node: 'pve1', storage: 'local' },
];

test('parseResources splits nodes and guests, sorted by vmid, templates flagged', () => {
  const { nodes, guests } = parseResources(RESOURCES);
  assert.deepEqual(nodes.map((n) => [n.node, n.status, n.maxcpu]), [['pve1', 'online', 12]]);
  assert.deepEqual(guests.map((g) => [g.vmid, g.type, g.name, g.status, g.template]), [
    [202, 'qemu', 'docker-vm', 'stopped', false],
    [203, 'lxc', 'nas', 'running', false],
    [204, 'lxc', 'jellyfin', 'running', false],
    [205, 'qemu', 'devbox', 'running', false],
    [9000, 'qemu', 'tmpl', 'stopped', true],
  ]);
  assert.equal(guests[0].cpu, null);
  assert.deepEqual(parseResources('nope'), { nodes: [], guests: [] });
});

test('parseClusterStatus, parseNodeStatus and parseGuestConfig', () => {
  assert.deepEqual([...parseClusterStatus([{ type: 'cluster', name: 'c' }, { type: 'node', name: 'pve1', ip: '192.168.1.201', online: 1 }])], [['pve1', '192.168.1.201']]);
  assert.deepEqual(parseNodeStatus({ cpu: 0.1, cpuinfo: { cpus: 12 }, memory: { used: 5, total: 10 }, rootfs: { used: 1, total: 4 }, uptime: 9 }), {
    cpu: 0.1, maxcpu: 12, mem: 5, maxmem: 10, disk: 1, maxdisk: 4, uptime: 9,
  });
  assert.deepEqual(parseGuestConfig({ net0: 'virtio=bc:24:11:0a:0b:02,bridge=vmbr0,firewall=1', scsi0: 'local-lvm:vm-205-disk-0' }), { macs: ['BC:24:11:0A:0B:02'], ips: [] });
  assert.deepEqual(parseGuestConfig({ net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:0A:0B:04,ip=192.168.1.203/24,gw=192.168.1.1,type=veth', net1: 'name=eth1,hwaddr=BC:24:11:00:00:01,ip=dhcp' }), {
    macs: ['BC:24:11:0A:0B:04', 'BC:24:11:00:00:01'],
    ips: ['192.168.1.203'],
  });
});

test('checkConfig wants https, a token id and a SHA-256 fingerprint', () => {
  const ok = { url: 'https://192.168.1.201:8006/', tokenId: 'root@pam!portboard', secret: 's', fingerprint: 'AB:'.repeat(31) + 'AB' };
  assert.deepEqual(checkConfig(ok), { ...ok, url: 'https://192.168.1.201:8006' });
  assert.match(checkConfig({ ...ok, url: 'http://x:8006' }) as string, /https/);
  assert.match(checkConfig({ ...ok, tokenId: 'root@pam' }) as string, /tokenId/);
  assert.match(checkConfig({ ...ok, fingerprint: 'AB:CD' }) as string, /fingerprint/);
  assert.match(checkConfig({ ...ok, secret: '' }) as string, /secret/);
});

test('matchGuests: own MAC > LAN IP owner > tailnet name > MAC on the LAN > static IP', () => {
  const st: ProxmoxStatus = {
    configured: true,
    ok: true,
    hosts: [
      {
        node: 'pve1', status: 'online', ip: '192.168.1.201', cpu: 0, maxcpu: 12, mem: 0, maxmem: 0, disk: 0, maxdisk: 0, uptime: 0, device: null,
        guests: [
          g(205, 'devbox', ['BC:24:11:0A:0B:02']),
          g(203, 'nas', ['BC:24:11:0A:0B:04'], ['192.168.1.203']),
          g(204, 'jellyfin', ['BC:24:11:0A:0B:05'], ['192.168.1.204']),
          g(206, 'desktop-vm', ['BC:24:11:00:00:07']),
          g(207, 'quiet', ['BC:24:11:00:00:08'], ['192.168.1.207']),
          g(208, 'unknown', ['BC:24:11:00:00:09']),
        ],
      },
    ],
  };
  const out = matchGuests(st, {
    self: { id: 'devbox', macs: ['BC:24:11:0A:0B:02'] },
    deviceIds: ['devbox', 'pve1', 'nas', 'desktop-pc'],
    neighbors: new Map([
      ['192.168.1.203', 'bc:24:11:0a:0b:04'],
      ['fe80::be24:11ff:fec8:3a44', 'bc:24:11:0a:0b:04'],
      ['192.168.1.204', 'bc:24:11:0a:0b:05'],
      ['192.168.1.7', 'bc:24:11:00:00:07'],
    ]),
    lanOwner: new Map([['192.168.1.7', 'desktop-pc'], ['192.168.1.201', 'pve1']]),
  });
  const h = out.hosts[0];
  assert.equal(h.device, 'pve1');
  assert.deepEqual(h.guests.map((x) => [x.vmid, x.device, x.deviceMatch, x.lanIp]), [
    [205, 'devbox', 'mac', null],
    [203, 'nas', 'name', '192.168.1.203'], // IPv4 only, not the link-local neighbour
    [204, 'lan:192.168.1.204', 'mac', '192.168.1.204'],
    [206, 'desktop-pc', 'mac', '192.168.1.7'],
    [207, 'lan:192.168.1.207', 'ip', null],
    [208, null, null, null],
  ]);
  assert.equal(st.hosts[0].guests[0].device, null, 'input is not modified');
});

function g(vmid: number, name: string, macs: string[], ips: string[] = []) {
  return { vmid, name, type: 'qemu' as const, node: 'pve1', status: 'running', template: false, cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, uptime: 0, macs, ips, device: null, deviceMatch: null };
}

// ---- TLS pinning and the secret ----

async function tlsServer() {
  const dir = await mkdtemp(join(tmpdir(), 'portboard-pve-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=pve',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  const cert = await readFile(join(dir, 'c.pem'), 'utf8');
  const key = await readFile(join(dir, 'k.pem'), 'utf8');
  const fingerprint = new X509Certificate(cert).fingerprint256;
  const seen: string[] = [];
  const server = createServer({ cert, key }, (req, res) => {
    seen.push(String(req.headers.authorization ?? ''));
    if (req.url === '/api2/json/cluster/resources') return void res.end(JSON.stringify({ data: RESOURCES.slice(0, 2) }));
    if (req.url === '/api2/json/cluster/status') return void res.end(JSON.stringify({ data: [{ type: 'node', name: 'pve1', ip: '192.168.1.201' }] }));
    if (req.url?.endsWith('/status')) return void res.end(JSON.stringify({ data: { cpu: 0.2, cpuinfo: { cpus: 12 } } }));
    if (req.url?.endsWith('/config')) return void res.end(JSON.stringify({ data: { net0: 'virtio=BC:24:11:0A:0B:02,bridge=vmbr0' } }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { dir, server, port, fingerprint, seen };
}

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('pveGet talks to a pinned certificate and never sends the token to a different one', { skip: !hasOpenssl && 'openssl not installed' }, async () => {
  const s = await tlsServer();
  try {
    const cfg = { url: `https://127.0.0.1:${s.port}`, tokenId: 'root@pam!portboard', secret: 'SECRET-123', fingerprint: s.fingerprint };
    const data = await pveGet(cfg, '/cluster/resources');
    assert.equal(data.length, 2);
    assert.deepEqual(s.seen, ['PVEAPIToken=root@pam!portboard=SECRET-123']);

    const wrong = { ...cfg, fingerprint: createHash('sha256').update('other').digest('hex') };
    await assert.rejects(pveGet(wrong, '/cluster/resources'), (e: Error) => /fingerprint mismatch/.test(e.message) && !e.message.includes('SECRET'));
    assert.equal(s.seen.length, 1, 'no request reached the server with the wrong fingerprint');
  } finally {
    s.server.close();
  }
});

test('proxmoxStatus: no file is not an error; a working file gives a tree without the secret', { skip: !hasOpenssl && 'openssl not installed' }, async () => {
  resetProxmoxCache();
  const missing = await proxmoxStatus(join(tmpdir(), 'nope-portboard', 'proxmox.json'));
  assert.deepEqual(missing, { configured: false, ok: false, hosts: [] });

  const s = await tlsServer();
  try {
    const path = join(s.dir, 'proxmox.json');
    await writeFile(path, JSON.stringify({ url: `https://127.0.0.1:${s.port}`, tokenId: 'root@pam!portboard', secret: 'SECRET-456', fingerprint: s.fingerprint }));
    await chmod(path, 0o644);
    resetProxmoxCache(); // cached for 30 s; the call above filled it
    const st = await proxmoxStatus(path);
    assert.equal(st.ok, true);
    assert.equal(st.looseMode, true);
    assert.equal(st.hosts[0].node, 'pve1');
    assert.equal(st.hosts[0].ip, '192.168.1.201');
    assert.deepEqual(st.hosts[0].guests.map((x) => [x.vmid, x.macs]), [[205, ['BC:24:11:0A:0B:02']]]);
    assert.equal(JSON.stringify(st).includes('SECRET-456'), false);
  } finally {
    s.server.close();
  }
});
