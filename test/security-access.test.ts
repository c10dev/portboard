// Security review v1.0 fixes, access/audit/headers: which device a serve or direct caller is and the write-device
// allowlist (M1), denied requests can't flush the audit log (M2), anti-framing and other headers (L3), proxy markers
// (L5, table in access.test.ts), private state writes and the unit's hardening (L6), 500s without error text, and
// the dashboard server's limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  classify,
  deviceAllowed,
  deviceResolver,
  forwardedAddr,
  isTailnetAddr,
  loadWriteDevices,
  parseWhois,
  resolveCaller,
  restrictToDevices,
  type Device,
  type WriteDevices,
} from '../src/core/access.ts';
import { AuditLog, deniedPathOf, deviceOf, type AuditEntry } from '../src/core/audit.ts';
import { appendPrivate, writePrivate } from '../src/core/atomic.ts';
import { appRouter, createRouter } from '../src/features/router.ts';
import type { Route } from '../src/features/types.ts';
import type { ServerContext } from '../src/features/context.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OWNER = 'owner@example.com';
const tmp = () => mkdtempSync(join(tmpdir(), 'pb-secaccess-'));
const MAC: Device = { addr: '100.101.102.103', name: 'dev-mac', id: 'nMacStable1CNTRL' };
const DOCKER: Device = { addr: '100.64.0.9', name: 'docker-vm', id: 'nDockerStbl1CNTRL' };
const DEVICES: Record<string, Device> = { [MAC.addr]: MAC, [DOCKER.addr]: DOCKER };
const serveFrom = (addr: string, login = OWNER) => ({ 'x-forwarded-for': addr, 'x-forwarded-host': 'devbox.example.ts.net', 'x-forwarded-proto': 'https', 'tailscale-user-login': login });
const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress } });

// ---- M1: which device ----

test('forwardedAddr: one IP from X-Forwarded-For, else nothing; isTailnetAddr: the CGNAT and Tailscale ULA ranges', () => {
  assert.equal(forwardedAddr(req('127.0.0.1', { 'x-forwarded-for': '100.101.102.103' })), '100.101.102.103');
  assert.equal(forwardedAddr(req('127.0.0.1', { 'x-forwarded-for': ' fd7a:115c:a1e0::1 ' })), 'fd7a:115c:a1e0::1');
  assert.equal(forwardedAddr(req('127.0.0.1', { 'x-forwarded-for': '::ffff:100.64.0.9' })), '100.64.0.9');
  for (const bad of ['', 'x', '100.64.0.9, 10.0.0.1', '100.64.0.9; rm -rf', '--json', '1.2.3.4.5']) {
    assert.equal(forwardedAddr(req('127.0.0.1', { 'x-forwarded-for': bad })), null, JSON.stringify(bad));
  }
  assert.equal(forwardedAddr(req('127.0.0.1')), null);
  for (const ip of ['100.64.0.1', '100.127.255.254', '100.64.10.1', 'fd7a:115c:a1e0::10:1']) assert.ok(isTailnetAddr(ip), ip);
  for (const ip of ['100.63.255.255', '100.128.0.1', '192.168.1.5', '127.0.0.1', 'fd00::1', 'not-an-ip']) assert.ok(!isTailnetAddr(ip), ip);
});

test('classify: serve carries the X-Forwarded-For address; a direct caller only ever its socket', () => {
  assert.equal(classify(req('127.0.0.1', serveFrom(MAC.addr)), OWNER).addr, MAC.addr);
  assert.equal(classify(req('127.0.0.1', serveFrom('a, b')), OWNER).addr, undefined);
  const direct = classify(req('100.64.0.9', serveFrom(MAC.addr)), OWNER);
  assert.equal(direct.addr, '100.64.0.9', 'a direct caller can not claim another device with X-Forwarded-For');
});

