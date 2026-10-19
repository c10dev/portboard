import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDevices, parsePeers } from '../src/core/devices.ts';
import { fromHostsDoc, fromStateDoc, type PoolHost } from '../src/core/pool.ts';

const status = JSON.stringify({
  Self: { HostName: 'devbox', DNSName: 'devbox.tail.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.1'], Online: true },
  Peer: {
    a: { HostName: 'Dev’s MacBook Pro', DNSName: 'dev-mac.tail.ts.net.', OS: 'macOS', Online: true, TailscaleIPs: ['100.64.10.3'], CurAddr: '118.235.12.86:45229', LastSeen: '2026-10-17T08:40:00Z' },
    b: { HostName: 'DESKTOP-PC', DNSName: 'desktop-pc.tail.ts.net.', OS: 'windows', Online: true, TailscaleIPs: ['100.64.10.2'], Relay: 'tok', Active: true, LastSeen: '0001-01-01T00:00:00Z' },
    c: { HostName: 'localhost', DNSName: 'iphone.tail.ts.net.', OS: 'iOS', Online: false, TailscaleIPs: ['100.64.10.7'], Relay: 'tok', LastSeen: '2026-10-17T06:40:00Z' },
  },
});

const host = (over: Partial<PoolHost>): PoolHost => ({ name: 'x', kind: 'ssh', addresses: [], state: 'ok', inRotation: true, slots: 1, busy: 0, ...over });

test('parsePeers names devices by DNS label and reads path fields', () => {
  const peers = parsePeers(status);
  assert.deepEqual(peers.map((p) => p.name), ['devbox', 'dev-mac', 'desktop-pc', 'iphone']);
  assert.equal(peers[0].self, true);
  assert.equal(peers[2].lastSeen, null); // zero time
  assert.deepEqual(parsePeers('nope'), []);
});

test('mergeDevices matches pool hosts by self, Tailscale address and deviceLinks', () => {
  const pool = [
    host({ name: 'devbox', kind: 'local' }),
    host({ name: 'mac', kind: 'agent', addresses: ['100.64.10.3'], state: 'agent-busy', inRotation: false }),
    host({ name: 'desktop', addresses: ['192.168.1.7'] }),
    host({ name: 'lonely', addresses: ['192.168.1.9'], state: 'host-down' }),
  ];
  const ds = mergeDevices(parsePeers(status), pool, { desktop: 'DESKTOP-PC' });
  const by = Object.fromEntries(ds.map((d) => [d.id, d]));
  assert.equal(by['devbox'].poolMatch, 'self');
  assert.equal(by['dev-mac'].pool?.name, 'mac');
  assert.equal(by['dev-mac'].poolMatch, 'address');
  assert.deepEqual(by['dev-mac'].path, { type: 'direct', endpoint: '118.235.12.86:45229' });
  assert.equal(by['desktop-pc'].pool?.name, 'desktop');
  assert.equal(by['desktop-pc'].poolMatch, 'link');
  assert.deepEqual(by['desktop-pc'].lanIps, ['192.168.1.7']);
  assert.deepEqual(by['desktop-pc'].path, { type: 'relay', region: 'tok' });
  assert.equal(by['iphone'].online, false);
  assert.equal(by['iphone'].lastSeen, '2026-10-17T06:40:00Z');
  assert.equal(by['iphone'].path, null); // relay but not active
  // unmatched pool host becomes its own entry, offline because the monitor says host-down
  assert.equal(by['pool:lonely'].online, false);
  assert.deepEqual(by['pool:lonely'].lanIps, ['192.168.1.9']);
  // ordering: self, then online, then name
  assert.deepEqual(ds.map((d) => d.id), ['devbox', 'desktop-pc', 'dev-mac', 'iphone', 'pool:lonely']);
});

test('without a link, a LAN-only pool host stays separate', () => {
  const ds = mergeDevices(parsePeers(status), [host({ name: 'desktop', addresses: ['192.168.1.7'] })], {});
  assert.ok(ds.some((d) => d.id === 'pool:desktop' && d.online));
  assert.equal(ds.find((d) => d.id === 'desktop-pc')?.pool, null);
});

test('fromHostsDoc accepts v1 only; fromStateDoc fills addresses from hosts.json', () => {
  const v1 = fromHostsDoc({ version: 1, healthAt: 5, hosts: [{ name: 'mac', kind: 'agent', addresses: null, state: 'ok', inRotation: true, slots: 1, busy: 0 }] });
  assert.equal(v1.source, 'hosts');
  assert.deepEqual(v1.hosts[0].addresses, []);
  assert.equal(fromHostsDoc({ version: 2, hosts: [] }).available, false);

  const st = fromStateDoc(
    {
      healthAt: 7,
      hosts: [
        { name: 'desktop', kind: 'ssh', slots: 3, holders: [{}], health: { state: 'ok', inRotation: true, cores: 16, runners: [{ active: true }, { active: false }] } },
        { name: 'mac', kind: 'agent', slots: 1, holders: [], health: null },
      ],
    },
    JSON.stringify({ hosts: [{ name: 'desktop', ssh: { host: '192.168.1.7' }, windows: { host: '192.168.1.7' } }] }),
  );
  assert.equal(st.source, 'state');
  assert.deepEqual(st.hosts[0].addresses, ['192.168.1.7']);
  assert.equal(st.hosts[0].busy, 1);
  assert.deepEqual(st.hosts[0].runners, { active: 1, total: 2 });
  assert.equal(st.hosts[1].state, 'unknown');
});

test('parsePeers drops Tailscale Funnel ingress nodes', () => {
  const st = JSON.parse(status);
  for (let i = 0; i < 3; i++) {
    st.Peer[`ing${i}`] = { HostName: 'funnel-ingress-node', DNSName: '', OS: '', Online: true, ShareeNode: true, Tags: ['tag:ingress'], TailscaleIPs: [`fd7a:115c:a1e0::a801:26a${i}`] };
  }
  st.Peer.shared = { HostName: 'friend-box', DNSName: '', ShareeNode: true, Online: true, TailscaleIPs: ['100.100.1.1'] };
  const names = parsePeers(JSON.stringify(st)).map((p) => p.name);
  assert.deepEqual(names, ['devbox', 'dev-mac', 'desktop-pc', 'iphone']);
});
