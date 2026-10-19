// The network tree in the UI: the sidebar's 기기 rows (features/nav.js navDevices → lib/shell-boot.js fill, painted
// from the pb.nav cache before anything loads, folded from pb.navFold) and the words lib/nettree.js gives each row.
// Neutral names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDocument, fakeWindow, loadPage, runBoot } from './fixtures/fake-dom.ts';
import { bootLocale, expandShell } from '../src/core/shell.ts';
import { buildNetTree } from '../src/core/nettree.ts';
import type { Device } from '../src/core/devices.ts';
// @ts-expect-error plain browser module, no types
import { navDevices } from '../public/features/nav.js';
// @ts-expect-error plain browser module, no types
import { flatten, nodeBadges, nodeTarget, reachText, routedTitle, subnetLabel } from '../public/lib/nettree.js';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const BOOT = read('public/lib/shell-boot.js');

const dev = (id: string, over: Partial<Device> = {}): Device => ({
  id, name: id, dnsName: null, os: 'linux', self: false, online: true, lastSeen: null, tailscaleIps: ['100.64.0.1'], path: null,
  lanIps: [], lanVia: {}, routes: [], standbyRoutes: [], pool: null, poolMatch: null, ports: null, portsSource: null, ...over,
});

const devices = [
  dev('box', { self: true }),
  dev('hv1', { routes: ['10.0.0.0/24'], lanIps: ['10.0.0.2'] }),
  dev('desk', { lanIps: ['10.0.0.7'], pool: { state: 'agent-busy' } as any }),
  dev('laptop', { path: { type: 'relay', region: 'tok' } }),
];
const proxmox = {
  configured: true, ok: true,
  hosts: [{
    node: 'hv1', status: 'online', ip: '10.0.0.2', cpu: null, maxcpu: null, mem: null, maxmem: null, disk: null, maxdisk: null, uptime: null, device: 'hv1',
    guests: [
      { vmid: 205, name: 'box', type: 'qemu', node: 'hv1', status: 'running', template: false, cpu: null, maxcpu: null, mem: null, maxmem: null, uptime: null, macs: [], ips: [], device: 'box', deviceMatch: 'mac' },
      { vmid: 204, name: 'media', type: 'lxc', node: 'hv1', status: 'running', template: false, cpu: null, maxcpu: null, mem: null, maxmem: null, uptime: null, macs: [], ips: ['10.0.0.44'], lanIp: '10.0.0.44', device: 'lan:10.0.0.44', deviceMatch: 'mac' },
      { vmid: 206, name: 'spare', type: 'qemu', node: 'hv1', status: 'stopped', template: false, cpu: null, maxcpu: null, mem: null, maxmem: null, uptime: null, macs: [], ips: [], device: null, deviceMatch: null },
    ],
  }],
} as any;
const tree = buildNetTree({ devices, proxmox, lanHosts: [{ ip: '10.0.0.1', mac: null, name: 'gateway', seen: 'neighbor' }, { ip: '10.0.0.9', mac: null, name: 'tv', seen: 'client' }], selfLanIps: ['10.0.0.205'] });

test('navDevices: tree rows with depth, the groups above, fold, badges and where a click goes', () => {
  const rows = navDevices({ devices, tree });
  const view = rows.map((r: any) => `${'  '.repeat(r.depth)}${r.text}${r.badges.length ? ` [${r.badges.join(',')}]` : ''}${r.sub ? ` (${r.sub})` : ''}`);
  assert.deepEqual(view, [
    'hv1',
    '  media [LAN 전용] (CT 204)',
    '  box [이 서버] (VM 205)',
    '  spare [오프라인] (VM 206)',
    '  LAN 10.0.0.0/24 · hv1가 라우팅',
    '    desk (10.0.0.7)',
    '    tv [경유] (10.0.0.9)',
    '    gateway [ARP] (10.0.0.1)',
    '직접 연결',
    '  laptop [DERP]',
  ]);
  const by = (text: string) => rows.find((r: any) => r.text === text);
  assert.deepEqual([by('hv1').fold, by('hv1').up, by('hv1').href, by('hv1').tone], [true, [], 'devices.html#hv1', 'ok']);
  assert.deepEqual(by('tv').up, ['host:hv1', 'subnet:10.0.0.0/24@hv1']);
  assert.equal(by('tv').href, 'devices.html#lan%3A10.0.0.9');
  assert.equal(by('tv').tone, 'lan');
  // a guest with no device opens its Proxmox sheet; a compute-pool host keeps its pool state's tone
  assert.equal(by('spare').href, 'devices.html#guest%3Ahv1%2F206');
  assert.equal(by('spare').tone, 'off');
  assert.equal(by('desk').tone, 'warn');
  // groups are headings: no link, they fold
  assert.deepEqual([by('직접 연결').href, by('직접 연결').fold, by('직접 연결').tone], [null, true, null]);
  assert.match(by('tv').title, /hv1 경유로만/);
});