/** What `tailscale whois --json` prints (keys and endpoints included, which must never come out) */
const WHOIS = JSON.stringify({
  Node: {
    ID: 1090221079517879,
    StableID: 'nMacStable1CNTRL',
    Name: 'dev-mac.example.ts.net.',
    ComputedName: 'dev-mac',
    Key: 'nodekey:SECRETKEY',
    Endpoints: ['220.120.72.160:44676'],
    Addresses: ['100.101.102.103/32'],
    Hostinfo: { Hostname: 'MacBook' },
  },
  UserProfile: { LoginName: OWNER, ProfilePicURL: 'https://pic.example/x' },
});

test('parseWhois: name, stable ID and tags only', () => {
  assert.deepEqual(parseWhois(WHOIS, MAC.addr), MAC);
  const tagged = JSON.stringify({ Node: { StableID: 'nT', Name: 'ci-runner.tail.ts.net.', Tags: ['tag:ci'] } });
  assert.deepEqual(parseWhois(tagged, '100.64.0.5'), { addr: '100.64.0.5', name: 'ci-runner', id: 'nT', tags: ['tag:ci'] });
  assert.deepEqual(parseWhois('peer not found', '100.64.0.6'), { addr: '100.64.0.6' });
  assert.deepEqual(parseWhois('{}', '100.64.0.6'), { addr: '100.64.0.6' });
  assert.ok(!JSON.stringify(parseWhois(WHOIS, MAC.addr)).match(/SECRETKEY|220\.120|pic\.example|gmail/));
});

