import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dashboardReader, dashboardSources, type DashboardOptions } from '../src/remote/dashboard.ts';
import { callRemoteTool, readRemoteResource, type RemoteCore } from '../src/remote/tools.ts';
import { assertClean, devices, snap, usage } from './fixtures/remote-redact.ts';

// #5: the remote server reads the dashboard's snapshot, devices and usage over loopback, and computes them itself only
// while the dashboard is down. A fake dashboard on an ephemeral port stands in for src/server.ts.

// /api/usage is the dashboard's UsageOut: Usage plus history and 새 기기, which must never reach a remote client.
const usageOut = {
  ...usage,
  cards: usage.cards.map((c) => ({ ...c, lastUsed: { '192.168.50.108': '2026-10-17T12:00:00.000Z' } })),
  history: { '22': { lastUsedAt: '2026-10-17T12:00:00.000Z', by: ['lan:192.168.50.108'] } },
  newDevices: { pending: [{ name: '192.168.50.108', mac: '16:22:4f:0a:0b:06' }] },
};
const ANSWERS: Record<string, unknown> = { '/api/ports': snap, '/api/devices': devices, '/api/usage': usageOut };

interface Fake {
  server: Server;
  port: number;
  seen: { path: string; headers: IncomingHttpHeaders }[];
  close(): Promise<void>;
}

async function fakeDashboard(answer?: (path: string) => { status: number; body: string } | null, port = 0): Promise<Fake> {
  const seen: Fake['seen'] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    const a = answer ? answer(req.url ?? '') : { status: ANSWERS[req.url ?? ''] ? 200 : 404, body: JSON.stringify(ANSWERS[req.url ?? ''] ?? { error: 'not found' }) };
    if (!a) return; // never answers
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(a.body);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on (bound, then released) */
async function deadPort(): Promise<number> {
  const f = await fakeDashboard();
  await f.close();
  return f.port;
}

/** RemoteCore over the reader, with local reads that count and answer the same fixtures */
function coreFor(opts: DashboardOptions) {
  const local = { snapshot: 0, devices: 0, usage: 0 };
  const logs: string[] = [];
  const reader = dashboardReader({ log: (l) => logs.push(l), ...opts });
  const src = dashboardSources(reader, {
    snapshot: async () => (local.snapshot++, snap),
    devices: async () => (local.devices++, devices),
    usage: async () => (local.usage++, usage),
  });
  const core: RemoteCore = { ...src, freePorts: async () => [], statusExtras: async () => ({ watching: [], newDevices: 0 }) };
  return { core, local, logs, reader };
}

const textOf = (r: { content: { text: string }[] }) => r.content[0].text;

test('the remote reads snapshot, devices and usage from the dashboard over loopback, redacted as before', async () => {
  const fake = await fakeDashboard();
  try {
    const { core, local, logs } = coreFor({ port: fake.port });
    const ports = await callRemoteTool('list_ports', { include_system: true }, core);
    const devs = await callRemoteTool('list_devices', {}, core);
    const who = await callRemoteTool('who_uses_what', {}, core);
    const status = await readRemoteResource('portboard://status', core);
    assert.deepEqual(local, { snapshot: 0, devices: 0, usage: 0 }, 'nothing computed locally');
    assert.deepEqual(logs, []);
    assert.deepEqual(new Set(fake.seen.map((s) => s.path)), new Set(['/api/ports', '/api/devices', '/api/usage']));
    for (const [label, r] of [['ports', ports], ['devices', devs], ['usage', who]] as const) {
      assert.ok(!r.isError, label);
      assertClean(label, JSON.parse(textOf(r)));
    }
    assertClean('status', status);
    assert.match(textOf(ports), /box\.tail0000\.ts\.net:3080/, 'the dashboard\'s data, tailnet URL kept');
    assert.match(textOf(who), /LAN device/);
    assert.doesNotMatch(textOf(who), /lastUsed|newDevices|"history"/, 'the dashboard\'s extra usage fields are never copied');
  } finally {
    await fake.close();
  }
});

test('each request is the remote\'s own: 127.0.0.1 Host, no client headers, cookies or query', async () => {
  const fake = await fakeDashboard();
  try {
    const { core } = coreFor({ port: fake.port });
    await core.snapshot();
    const [r] = fake.seen;
    assert.equal(r.path, '/api/ports');
    assert.equal(r.headers.host, `127.0.0.1:${fake.port}`);
    assert.deepEqual(Object.keys(r.headers).sort(), ['accept', 'connection', 'host', 'user-agent']);
    assert.equal(r.headers['user-agent'], 'portboard-remote');
  } finally {
    await fake.close();
  }
});

test('dashboard down (connection refused): local reads, one log line, results still redacted', async () => {
  const { core, local, logs } = coreFor({ port: await deadPort() });
  const ports = await callRemoteTool('list_ports', { include_system: true }, core);
  const who = await callRemoteTool('who_uses_what', {}, core);
  assert.equal(local.snapshot, 1);
  assert.equal(local.usage, 1);
  assertClean('ports', JSON.parse(textOf(ports)));
  assertClean('usage', JSON.parse(textOf(who)));
  assert.equal(logs.length, 1, 'one line per outage');
  assert.match(logs[0], /not answering .*reading locally/);
});

test('dashboard down: back-off before trying it again, then back to the dashboard', async () => {
  const port = await deadPort();
  let t = 1_000_000;
  const { core, local, logs, reader } = coreFor({ port, backoffMs: 10_000, now: () => t });
  await core.snapshot();
  assert.equal(local.snapshot, 1);
  assert.ok(reader.backingOff());

  const fake = await fakeDashboard(undefined, port);
  try {
    t += 5_000;
    await core.snapshot();
    await core.devices();
    assert.equal(fake.seen.length, 0, 'not dialled during the back-off');
    assert.deepEqual(local, { snapshot: 2, devices: 1, usage: 0 });

    t += 5_001;
    assert.ok(!reader.backingOff());
    assert.deepEqual(await core.snapshot(), snap);
    assert.equal(fake.seen.length, 1);
    assert.equal(local.snapshot, 2, 'from the dashboard again');
    assert.match(logs.at(-1)!, /answering again/);
  } finally {
    await fake.close();
  }
});

test('dashboard accepts but never answers: answer timeout counts as down', async () => {
  const fake = await fakeDashboard(() => null);
  try {
    const { core, local, reader } = coreFor({ port: fake.port, answerTimeoutMs: 150 });
    const started = Date.now();
    assert.deepEqual(await core.usage(), usage);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(local.usage, 1);
    assert.ok(reader.backingOff());
  } finally {
    await fake.close();
  }
});

test('an error or a wrong shape from a live dashboard: that read is local, no back-off', async () => {
  const fake = await fakeDashboard((path) =>
    path === '/api/ports' ? { status: 500, body: '{"error":"x"}' } : path === '/api/devices' ? { status: 200, body: '{"devices":"nope"}' } : { status: 200, body: 'not json' },
  );
  try {
    const { core, local, reader, logs } = coreFor({ port: fake.port });
    assert.deepEqual(await core.snapshot(), snap);
    assert.deepEqual(await core.devices(), devices);
    assert.deepEqual(await core.usage(), usage);
    assert.deepEqual(local, { snapshot: 1, devices: 1, usage: 1 });
    assert.ok(!reader.backingOff());
    assert.deepEqual(logs, []);
  } finally {
    await fake.close();
  }
});
