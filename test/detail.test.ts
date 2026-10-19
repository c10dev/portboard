import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PortEntry } from '../src/core/index.ts';
import type { WatchStatus } from '../src/core/alerts.ts';
import { emptyHistory, record, type History, type UsageWithHistory } from '../src/core/history.ts';
import { serviceDetail, type DetailInput } from '../src/core/detail.ts';
import { detail as uptimeDetail, emptyUptime, recordCheck } from '../src/core/uptime.ts';
import { callTool, TOOLS, type Core } from '../src/mcp/tools.ts';
import { detailReport } from '../src/features/service-detail.ts';
import { REMOTE_TOOL_NAMES, REMOTE_TOOLS } from '../src/remote/tools.ts';

const T0 = Date.parse('2026-10-17T00:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function entry(over: Partial<PortEntry>): PortEntry {
  return {
    port: 0, listening: true, scope: 'loopback', addresses: ['127.0.0.1'], owned: true, kind: 'app', container: null,
    composeProject: null, processes: [], systemOwner: null, group: null, role: null, name: 'x', detectedName: 'x',
    label: null, pinned: false, hidden: false, alert: false, visible: true, probe: null, served: null,
    urls: { direct: null, served: null, ssh: '' }, canExpose: false, exposeBlocker: null, control: null,
    canRestart: false, canStop: false, ...over,
  };
}

const uploader = entry({
  port: 8780, name: 'uploader', detectedName: 'uploader', alert: true,
  processes: [{ pid: 7, cmdline: 'node server.js', cwd: '/home/dev/projects/uploader', project: 'uploader', unit: 'uploader.service', unitDescription: 'uploader' }],
  control: { type: 'systemd', unit: 'uploader.service' }, canRestart: true, canStop: true,
  group: { key: 'unit:uploader.service', name: 'uploader', ports: [8780, 8781] }, role: '웹 (HTTP)',
  probe: { http: true, status: 200, title: 'uploader' },
});

/** History: the Mac used 8780 an hour a day for 10 days, the iPhone once 20 days ago, this server just now; 3000 by the Mac. */
function history(): History {
  const h = emptyHistory();
  const mac = { device: 'dev-mac', name: 'dev-mac', kind: 'tailnet', nameKey: null, service: 'uploader', connections: 1 };
  for (let d = 9; d >= 0; d--) for (let m = 0; m < 60; m += 0.5) record(h, [{ ...mac, port: 8780 }], T0 - d * DAY + m * MIN);
  record(h, [{ device: 'iphone', name: 'iphone', kind: 'tailnet', nameKey: null, port: 8780, service: 'uploader', connections: 2 }], T0 - 20 * DAY);
  record(h, [{ device: 'local', name: '이 서버', kind: 'local', nameKey: null, port: 8780, service: 'uploader', connections: 1 }], T0 + 59 * MIN);
  record(h, [{ ...mac, port: 3000, service: 'next' }], T0);
  return h;
}

function usage(): UsageWithHistory {
  const row = (port: number, since: string, routed = false) => ({ port, since, routed, connections: 1, firstSeen: null, activeSince: null }) as any;
  return {
    byPort: {
      8780: [
        { id: 'dev-mac', name: 'dev-mac', kind: 'tailnet', connections: 2 },
        { id: 'pve1~routed', name: 'pve1 경유', kind: 'routed', via: 'pve1', connections: 1 },
        { id: 'local', name: '이 서버', kind: 'local', connections: 1 },
      ],
    },
    cards: [
      { id: 'dev-mac', uses: [row(3000, '2026-10-17T00:30:00.000Z'), row(8780, '2026-10-17T00:10:00.000Z')] },
      { id: 'pve1', uses: [row(8780, '2026-10-17T00:50:00.000Z', true)] },
    ],
    local: { connections: 1, uses: [row(8780, '2026-10-17T00:55:00.000Z')] },
    history: { startedAt: null, byPort: {}, byDevice: {} },
  } as any;
}

const watch: WatchStatus = { key: 'port:8780', kind: 'port', port: 8780, name: 'uploader', down: false, since: null, alerted: false, quietUntil: null };

function input(over: Partial<DetailInput> = {}): DetailInput {
  return { port: 8780, now: T0 + HOUR, ports: [uploader, entry({ port: 3000 })], usage: usage(), history: history(), watch, uptime: null, events: [], ...over };
}