test('deviceResolver: whois argv per address, cached; misses kept shorter; never for non-tailnet addresses; bounded', async () => {
  let t = 1_000;
  const calls: string[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const resolve = deviceResolver({
    now: () => t,
    ttlMs: 180_000,
    missMs: 60_000,
    max: 3,
    run: async (args) => {
      calls.push(args);
      await gate;
      return args[2] === MAC.addr ? { ok: true, stdout: WHOIS, stderr: '' } : { ok: false, stdout: '', stderr: 'peer not found' };
    },
  });
  const [a, b] = [resolve(MAC.addr), resolve(MAC.addr)];
  release();
  assert.deepEqual(await a, MAC);
  assert.deepEqual(await b, MAC);
  assert.deepEqual(calls, [['whois', '--json', MAC.addr]], 'concurrent lookups share one run, argv only');
  t += 179_000;
  await resolve(MAC.addr);
  assert.equal(calls.length, 1, 'cached for 3 minutes');
  t += 2_000;
  await resolve(MAC.addr);
  assert.equal(calls.length, 2, 'looked up again after');

  assert.deepEqual(await resolve('100.64.0.77'), { addr: '100.64.0.77' });
  await resolve('100.64.0.77');
  assert.equal(calls.length, 3, 'a miss is cached too');
  t += 61_000;
  await resolve('100.64.0.77');
  assert.equal(calls.length, 4, 'but only for a minute');

  assert.deepEqual(await resolve('192.168.1.5'), { addr: '192.168.1.5' });
  assert.deepEqual(await resolve('203.0.113.9'), { addr: '203.0.113.9' });
  assert.equal(calls.length, 4, 'no whois outside the tailnet ranges (funnel clients, LAN)');

  for (let i = 1; i <= 10; i++) await resolve(`100.64.1.${i}`);
  const before = calls.length;
  await resolve('100.64.1.10');
  assert.equal(calls.length, before, 'the newest addresses stay cached when the cap evicts');
  const failing = deviceResolver({ run: async () => Promise.reject(new Error('spawn ENOENT')) });
  assert.deepEqual(await failing(MAC.addr), { addr: MAC.addr }, 'no tailscale binary: the address alone');
});

test('loadWriteDevices: file (0600) and env merged; unset is null; a loose or broken file fails closed', async () => {
  const dir = tmp();
  const file = join(dir, 'access.json');
  assert.equal(await loadWriteDevices(file, {}), null, 'no file, no env');
  assert.deepEqual(await loadWriteDevices(file, { PORTBOARD_WRITE_DEVICES: ' iphone , ,dev-mac' }), { list: ['iphone', 'dev-mac'] });
  writeFileSync(file, JSON.stringify({ writeDevices: ['dev-mac', ' nMac '] }), { mode: 0o600 });
  assert.deepEqual(await loadWriteDevices(file, {}), { list: ['dev-mac', 'nMac'] });
  assert.deepEqual(await loadWriteDevices(file, { PORTBOARD_WRITE_DEVICES: 'iphone,dev-mac' }), { list: ['dev-mac', 'nMac', 'iphone'] }, 'union, no duplicates');
  writeFileSync(file, JSON.stringify({ other: 1 }));
  assert.equal(await loadWriteDevices(file, {}), null, 'a file without writeDevices sets nothing');
  writeFileSync(file, JSON.stringify({ writeDevices: [] }));
  assert.deepEqual(await loadWriteDevices(file, {}), { list: [] }, 'an empty list: nobody writes through serve');
  for (const [text, why] of [['{torn', /JSON/], ['[]', /객체/], [JSON.stringify({ writeDevices: 'mac' }), /문자열 목록/], [JSON.stringify({ writeDevices: [1] }), /문자열 목록/]] as const) {
    writeFileSync(file, text);
    const got = await loadWriteDevices(file, {});
    assert.match(got?.error ?? '', why, text);
  }
  writeFileSync(file, JSON.stringify({ writeDevices: ['dev-mac'] }));
  chmodSync(file, 0o644);
  assert.match((await loadWriteDevices(file, {}))?.error ?? '', /600/, 'readable by others: refused');
  chmodSync(file, 0o620);
  assert.match((await loadWriteDevices(file, {}))?.error ?? '', /600/, 'writable by the group: refused');
});

test('deviceAllowed: stable ID exactly, short or full MagicDNS name in any case', () => {
  const yes = [['dev-mac'], ['Dev-Mac'], ['dev-mac.example.ts.net'], ['dev-mac.example.ts.net.'], ['nMacStable1CNTRL'], ['x', ' dev-mac ']];
  for (const list of yes) assert.ok(deviceAllowed(MAC, list), list.join());
  const no = [[], ['nmacstable1cntrl'], ['dev-ma'], ['macbook-pro'], ['iphone'], ['']];
  for (const list of no) assert.ok(!deviceAllowed(MAC, list), list.join());
  assert.ok(!deviceAllowed({ addr: '100.64.0.5' }, ['100.64.0.5']), 'addresses are not names');
  assert.ok(!deviceAllowed(undefined, ['dev-mac']));
});

const owner = (device?: Device) => ({ ...classify(req('127.0.0.1', serveFrom(device?.addr ?? MAC.addr)), OWNER), ...(device ? { device } : {}) });

test('restrictToDevices: a table of callers and allowlists', () => {
  const allow: WriteDevices = { list: ['dev-mac', 'iphone'] };
  const CASES: { name: string; c: ReturnType<typeof owner>; allow: WriteDevices | null; canWrite: boolean; reason?: RegExp }[] = [
    { name: 'no allowlist: the owner from any device, as before', c: owner(DOCKER), allow: null, canWrite: true },
    { name: 'listed device', c: owner(MAC), allow, canWrite: true },
    { name: 'unlisted owner-login server', c: owner(DOCKER), allow, canWrite: false, reason: /docker-vm\(100\.64\.0\.9\)은\(는\) 쓰기 허용 기기가 아니에요/ },
    { name: 'whois did not know it', c: owner({ addr: '100.64.0.42' }), allow, canWrite: false, reason: /확인하지 못했어요 \(100\.64\.0\.42\)/ },
    { name: 'no device at all', c: owner(), allow, canWrite: false, reason: /확인하지 못했어요/ },
    { name: 'empty allowlist', c: owner(MAC), allow: { list: [] }, canWrite: false, reason: /쓰기 허용 기기가 아니에요/ },
    { name: 'broken access.json fails closed', c: owner(MAC), allow: { list: ['dev-mac'], error: 'JSON이 아니에요' }, canWrite: false, reason: /access\.json.*JSON이 아니에요/ },
  ];
  for (const k of CASES) {
    const got = restrictToDevices(k.c, k.allow);
    assert.equal(got.canWrite, k.canWrite, k.name);
    if (k.reason) assert.match(got.reason ?? '', k.reason, k.name);
  }
  const loopback = classify(req('127.0.0.1'), OWNER);
  assert.equal(restrictToDevices(loopback, { list: [] }).canWrite, true, 'loopback is not limited by the allowlist');
  const other = classify(req('127.0.0.1', serveFrom(MAC.addr, 'guest@example.com')), OWNER);
  assert.equal(restrictToDevices(other, { list: ['dev-mac'] }).canWrite, false, 'a listed device does not make another login the owner');
});

test('resolveCaller: device for serve (X-Forwarded-For) and direct (socket); none looked up for loopback', async () => {
  const asked: string[] = [];
  const deps = { owner: async () => OWNER, device: async (a: string) => (asked.push(a), DEVICES[a] ?? { addr: a }), writeDevices: async () => ({ list: ['dev-mac'] }) };
  const mac = await resolveCaller(req('127.0.0.1', serveFrom(MAC.addr)), deps);
  assert.deepEqual([mac.canWrite, mac.device], [true, MAC]);
  const docker = await resolveCaller(req('127.0.0.1', serveFrom(DOCKER.addr)), deps);
  assert.deepEqual([docker.canWrite, docker.device], [false, DOCKER]);
  const direct = await resolveCaller(req(DOCKER.addr, serveFrom(MAC.addr)), deps);
  assert.deepEqual([direct.source, direct.canWrite, direct.device], ['direct', false, DOCKER]);
  const local = await resolveCaller(req('127.0.0.1'), deps);
  assert.deepEqual([local.source, local.canWrite, local.device], ['loopback', true, undefined]);
  assert.deepEqual(asked, [MAC.addr, DOCKER.addr, DOCKER.addr]);
  const broken = await resolveCaller(req('127.0.0.1', serveFrom(MAC.addr)), { ...deps, device: async () => Promise.reject(new Error('x')) });
  assert.deepEqual([broken.canWrite, broken.device], [false, { addr: MAC.addr }], 'whois failing with an allowlist set: denied');
});

// ---- the router with an allowlist, and the audit line's device ----

function request(method: string, remoteAddress: string, headers: Record<string, string> = {}, body?: string) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as any;
  r.method = method;
  r.headers = headers;
  r.socket = { remoteAddress };
  return r;
}