test('navDevices: an older server without a tree keeps the flat list', () => {
  const rows = navDevices({ devices });
  assert.deepEqual(rows.map((r: any) => r.text), ['box (이 서버)', 'hv1', 'desk', 'laptop']);
  assert.equal(rows[0].depth, undefined);
});

function boot(storage: Map<string, string>) {
  const doc = new FakeDocument();
  globalThis.document = doc as any;
  loadPage(doc, expandShell(read('public/devices.html'), { hostname: 'box', boot: BOOT }));
  const win: any = fakeWindow(1440, storage);
  const b = runBoot(BOOT, doc, win);
  b.start({ inspector: false, ...bootLocale('ko') });
  b.paintSide();
  return { doc, b };
}

test('boot: the cached tree paints indented and folded before anything loads; a fold click is remembered', () => {
  const items = navDevices({ devices, tree });
  const storage = new Map([['pb.nav', JSON.stringify({ devices: items })], ['pb.navFold', JSON.stringify({ 'subnet:10.0.0.0/24@hv1': 1 })]]);
  const { doc } = boot(storage);
  const sec = doc.getElementById('sideDevices')!;
  assert.equal(sec.hidden, false);
  assert.ok(sec.classList.contains('side-tree'));
  const lis = sec.querySelectorAll('li');
  assert.equal(lis.length, items.length);
  const text = (li: any) => li.querySelector('.si-text').textContent;
  // the LAN group is folded: its three machines are hidden, the group row itself is not
  assert.deepEqual(lis.filter((li: any) => li.hidden).map(text), ['desk', 'tv', 'gateway']);
  const lanRow = lis.find((li: any) => text(li).startsWith('LAN'))!;
  assert.equal(lanRow.style['--d'], '1');
  const btn = lanRow.querySelector('button')!;
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.ok(lanRow.querySelector('span')!.classList.contains('si-group'));
  // the badges and the link
  const box = lis.find((li: any) => text(li) === 'box')!;
  assert.deepEqual(box.querySelectorAll('.si-badge').map((b: any) => b.textContent), ['이 서버']);
  assert.equal(box.querySelector('a')!.getAttribute('href'), 'devices.html#box');
  assert.equal(box.querySelector('a')!.dataset.target, 'box');
  // unfold by clicking the ▸ (the click reaches the section's one listener)
  sec.dispatch('click', { target: btn });
  assert.deepEqual(JSON.parse(storage.get('pb.navFold')!), {});
  assert.equal(lis.filter((li: any) => li.hidden).length, 0);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  // fold the host from its ▸: everything under it hides, 직접 연결 stays
  const hostBtn = lis[0].querySelector('button')!;
  sec.dispatch('click', { target: hostBtn });
  assert.deepEqual(JSON.parse(storage.get('pb.navFold')!), { 'host:hv1': 1 });
  assert.deepEqual(lis.filter((li: any) => !li.hidden).map(text), ['hv1', '직접 연결', 'laptop']);
});

test('boot: an old flat cache and broken fold storage still paint', () => {
  const storage = new Map([['pb.nav', JSON.stringify({ devices: [{ key: 'a', text: 'a', tone: 'ok', href: 'devices.html#a' }] })], ['pb.navFold', '{nope']]);
  const { doc } = boot(storage);
  const sec = doc.getElementById('sideDevices')!;
  assert.equal(sec.querySelectorAll('li').length, 1);
  assert.equal(sec.classList.contains('side-tree'), false);
  assert.equal(sec.querySelector('li')!.querySelector('button'), null);
});

test('words: reach, subnet labels, standby, the routed chip sentence, click targets', () => {
  assert.equal(reachText('tailnet')[0], 'tailnet 직접');
  assert.equal(reachText('routed', 'gw')[0], 'gw 경유로만');
  assert.equal(reachText('arp')[0], 'ARP로만 확인');
  const { rows, names } = flatten(tree);
  const lan = rows.find((r: any) => r.node.kind === 'subnet').node;
  assert.equal(subnetLabel(lan, 'hv1', names), 'LAN 10.0.0.0/24 · hv1가 라우팅');
  const standby = { kind: 'subnet', name: 'LAN 10.0.0.0/24', subnet: { cidr: '10.0.0.0/24', router: 'gw-b', role: 'standby', primary: 'gw-a', standby: [] } };
  assert.equal(subnetLabel(standby, 'gw-b', new Map([['gw-a', 'gw-a']])), 'LAN 10.0.0.0/24 · 대기 (지금은 gw-a가 라우팅)');
  assert.deepEqual(nodeBadges(standby).map((b: any) => b.text), ['대기']);
  assert.match(routedTitle('gw', ['10.0.0.0/24']), /^10\.0\.0\.0\/24를 gw이 라우팅해서 출발지가 gw로 보여요/);
  assert.equal(nodeTarget({ device: null, guest: { node: 'hv1', vmid: 7 } }), 'guest:hv1/7');
  const tv = rows.find((r: any) => r.node.name === 'tv');
  assert.equal(tv.router, 'hv1');
  assert.deepEqual(nodeBadges(tv.node, { full: true, router: tv.router }).map((b: any) => b.text), ['hv1 경유로만']);
});
