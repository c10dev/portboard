import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { downsample, fetchTrends, parseRrd, toSeries, trendError, type TrendSource } from '../src/core/pvetrends.ts';
import type { ProxmoxStatus } from '../src/core/proxmox.ts';

// Trimmed real answers from pve1 (2026-10-17): the node's last hour, and 2 h of CT 204's day series.
const NODE_HOUR = JSON.parse(await readFile(new URL('./fixtures/rrddata-node-hour.json', import.meta.url), 'utf8'));
const LXC_DAY = JSON.parse(await readFile(new URL('./fixtures/rrddata-lxc-day.json', import.meta.url), 'utf8'));

test('parseRrd: node memory is memused/memtotal, cpu stays a fraction, rows sorted by time', () => {
  const shuffled = [...NODE_HOUR].reverse();
  const { points, maxcpu, maxmem } = parseRrd(shuffled, 'node');
  assert.equal(points.length, 60);
  assert.ok(points.every((p, i) => i === 0 || p.t > points[i - 1].t));
  assert.equal(maxcpu, 12);
  assert.equal(maxmem, NODE_HOUR[0].memtotal);
  const first = NODE_HOUR[0];
  assert.equal(points[0].mem, first.memused / first.memtotal);
  assert.ok(points.every((p) => p.cpu !== null && p.cpu >= 0 && p.cpu <= 1));
});

test('parseRrd: guest memory is mem/maxmem; missing or non-numeric fields are gaps, not 0', () => {
  const rows = LXC_DAY.slice(0, 5).map((r: any) => ({ ...r }));
  delete rows[1].cpu;
  rows[2].mem = null;
  rows[3].cpu = 'NaN';
  rows.push({ foo: 1 }); // no time: dropped
  const { points, maxmem } = parseRrd(rows, 'guest');
  assert.equal(points.length, 5);
  assert.equal(maxmem, 1073741824);
  assert.equal(points[1].cpu, null);
  assert.equal(points[2].mem, null);
  assert.equal(points[3].cpu, null);
  assert.equal(points[0].mem, rows[0].mem / rows[0].maxmem);
  assert.deepEqual(parseRrd('nope', 'guest').points, []);
});

test('downsample averages buckets, keeps start/step, and a bucket with no values stays null', () => {
  // 1440 one-minute points (a day) → 144 ten-minute buckets
  const pts = Array.from({ length: 1440 }, (_, i) => ({ t: 1_000_000 + i * 60, cpu: i < 600 || i >= 610 ? (i % 10) / 100 : null, mem: 0.5 }));
  const s = downsample(pts, 144);
  assert.equal(s.cpu.length, 144);
  assert.equal(s.start, 1_000_000);
  assert.equal(s.step, 600);
  assert.equal(s.cpu[0], 0.045); // mean of 0..9 / 100
  assert.equal(s.cpu[60], null); // points 600–609 were all gaps
  assert.ok(s.mem.every((v) => v === 0.5));
  // fewer points than buckets: one point per bucket
  const small = downsample(pts.slice(0, 7), 60);
  assert.equal(small.cpu.length, 7);
  assert.equal(small.step, 60);
  assert.deepEqual(downsample([], 10), { start: 0, step: 0, cpu: [], mem: [] });
});

test('toSeries on the real day fixture: 120 points → 12 buckets of 10 minutes', () => {
  const s = toSeries(LXC_DAY, 'guest', 12);
  assert.equal(s.cpu.length, 12);
  assert.equal(s.step, 600);
  assert.equal(s.maxcpu, 1);
  assert.ok(s.mem.every((v) => v !== null && v > 0.2 && v < 0.3));
});

const STATUS: ProxmoxStatus = {
  configured: true, ok: true, url: 'https://pve:8006',
  hosts: [{
    node: 'pve1', status: 'online', ip: '192.168.1.201', cpu: 0.1, maxcpu: 12, mem: 1, maxmem: 2, disk: 1, maxdisk: 2, uptime: 1, device: 'pve1',
    guests: [
      { vmid: 204, name: 'jellyfin', type: 'lxc', node: 'pve1', status: 'running', template: false, cpu: 0, maxcpu: 1, mem: 1, maxmem: 2, uptime: 1, macs: [], ips: [], device: null, deviceMatch: null },
      { vmid: 205, name: 'devbox', type: 'qemu', node: 'pve1', status: 'running', template: false, cpu: 0, maxcpu: 9, mem: 1, maxmem: 2, uptime: 1, macs: [], ips: [], device: null, deviceMatch: null },
    ],
  }],
};

const SECRET = 'SECRET-rrd-789';

function source(handler: (path: string) => unknown): TrendSource & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    status: async () => STATUS,
    config: async () => ({ url: 'https://pve:8006', tokenId: 'root@pam!portboard', secret: SECRET, fingerprint: 'AB'.repeat(32) }),
    get: async (_cfg, path) => {
      paths.push(path);
      return handler(path);
    },
  };
}

test('fetchTrends reads node and guest rrddata read-only, keyed node and node/vmid, without the secret', async () => {
  const src = source((p) => (p.includes('/lxc/') ? LXC_DAY : NODE_HOUR));
  const t = await fetchTrends('hour', src, Date.UTC(2026, 9, 17));
  assert.deepEqual(src.paths.sort(), [
    '/nodes/pve1/lxc/204/rrddata?timeframe=hour&cf=AVERAGE',
    '/nodes/pve1/qemu/205/rrddata?timeframe=hour&cf=AVERAGE',
    '/nodes/pve1/rrddata?timeframe=hour&cf=AVERAGE',
  ]);
  assert.equal(t.ok, true);
  assert.equal((t.nodes.pve1 as any).cpu.length, 60);
  assert.equal(t.guests['pve1/204'].name, 'jellyfin');
  assert.equal(t.guests['pve1/205'].type, 'qemu');
  assert.equal(JSON.stringify(t).includes(SECRET), false);
});

test('a refused rrddata call degrades only that guest; all refused → ok false with the permission named, never the token', async () => {
  const forbidden = new Error('Proxmox /nodes/pve1 → HTTP 403 (token lacks PVEAuditor)');
  const one = await fetchTrends('day', source((p) => { if (p.includes('/qemu/205/')) throw forbidden; return p.includes('/lxc/') ? LXC_DAY : NODE_HOUR; }));
  assert.equal(one.ok, true);
  assert.match((one.guests['pve1/205'] as any).error, /Sys\.Audit/);
  assert.equal((one.guests['pve1/204'] as any).error, undefined);

  const all = await fetchTrends('day', source(() => { throw forbidden; }));
  assert.equal(all.ok, false);
  assert.match(all.error ?? '', /may not read rrddata/);
  assert.equal(JSON.stringify(all).includes(SECRET), false);
  assert.equal(trendError(new Error('Proxmox did not answer within 4000 ms')), 'Proxmox did not answer within 4000 ms');
});

test('fetchTrends without a token or with a broken one passes the status through', async () => {
  const none = await fetchTrends('hour', { ...source(() => []), status: async () => ({ configured: false, ok: false, hosts: [] }) });
  assert.deepEqual([none.configured, none.ok, none.nodes, none.guests], [false, false, {}, {}]);
  const bad = await fetchTrends('hour', { ...source(() => []), status: async () => ({ configured: true, ok: false, error: 'certificate fingerprint mismatch', hosts: [] }) });
  assert.equal(bad.error, 'certificate fingerprint mismatch');
});