function context(audit: AuditLog, allow: WriteDevices | null) {
  return { owner: async () => OWNER, device: async (a: string) => DEVICES[a] ?? { addr: a }, writeDevices: async () => allow, audit } as unknown as ServerContext;
}

const ROUTES: Route[] = [
  { method: 'POST', path: '/api/ports/:port/poke', write: true, body: { limit: 1024 }, handler: async () => ({ status: 200, body: { message: 'poked' } }) },
  {
    method: 'POST',
    path: '/api/boom',
    write: true,
    handler: async () => {
      throw new Error('ENOENT: /home/dev/.config/portboard/secret-path.json');
    },
  },
];

test('appRouter with writeDevices: the listed device writes, another owner-login device gets 403 naming it; both recorded with the device', async () => {
  const audit = new AuditLog(join(tmp(), 'audit.jsonl'));
  const ctx = context(audit, { list: ['dev-mac'] });
  const route = appRouter(ROUTES, ctx);
  const at = (q: any) => route(q, new URL('http://x/api/ports/8080/poke'), ctx);
  assert.equal((await at(request('POST', '127.0.0.1', { 'x-portboard': '1', ...serveFrom(MAC.addr) }, '{}')))?.status, 200);
  const denied = await at(request('POST', '127.0.0.1', { 'x-portboard': '1', ...serveFrom(DOCKER.addr) }, '{}'));
  assert.equal(denied?.status, 403);
  assert.match((denied?.body as { reason: string }).reason, /docker-vm\(100\.64\.0\.9\)/);
  assert.equal((await at(request('POST', '127.0.0.1', { 'x-portboard': '1' }, '{}')))?.status, 200, 'loopback unaffected');
  const log = await audit.query();
  const byDevice = Object.fromEntries(log.map((e) => [e.device?.name ?? e.who, [e.result, e.device]]));
  assert.deepEqual(byDevice['dev-mac'], ['ok', { addr: MAC.addr, name: MAC.name, id: MAC.id }]);
  assert.deepEqual(byDevice['docker-vm'], ['denied', { addr: DOCKER.addr, name: DOCKER.name, id: DOCKER.id }]);
  assert.deepEqual(byDevice.local, ['ok', undefined]);
});

