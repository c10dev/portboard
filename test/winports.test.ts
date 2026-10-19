import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachWinPorts, mergeDevices, parsePeers, type Devices } from '../src/core/devices.ts';
import type { RunResult } from '../src/core/exec.ts';
import type { PoolHost } from '../src/core/pool.ts';
import { checkWinConfig, parseWinPorts, WIN_DEFAULTS, WIN_SETUP_URL, WinPortsCollector, type WinPortsStatus } from '../src/core/winports.ts';
import { redactDevices } from '../src/remote/redact.ts';
import { SITE } from '../src/core/site.ts';

const WIN = readFileSync(new URL('./fixtures/winports-desktop-pc.txt', import.meta.url), 'utf8');

// ---- parsing ----

test('parseWinPorts: BOM, CRLF, IPv4/IPv6, empty process names, .exe and duplicates', () => {
  const r = parseWinPorts(WIN, 9)!;
  assert.equal(r.at, 9);
  assert.equal(r.sockets.length, 23);
  assert.deepEqual(r.sockets[0], { port: 135, address: '0.0.0.0', process: 'svchost' });
  assert.deepEqual(r.sockets.find((s) => s.port === 9100), { port: 9100, address: '127.0.0.1' }); // access denied
  assert.ok(r.sockets.some((s) => s.address === '::1' && s.port === 5190));
  assert.ok(r.sockets.some((s) => s.address === 'fd7a:115c:a1e0::e901:e71c'));
  assert.ok(!JSON.stringify(r).includes('pid'), 'pids are not kept');

  const odd = parseWinPorts('0.0.0.0\t80\t4\tSystem.exe\n[::]\t443\t4\tSystem\r\nfe80::1%12\t5000\t7\tfoo\r\n0.0.0.0\t80\t4\tSystem\r\n0.0.0.0\t99999\t1\tx\r\nnot a line\r\n', 1)!;
  assert.deepEqual(odd.sockets, [
    { port: 80, address: '0.0.0.0', process: 'System' },
    { port: 443, address: '::', process: 'System' },
    { port: 5000, address: 'fe80::1', process: 'foo' },
  ]);
  assert.equal(parseWinPorts(''), null);
  assert.equal(parseWinPorts('#< CLIXML\r\n<Objs Version="1.1.0.1"/>\r\n'), null);
  assert.equal(parseWinPorts('0.0.0.0\t22\t4420\r\n', 1)?.sockets[0].process, undefined); // no 4th column
});

test('checkWinConfig: the site’s user by default; Windows names with spaces or Korean are fine; options and %-tokens are not', () => {
  assert.deepEqual(checkWinConfig(undefined), WIN_DEFAULTS);
  assert.equal(WIN_DEFAULTS.user, SITE.windows.user);
  assert.equal((checkWinConfig({ user: null }) as any).user, null);
  assert.equal((checkWinConfig({ user: 'dev' }) as any).user, 'dev');
  assert.equal((checkWinConfig({ user: '홍길동' }) as any).user, '홍길동');
  assert.equal((checkWinConfig({ user: 'Jane Doe' }) as any).user, 'Jane Doe');
  assert.equal((checkWinConfig({ user: '' }) as any).user, null);
  for (const bad of ['-oProxyCommand=x', '%u', 'a\nb', ' lead', 'trail ', 42]) assert.match(checkWinConfig({ user: bad }) as string, /user/, String(bad));
  assert.match(checkWinConfig({ host: '-x' }) as string, /host/);
});

// ---- collector ----

const res = (stdout: string, stderr = '', ok = true): RunResult => ({ ok, stdout, stderr });

async function config(obj: object) {
  const dir = await mkdtemp(join(tmpdir(), 'winports-'));
  const key = join(dir, 'portboard_ro');
  await writeFile(key, 'x\n', { mode: 0o600 });
  const path = join(dir, 'winports.json');
  // the reader's target spelled out: the defaults leave it off until a site names a host
  await writeFile(path, JSON.stringify({ host: '192.168.1.7', device: 'desktop-pc', enabled: true, key, ...obj }));
  return path;
}

function harness(configPath: string, replies: RunResult[]) {
  let t = 5_000_000;
  const calls: string[][] = [];
  const c = new WinPortsCollector({
    configPath, fakeCmd: null, now: () => t, log: () => {},
    runner: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return replies.shift() ?? res('', 'Permission denied', false);
    },
  });
  return { c, calls, advance: (ms: number) => (t += ms) };
}