test('detail: who uses it now, with since from the right card row (routed through its router)', () => {
  const d = serviceDetail(input())!;
  assert.equal(d.name, 'uploader');
  assert.equal(d.listening, true);
  assert.equal(d.entry?.port, 8780);
  assert.deepEqual(d.usingNow, [
    { id: 'dev-mac', name: 'dev-mac', kind: 'tailnet', connections: 2, since: '2026-10-17T00:10:00.000Z' },
    { id: 'pve1~routed', name: 'pve1 경유', kind: 'routed', via: 'pve1', connections: 1, since: '2026-10-17T00:50:00.000Z' },
    { id: 'local', name: '이 서버', kind: 'local', connections: 1, since: '2026-10-17T00:55:00.000Z' },
  ]);
});

test('detail: devices × last seen for this port only, newest first, minutes over 7 and 30 days', () => {
  const d = serviceDetail(input())!;
  assert.deepEqual(d.lastUsed.map((r) => r.device), ['dev-mac', 'local', 'iphone']);
  const mac = d.lastUsed[0];
  assert.equal(mac.minutes7d, 7 * 60);
  assert.equal(mac.minutes30d, 10 * 60);
  assert.equal(mac.firstSeen, new Date(T0 - 9 * DAY).toISOString());
  const phone = d.lastUsed[2];
  assert.equal(phone.minutes7d, 0);
  assert.equal(phone.minutes30d, 0.5);
  assert.equal(phone.peak, 2);
  assert.ok(d.historySince);
});

test('detail: a watched port that is down has a page from the watch, history and uptime alone', () => {
  const u = emptyUptime();
  for (let i = 0; i < 10; i++) recordCheck(u, 8780, T0 + i * 30_000, i < 6 ? 'u' : 'd');
  const now = T0 + 9 * 30_000 + 1000;
  const d = serviceDetail(input({
    now, ports: [], usage: usage(),
    watch: { ...watch, down: true, since: new Date(T0 + 6 * 30_000).toISOString(), alerted: true },
    uptime: uptimeDetail(u, 8780, now),
    events: [{ t: new Date(now).toISOString(), kind: 'down', title: 'portboard: 8780 uploader is down', ok: true }],
  }))!;
  assert.equal(d.listening, false);
  assert.equal(d.entry, null);
  assert.equal(d.name, 'uploader');
  assert.deepEqual(d.usingNow, []); // nothing listens: stale usage rows don't count
  assert.equal(d.watched, true);
  assert.equal(d.uptime?.outages[0].to, null);
  assert.equal(d.events.length, 1);
});

test('detail: null for a port Portboard knows nothing about; name falls back to the history', () => {
  assert.equal(serviceDetail(input({ port: 4444, watch: null })), null);
  const d = serviceDetail(input({ port: 3000, ports: [], watch: null }))!;
  assert.equal(d.name, 'next');
  assert.equal(d.watched, false);
  assert.deepEqual(d.lastUsed.map((r) => r.device), ['dev-mac']);
});

test('service_detail MCP tool: local only, read-only, compact report, isError for unknown ports', async () => {
  const tool = TOOLS.find((t) => t.name === 'service_detail');
  assert.equal(tool?.annotations.readOnlyHint, true);
  assert.equal(REMOTE_TOOL_NAMES.has('service_detail'), false);
  assert.equal(REMOTE_TOOLS.some((t) => t.name === 'service_detail'), false);

  const core = { serviceDetail: async (port: number) => serviceDetail(input({ port, watch: port === 8780 ? watch : null })) } as unknown as Core;
  const r = await callTool('service_detail', { port: 8780 }, core);
  assert.equal(r.isError, undefined);
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.service.control, 'systemd: uploader.service');
  assert.deepEqual(body.service.group, { name: 'uploader', ports: [8780, 8781], role: '웹 (HTTP)' });
  assert.equal(body.usingNow.length, 3);
  assert.equal(body.alert, true);
  assert.equal(body.uptime, null);
  assert.equal('entry' in body, false);
  assert.deepEqual(detailReport(serviceDetail(input())!), body);

  const unknown = await callTool('service_detail', { port: 4444 }, core);
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /nothing is known about port 4444/);
  assert.equal((await callTool('service_detail', { port: 0 }, core)).isError, true);
  assert.equal((await callTool('service_detail', { port: 8780 }, {} as Core)).isError, true);
});