test('GET /api/whoami: the device and, when the allowlist excludes it, why', async () => {
  const { REGISTRY } = await import('../src/features/registry.ts');
  const audit = new AuditLog(join(tmp(), 'audit.jsonl'));
  const ctx = context(audit, { list: ['dev-mac'] });
  const route = appRouter(REGISTRY.routes, ctx);
  const who = async (q: any) => (await route(q, new URL('http://x/api/whoami'), ctx))?.body as Record<string, any>;
  const docker = await who(request('GET', '127.0.0.1', serveFrom(DOCKER.addr)));
  assert.equal(docker.canWrite, false);
  assert.deepEqual(docker.device, { addr: DOCKER.addr, name: DOCKER.name, id: DOCKER.id });
  assert.match(docker.reason, /docker-vm/);
  const mac = await who(request('GET', '127.0.0.1', serveFrom(MAC.addr)));
  assert.equal(mac.canWrite, true);
  assert.equal(mac.device.name, 'dev-mac');
});

test('deviceOf: identifiers only, cleaned', () => {
  assert.equal(deviceOf(undefined), undefined);
  assert.deepEqual(deviceOf({ addr: '100.64.0.1', name: 'a\nb', id: 'n1', tags: ['tag:x'] }), { addr: '100.64.0.1', name: 'a b', id: 'n1' });
});

// ---- M2: denied floods ----

test('M2: 7000 denied POSTs leave the earlier allowed entries in the log, and are counted, not written one by one', async () => {
  const dir = tmp();
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  const ctx = context(audit, null);
  const route = appRouter(ROUTES, ctx);
  for (const port of [5281, 5282]) await route(request('POST', '127.0.0.1', { 'x-portboard': '1' }, '{}'), new URL(`http://x/api/ports/${port}/poke`), ctx);
  for (let i = 0; i < 7000; i++) {
    const hdr = i % 2 ? { 'x-portboard': '1' } : {};
    const out = await route(request('POST', '100.64.1.2', hdr), new URL('http://x/api/ports/1/poke'), ctx);
    assert.equal(out?.status, 403);
  }
  const ok = (await audit.query({ limit: 500 })).filter((e) => e.result === 'ok');
  assert.deepEqual(ok.map((e) => e.target.port).sort(), [5281, 5282], 'the allowed writes are still there');
  assert.ok(!existsSync(`${audit.path}.1`), 'audit.jsonl never rotated');
  const deniedLines = readFileSync(audit.deniedPath, 'utf8').trim().split('\n');
  assert.equal(deniedLines.length, 2, 'one line per kind of denial (no header / owner only) so far');
  await audit.flush();
  const after = readFileSync(audit.deniedPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AuditEntry);
  assert.equal(after.length, 4);
  assert.equal(after.reduce((n, e) => n + (e.count ?? 1), 0), 7000, 'every denial is counted');
  assert.ok(after.every((e) => e.who === '100.64.1.2' && e.result === 'denied'));
  assert.equal(statSync(audit.deniedPath).mode & 0o777, 0o600);
  assert.ok(readFileSync(audit.path, 'utf8').split('\n').filter(Boolean).every((l) => JSON.parse(l).result === 'ok'), 'no denial in audit.jsonl');
});