test('collector: no user → setup hint state and no ssh at all; with a user it connects with only the dedicated key', async () => {
  const h = harness(await config({ user: null }), []);
  const st = (await h.c.get(Infinity)).status;
  assert.equal(st.error, 'no-user');
  assert.equal(st.setupUrl, WIN_SETUP_URL);
  assert.equal(st.device, 'desktop-pc');
  assert.equal(st.nextAt! - st.checkedAt!, 300_000);
  assert.equal(h.calls.length, 0);

  const ok = harness(await config({ user: 'dev' }), [res(WIN)]);
  const r = await ok.c.get(Infinity);
  assert.equal(r.status.ok, true);
  assert.equal(r.data?.sockets.length, 23);
  const argv = ok.calls[0];
  assert.equal(argv[0], 'ssh');
  assert.deepEqual(argv.slice(-3), ['-l', 'dev', '192.168.1.7']);
  for (const o of ['BatchMode=yes', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=yes']) assert.ok(argv.includes(o), o);

  // Windows OpenSSH's refusal reads the same as Linux's
  const denied = harness(await config({ user: 'dev' }), [res('', 'dev@192.168.1.7: Permission denied (publickey,keyboard-interactive).', false)]);
  assert.equal((await denied.c.get(Infinity)).status.error, 'not-installed');
  // PowerShell failing inside the forced command: exit 1, an error on stderr, nothing tab-separated
  const ps = harness(await config({ user: 'dev' }), [res('', 'ports.ps1 : File C:\\ProgramData\\portboard\\ports.ps1 cannot be loaded', false)]);
  assert.equal((await ps.c.get(Infinity)).status.error, 'failed');
});

// ---- merging with the WSL side ----

const STATUS = JSON.stringify({
  Self: { HostName: 'devbox', DNSName: 'devbox.t.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.1'] },
  Peer: { d: { HostName: 'desktop-pc', DNSName: 'desktop-pc.t.ts.net.', OS: 'windows', TailscaleIPs: ['100.64.10.2', 'fd7a:115c:a1e0::e901:e71c'], Online: true } },
});

const wslListening = [
  { port: 53, address: '127.0.0.53' },
  { port: 2222, address: '0.0.0.0', process: 'sshd' },
  { port: 3000, address: '100.64.10.2', process: 'node' },
  { port: 5190, address: '127.0.0.1', process: 'node' },
];

function desktop(listening: typeof wslListening | null = wslListening) {
  const pool: PoolHost = {
    name: 'desktop', kind: 'ssh', addresses: ['192.168.1.7'], state: 'ok', inRotation: true, slots: 3, busy: 0,
    ...(listening ? { listening, listeningAt: 100 } : {}),
  };
  return mergeDevices(parsePeers(STATUS), [pool], { desktop: 'desktop-pc' });
}

test('attachWinPorts: Windows and WSL on one list; wslrelay and unnamed sockets on WSL ports fold into the WSL row', () => {
  const list = desktop();
  const folded = attachWinPorts(list, parseWinPorts(WIN, 200)!, 'desktop-pc');
  const d = list.find((x) => x.id === 'desktop-pc')!;
  assert.equal(d.portsSource, 'compute-pool');
  assert.deepEqual(d.ports!.sides, { windows: 200, wsl: 100 });
  assert.equal(d.ports!.at, 100);
  assert.equal(folded, 3); // wslrelay 5190 on 127.0.0.1 and ::1, the unnamed 2222 (mirrored)
  const rows = d.ports!.ports.map((p) => `${p.side}:${p.port}`);
  assert.deepEqual(rows.filter((r) => r.endsWith(':5190')), ['wsl:5190']);
  assert.deepEqual(rows.filter((r) => r.endsWith(':2222')), ['wsl:2222']);
  // a named Windows program on a port WSL also uses is a different socket: both stay
  assert.deepEqual(rows.filter((r) => r.endsWith(':3000')), ['windows:3000', 'wsl:3000']);
  const by = (side: string, port: number) => d.ports!.ports.find((p) => p.side === side && p.port === port)!;
  assert.equal(by('windows', 3000).url, 'http://desktop-pc.t.ts.net:3000');
  assert.equal(by('windows', 9100).scope, 'loopback'); // "그 기기 안에서만"
  assert.deepEqual(by('windows', 9100).processes, []);
  assert.equal(by('windows', 139).scope, 'other'); // LAN address only
  assert.equal(by('windows', 57423).scope, 'tailnet');
  assert.equal(by('windows', 57423).url, null); // tailscaled
  assert.equal(by('windows', 135).url, null); // RPC
  assert.equal(by('windows', 49664).url, null); // lsass
  assert.equal(by('windows', 5357).url, 'http://desktop-pc.t.ts.net:5357'); // http.sys (System) may serve pages
  assert.equal(by('wsl', 5190).scope, 'loopback');
  // sorted by port, Windows before WSL on the same port
  const ports = d.ports!.ports.map((p) => p.port);
  assert.deepEqual(ports, [...ports].sort((a, b) => a - b));
});

test('attachWinPorts: WSL down → Windows only; no Windows data → the WSL list untouched; unknown device → nothing', () => {
  const noWsl = desktop(null);
  attachWinPorts(noWsl, parseWinPorts(WIN, 200)!, 'desktop-pc');
  const d = noWsl.find((x) => x.id === 'desktop-pc')!;
  assert.equal(d.portsSource, 'windows-ssh'); // compute-pool reported no ports, so the list is Windows' alone
  assert.deepEqual(d.ports!.sides, { windows: 200, wsl: null });
  assert.ok(d.ports!.ports.every((p) => p.side === 'windows'));
  assert.ok(d.ports!.ports.some((p) => p.port === 5190), 'nothing to fold into: the relay socket is listed');

  const plain = desktop();
  const before = JSON.stringify(plain);
  assert.equal(attachWinPorts(plain, null, 'desktop-pc'), 0);
  assert.equal(JSON.stringify(plain), before);
  assert.equal(attachWinPorts(plain, parseWinPorts(WIN, 1)!, 'nope'), 0);
  assert.equal(JSON.stringify(plain), before);

  // a device with no compute-pool host at all
  const solo = mergeDevices(parsePeers(STATUS), [], {});
  attachWinPorts(solo, parseWinPorts(WIN, 1)!, 'desktop-pc');
  assert.equal(solo.find((x) => x.id === 'desktop-pc')!.portsSource, 'windows-ssh');
});

// ---- remote redaction ----

test('remote list_devices: side and reach stay; addresses, process names, user and key stay out; status is a code', () => {
  const list = desktop();
  attachWinPorts(list, parseWinPorts(WIN, 200)!, 'desktop-pc');
  const st: WinPortsStatus = { enabled: true, device: 'desktop-pc', ok: false, pending: false, checkedAt: 1, lastOk: null, error: 'no-user', failures: 1, nextAt: 2, setupUrl: WIN_SETUP_URL };
  const doc = {
    at: 'x', pool: { available: true, source: 'hosts', url: '', healthAt: null }, devices: list,
    proxmox: { configured: false, ok: false, hosts: [] }, winPorts: st,
  } as unknown as Devices;
  const out = redactDevices(doc) as any;
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /192\.168|100\.118|fd7a:|portboard_ro|wslrelay|svchost|AppleMobile|"addresses"|"processes"/);
  const d = out.devices.find((x: any) => x.name === 'desktop-pc');
  assert.deepEqual(d.ports.sides, { windows: 200, wsl: 100 });
  assert.deepEqual(d.ports.ports.find((p: any) => p.side === 'windows' && p.port === 3000), { port: 3000, scope: 'all', tailnet: true, lan: false, side: 'windows', url: 'http://desktop-pc.t.ts.net:3000' });
  assert.deepEqual(out.winPorts, { enabled: true, device: 'desktop-pc', ok: false, pending: false, error: 'no-user', checkedAt: 1, lastOk: null });
  const loose = redactDevices(doc, { showAddresses: true, showProcesses: true }) as any;
  assert.ok(JSON.stringify(loose).includes('svchost'));
});