test('M2: denials of many kinds fill only their own capped file', async () => {
  const audit = new AuditLog(join(tmp(), 'audit.jsonl'), { maxBytes: 4_000, deniedMaxBytes: 2_000 });
  const ok: AuditEntry = { at: '2026-10-18T00:00:00.000Z', who: 'local', source: 'loopback', route: 'POST /api/ports/:port/restart', target: { port: 4000 }, result: 'ok', status: 200 };
  await audit.append(ok);
  for (let i = 0; i < 500; i++) {
    await audit.append({ at: new Date(Date.parse(ok.at) + 1000 + i).toISOString(), who: `100.64.2.${i % 250}`, source: 'direct', route: `POST /api/r${i}`, target: {}, result: 'denied', status: 403, detail: 'owner only' });
  }
  assert.deepEqual((await audit.query({ port: 4000 })).map((e) => e.result), ['ok']);
  assert.ok(statSync(audit.deniedPath).size <= 2_000 && statSync(`${audit.deniedPath}.1`).size <= 2_000, 'the denied file stays bounded');
  assert.ok(!existsSync(`${audit.path}.1`));
  await audit.flush();
});

test('M2 coalescing: first denial at once, repeats in the minute become one counted line, a steady flood one line a minute', async () => {
  let t = Date.parse('2026-10-18T10:00:00Z');
  const audit = new AuditLog(join(tmp(), 'audit.jsonl'), { now: () => t, windowMs: 60_000 });
  const deny = (who = '100.64.3.3', detail = 'owner only'): AuditEntry => ({ at: new Date(t).toISOString(), who, source: 'direct', route: 'POST /api/ports/:port/stop', target: { port: 1 }, result: 'denied', status: 403, detail });
  const lines = () => (existsSync(audit.deniedPath) ? readFileSync(audit.deniedPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AuditEntry) : []);
  await audit.append(deny());
  assert.equal(lines().length, 1);
  assert.equal(lines()[0].count, undefined, 'the first one is a plain line');
  for (let i = 0; i < 10; i++) {
    t += 1_000;
    await audit.append(deny());
  }
  await audit.append(deny('100.64.3.4'));
  await audit.append(deny('100.64.3.3', 'missing X-Portboard header'));
  assert.equal(lines().length, 3, 'another caller or reason is another kind');
  t += 60_000;
  // A steady flood: 3 more minutes, one denial every 2 s
  for (let i = 0; i < 90; i++) {
    t += 2_000;
    await audit.append(deny());
  }
  const mine = lines().filter((e) => e.who === '100.64.3.3' && e.detail === 'owner only');
  assert.equal(mine[1].count, 10);
  assert.equal(mine[1].since, new Date(Date.parse('2026-10-18T10:00:01Z')).toISOString());
  assert.ok(mine.length <= 5, `about one line a minute (${mine.length})`);
  await audit.flush();
  assert.equal(lines().filter((e) => e.who === '100.64.3.3' && e.detail === 'owner only').reduce((n, e) => n + (e.count ?? 1), 0), 101);
  const q = await audit.query({ port: 1, limit: 100 });
  assert.ok(q.every((e, i) => i === 0 || q[i - 1].at >= e.at), 'newest first across both files');
});

// ---- 500s ----

test('a handler error: generic Korean message and a request id; the text only in the server log, not the audit line', async () => {
  const audit = new AuditLog(join(tmp(), 'audit.jsonl'));
  const ctx = context(audit, null);
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(' '));
  try {
    for (const route of [appRouter(ROUTES, ctx), createRouter(ROUTES)]) {
      const out = await route(request('POST', '127.0.0.1', { 'x-portboard': '1' }), new URL('http://x/api/boom'), ctx);
      assert.equal(out?.status, 500);
      const body = out?.body as { error: string; requestId: string };
      assert.match(body.requestId, /^[0-9a-f]{8}$/);
      assert.match(body.error, /서버 오류/);
      assert.ok(body.error.includes(body.requestId));
      assert.ok(!JSON.stringify(body).includes('secret-path'));
      assert.ok(logged.some((l) => l.includes(body.requestId) && l.includes('secret-path')), 'the detail is logged with the id');
    }
  } finally {
    console.error = orig;
  }
  const [e] = await audit.query();
  assert.equal(e.result, 'error');
  assert.ok(!JSON.stringify(e).includes('secret-path'), 'the audit line is shown on the dashboard: no error text there');
  assert.match(e.detail ?? '', /요청 ID [0-9a-f]{8}/);
});

// ---- server.ts: headers and limits (read from the source: the module binds ports at import) ----

test('server.ts: anti-framing, nosniff and no-referrer on every answer; timeouts and a connection cap on every listener', () => {
  const src = readFileSync(`${ROOT}src/server.ts`, 'utf8');
  assert.match(src, /'x-frame-options': 'DENY'/);
  assert.match(src, /'content-security-policy': "frame-ancestors 'none'"/);
  assert.match(src, /'x-content-type-options': 'nosniff'/);
  assert.match(src, /'referrer-policy': 'no-referrer'/);
  const writeHeads = src.match(/res\.writeHead\([^)]*\)/g) ?? [];
  assert.ok(writeHeads.length >= 2);
  for (const w of writeHeads) assert.match(w, /\.\.\.SECURITY_HEADERS/, w);
  assert.match(src, /requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000/);
  assert.match(src, /createServer\(LIMITS, handler\)/);
  assert.match(src, /maxConnections = MAX_CONNECTIONS/);
  assert.doesNotMatch(src, /String\(err\)/, 'no error text in an answer');
  assert.doesNotMatch(src, /createServer\(\(q, s\) =>/, 'no listener without the limits');
});

test('public/ has nothing that needs framing', () => {
  const dir = `${ROOT}public`;
  const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(html|js)$/.test(f));
  for (const f of files) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /<iframe|<frame|window\.top|window\.parent|frameElement/, f);
});

// ---- L6: unit hardening and private writes ----

test('portboard.service: NoNewPrivileges and UMask=0077, like the remote unit', () => {
  for (const unit of ['portboard.service', 'portboard-remote.service']) {
    const text = readFileSync(`${ROOT}deploy/${unit}`, 'utf8');
    assert.match(text, /^NoNewPrivileges=yes$/m, unit);
    assert.match(text, /^UMask=0077$/m, unit);
  }
});

test('writePrivate: 0600 file in a 0700 dir, a random temp name with O_EXCL, a loose file becomes 0600', async () => {
  const dir = join(tmp(), 'state');
  const file = join(dir, 'prefs.json');
  const old = process.umask(0o002);
  try {
    await writePrivate(file, '{"a":1}\n');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, 'x', { mode: 0o664 });
    chmodSync(file, 0o664);
    await writePrivate(file, () => '{"a":2}\n');
    assert.equal(readFileSync(file, 'utf8'), '{"a":2}\n');
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the rename replaces a 0664 file with a 0600 one');
    assert.deepEqual(readdirSync(dir), ['prefs.json'], 'no temp file left');
    // The old predictable name (<path>.<pid>.tmp) planted as a symlink is never followed.
    const target = join(dir, 'elsewhere');
    symlinkSync(target, `${file}.${process.pid}.tmp`);
    await writePrivate(file, '{"a":3}\n');
    assert.ok(!existsSync(target));
    await appendPrivate(join(dir, 'log.jsonl'), 'line\n');
    assert.equal(statSync(join(dir, 'log.jsonl')).mode & 0o777, 0o600);
  } finally {
    process.umask(old);
  }
});

test('no state module writes a temp file with a predictable name any more (adoption is handled separately)', () => {
  const dir = `${ROOT}src/core`;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /\$\{[\w.]*path\}\.\$\{process\.pid\}/i, f);
  }
  assert.equal(deniedPathOf('/s/audit.jsonl'), '/s/audit-denied.jsonl');
});