test('live output from desktop-pc (2026-10-17, pids blanked): parses whole, merges with WSL, no relay sockets in mirrored mode', () => {
  const live = readFileSync(new URL('./fixtures/winports-live-2026-10-17.txt', import.meta.url), 'utf8');
  const r = parseWinPorts(live, 300)!;
  assert.equal(r.sockets.length, 35);
  assert.ok(r.sockets.every((s) => s.process), 'every owner was named');
  const list = desktop();
  assert.equal(attachWinPorts(list, r, 'desktop-pc'), 0); // mirrored networking: WSL's ports don't show up on the Windows side
  const d = list.find((x) => x.id === 'desktop-pc')!;
  const win = d.ports!.ports.filter((p) => p.side === 'windows');
  const by = (port: number) => win.find((p) => p.port === port)!;
  assert.equal(by(22).scope, 'all');
  assert.equal(by(22).url, null);
  assert.equal(by(6463).scope, 'loopback'); // Discord RPC
  assert.equal(by(42050).scope, 'loopback'); // ::1 only
  assert.equal(by(62612).scope, 'tailnet');
  assert.equal(by(139).scope, 'other');
  assert.equal(by(24800).scope, 'all');
  assert.equal(by(24800).url, null); // deskflow/synergy, not a page
  assert.ok(d.ports!.ports.some((p) => p.side === 'wsl' && p.port === 2222));
});
