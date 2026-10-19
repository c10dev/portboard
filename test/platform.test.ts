// The platform layer (#11): backend selection, the lsof and ps parsers, the service manager's arguments, the
// read-only gate and the launchd plist. No real lsof, ps, systemctl or launchctl runs here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describePlatform, detectPlatform, platform, setPlatform } from '../src/core/platform/index.ts';
import { LSOF_LISTEN_ARGS, parseLsof, readListeners, splitHostPort } from '../src/core/platform/ports.ts';
import { parseLsofCwd, parseLsofStdio, parsePsCommands, psDetails, stdioFiles } from '../src/core/platform/procs.ts';
import { noServiceManager, services, setServiceManager, systemdManager, UNAVAILABLE } from '../src/core/platform/services.ts';
import { bootoutCommands, bootstrapCommands, plistText, xmlString } from '../src/core/platform/launchd.ts';
import { readOnlyRefusal, restartTarget, stopTarget } from '../src/core/control.ts';
import { devServersRefusal } from '../src/features/devservers.ts';
import { listDevServers } from '../src/core/devservers.ts';
import { createRouter } from '../src/features/router.ts';
import type { RunResult } from '../src/core/exec.ts';
import type { ServerContext } from '../src/features/context.ts';
import type { Route } from '../src/features/types.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// ---- selection ----

test('detectPlatform: Linux keeps ss, /proc and systemd; macOS gets lsof and no service manager', () => {
  assert.deepEqual(detectPlatform({}, 'linux'), {
    os: 'linux',
    portReader: 'ss',
    services: 'systemd',
    procfs: true,
    container: false,
    readOnly: false,
    readOnlyReason: null,
    warnings: [],
  });
  const mac = detectPlatform({}, 'darwin');
  assert.equal(mac.portReader, 'lsof');
  assert.equal(mac.services, 'none');
  assert.equal(mac.procfs, false);
  assert.equal(mac.readOnly, false, 'a laptop can still stop its own processes');
  assert.equal(detectPlatform({}, 'freebsd').portReader, 'lsof');
});

test('detectPlatform: env overrides for tests and odd setups; a bad value falls back and is reported', () => {
  assert.equal(detectPlatform({ PORTBOARD_PORT_READER: 'lsof' }, 'linux').portReader, 'lsof');
  assert.equal(detectPlatform({ PORTBOARD_PORT_READER: 'SS' }, 'darwin').portReader, 'ss');
  assert.equal(detectPlatform({ PORTBOARD_SERVICES: 'none' }, 'linux').services, 'none');
  const bad = detectPlatform({ PORTBOARD_PORT_READER: 'netstat', PORTBOARD_READ_ONLY: 'maybe' }, 'linux');
  assert.equal(bad.portReader, 'ss');
  assert.equal(bad.readOnly, false);
  assert.equal(bad.warnings.length, 2);
  assert.match(bad.warnings[0], /PORTBOARD_PORT_READER=netstat/);
  assert.match(describePlatform(bad) ?? '', /netstat/);
});

test('detectPlatform: the container is read-only with no service manager unless told otherwise', () => {
  const c = detectPlatform({ PORTBOARD_CONTAINER: '1' }, 'linux');
  assert.equal(c.container, true);
  assert.equal(c.portReader, 'ss');
  assert.equal(c.procfs, true);
  assert.equal(c.services, 'none');
  assert.equal(c.readOnly, true);
  assert.match(c.readOnlyReason ?? '', /container/);
  assert.equal(detectPlatform({ PORTBOARD_CONTAINER: '1', PORTBOARD_READ_ONLY: '0' }, 'linux').readOnly, false);
  const ro = detectPlatform({ PORTBOARD_READ_ONLY: 'true' }, 'linux');
  assert.equal(ro.readOnly, true);
  assert.equal(ro.readOnlyReason, 'PORTBOARD_READ_ONLY=1');
  assert.equal(ro.services, 'systemd');
});

test('describePlatform: nothing for a plain Linux install, the gaps elsewhere', () => {
  assert.equal(describePlatform(detectPlatform({}, 'linux')), null);
  const line = describePlatform(detectPlatform({}, 'darwin')) ?? '';
  assert.match(line, /ports via lsof/);
  assert.match(line, /no service manager/);
  assert.match(line, /no \/proc/);
});

// ---- lsof ----

test('parseLsof: field output → the listener shape ss gives, merged per address and port', () => {
  const ls = parseLsof(fixture('lsof-listen-macos.txt'));
  const key = (l: { address: string; port: number }) => `${l.address} ${l.port}`;
  assert.deepEqual(ls.map(key), [
    '* 49152',
    '* 7000',
    '* 5000',
    '127.0.0.1 5173',
    '::1 5173',
    '127.0.0.1 5432',
    '::1 5432',
    '100.101.102.103 41641',
    'fd7a:115c:a1e0::1 41641',
    'fe80::1 5353',
  ]);
  const at = (a: string, p: number) => ls.find((l) => l.address === a && l.port === p)!;
  assert.deepEqual(at('*', 7000), { address: '*', port: 7000, scope: 'all', processes: [{ name: 'ControlCenter', pid: 688 }] });
  assert.deepEqual(at('*', 49152).processes, [{ name: 'rapportd', pid: 412 }], 'the IPv4 and IPv6 wildcard of one process: one owner');
  assert.deepEqual(at('127.0.0.1', 5432).processes, [{ name: 'postgres', pid: 91300 }, { name: 'postgres', pid: 91301 }]);
  assert.equal(at('127.0.0.1', 5173).scope, 'loopback');
  assert.equal(at('::1', 5173).scope, 'loopback');
  assert.equal(at('100.101.102.103', 41641).scope, 'tailnet');
  assert.equal(at('fd7a:115c:a1e0::1', 41641).scope, 'tailnet');
  assert.deepEqual(at('100.101.102.103', 41641).processes, [{ name: 'Tailscale Network Extension', pid: 92000 }], 'a command name with spaces (+c 0)');
  assert.ok(!ls.some((l) => l.port === 52000), 'an established socket (a->b) is never a listener');
});

test('parseLsof: empty, garbage and CRLF input', () => {
  assert.deepEqual(parseLsof(''), []);
  assert.deepEqual(parseLsof('lsof: WARNING: something\n'), []);
  assert.deepEqual(parseLsof('p1\r\ncx\r\nn*:80\r\n'), [{ address: '*', port: 80, scope: 'all', processes: [{ name: 'x', pid: 1 }] }]);
  assert.deepEqual(parseLsof('n127.0.0.1:9\n')[0].processes, [], 'a socket before any p line has no owner');
});

test('splitHostPort: IPv4, bracketed IPv6, zones, wildcards', () => {
  assert.deepEqual(splitHostPort('127.0.0.1:8080'), { address: '127.0.0.1', port: 8080 });
  assert.deepEqual(splitHostPort('[::1]:3000'), { address: '::1', port: 3000 });
  assert.deepEqual(splitHostPort('[fe80::1%lo0]:5353'), { address: 'fe80::1', port: 5353 });
  assert.deepEqual(splitHostPort('*:22'), { address: '*', port: 22 });
  assert.equal(splitHostPort('nocolon'), null);
  assert.equal(splitHostPort('*:'), null);
  assert.equal(splitHostPort('*:http'), null);
});

test('readListeners: ss keeps the exact arguments it always had; lsof runs the field-output command', async () => {
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'ss') return { ok: true, stdout: 'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=7,fd=21))\n', stderr: '' };
    return { ok: false, stdout: fixture('lsof-listen-macos.txt'), stderr: 'exit 1' };
  };
  const ss = await readListeners(true, 'ss', exec);
  assert.deepEqual(ss, [{ address: '127.0.0.1', port: 5173, scope: 'loopback', processes: [{ name: 'node', pid: 7 }] }]);
  await readListeners(false, 'ss', exec);
  const lsof = await readListeners(false, 'lsof', exec);
  assert.equal(lsof.length, 10, 'lsof output counts even when it exits non-zero');
  assert.deepEqual(calls, ['ss -ltnpH', 'ss -ltnH', `lsof ${LSOF_LISTEN_ARGS.join(' ')}`]);
  assert.deepEqual(LSOF_LISTEN_ARGS, ['-nP', '+c', '0', '-iTCP', '-sTCP:LISTEN', '-F', 'pcnL']);
});

// ---- ps / lsof process details ----

test('parsePsCommands and parseLsofCwd: one batch for every pid', async () => {
  assert.deepEqual(
    [...parsePsCommands('  91234 node /Users/me/projects/app/node_modules/.bin/vite --port 5173\n  412 /usr/libexec/rapportd\n\n').entries()],
    [
      [91234, 'node /Users/me/projects/app/node_modules/.bin/vite --port 5173'],
      [412, '/usr/libexec/rapportd'],
    ],
  );
  assert.deepEqual([...parseLsofCwd('p91234\nfcwd\nn/Users/me/projects/app\np412\nfcwd\nn/\n').entries()], [
    [91234, '/Users/me/projects/app'],
    [412, '/'],
  ]);
  const calls: string[][] = [];
  const exec = async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    return cmd === 'ps' ? { ok: true, stdout: '7 node server.js\n', stderr: '' } : { ok: true, stdout: 'p7\nn/srv/app\n', stderr: '' };
  };
  const d = await psDetails([7, 8], exec);
  assert.equal(d.cmdlines.get(7), 'node server.js');
  assert.equal(d.cwds.get(7), '/srv/app');
  assert.equal(d.cmdlines.has(8), false, 'gone: left out');
  assert.deepEqual(calls, [
    ['ps', '-o', 'pid=,command=', '-p', '7,8'],
    ['lsof', '-a', '-p', '7,8', '-d', 'cwd', '-F', 'pn'],
  ]);
  assert.deepEqual(await psDetails([], exec), { cmdlines: new Map(), cwds: new Map() });
  assert.equal(calls.length, 2, 'no pids: nothing runs');
});

test('parseLsofStdio: regular files on descriptors 1 and 2 only, stdout first', async () => {
  const text = ['p7', 'f2', 'tREG', 'n/tmp/app.err', 'f1', 'tREG', 'n/tmp/app.log', 'f0', 'tCHR', 'n/dev/ttys001'].join('\n');
  assert.deepEqual(parseLsofStdio(text), ['/tmp/app.log', '/tmp/app.err']);
  assert.deepEqual(parseLsofStdio('p7\nf1\ntCHR\nn/dev/ttys001\nf2\ntPIPE\nn->0x1234\n'), [], 'a terminal or a pipe: nothing to tail');
  const calls: string[][] = [];
  await stdioFiles(7, async (cmd, args) => (calls.push([cmd, ...args]), { ok: true, stdout: text, stderr: '' }));
  assert.deepEqual(calls, [['lsof', '-a', '-p', '7', '-d', '1,2', '-F', 'ftn']]);
});

// ---- service manager ----

test('systemdManager: the systemctl, journalctl and systemd-run arguments the server always used', async () => {
  const calls: unknown[][] = [];
  const sm = systemdManager(async (cmd, args, timeoutMs) => (calls.push([cmd, args.join(' '), timeoutMs]), { ok: true, stdout: '', stderr: '' }));
  await sm.restart('a.service');
  await sm.stop('a.service');
  await sm.stop('pb-dev-x.service', true);
  assert.equal((await sm.logs('a.service', '50')).source, 'journalctl --user -u a.service');
  await sm.show(['a.service', 'b.service'], 'Id,Description');
  await sm.show(['a.service'], 'Id,FragmentPath', 5_000);
  await sm.list('pb-dev-*');
  await sm.startTransient(['--user', '--unit=pb-dev-x.service']);
  assert.deepEqual(calls, [
    ['systemctl', '--user --no-block restart a.service', undefined],
    ['systemctl', '--user --no-block stop a.service', undefined],
    ['systemctl', '--user stop pb-dev-x.service', 20_000],
    ['journalctl', '--user -u a.service -n 50 --no-pager -o short-iso', undefined],
    ['systemctl', '--user show -p Id,Description a.service b.service', undefined],
    ['systemctl', '--user show -p Id,FragmentPath a.service', 5_000],
    ['systemctl', '--user list-units pb-dev-* --all --no-legend --plain', 5_000],
    ['systemd-run', '--user --unit=pb-dev-x.service', 15_000],
  ]);
});

test('no service manager: units answer with a reason, dev servers are refused with 501, nothing is spawned', async () => {
  const none = noServiceManager();
  assert.equal(none.unavailable, UNAVAILABLE);
  assert.deepEqual(await none.restart('a.service'), { ok: false, stdout: '', stderr: UNAVAILABLE });
  setPlatform(detectPlatform({}, 'darwin'));
  setServiceManager(none);
  try {
    assert.equal(services(), none);
    const r = await restartTarget({ type: 'systemd', unit: 'a.service' });
    assert.equal(r.ok, false);
    assert.match(r.message, /a\.service: systemd user units are not available/);
    assert.equal((await stopTarget({ type: 'systemd', unit: 'a.service' })).ok, false);
    assert.match((await restartTarget({ type: 'process', pids: [1] })).message, /not a systemd service or docker container/);
    assert.deepEqual(await listDevServers(), []);
    const refused = devServersRefusal();
    assert.equal(refused?.status, 501);
    assert.match(refused?.message ?? '', /darwin/);
  } finally {
    setPlatform(null);
    setServiceManager(null);
  }
});

// ---- read-only ----

const request = (method: string, headers: Record<string, string> = {}) => ({ method, headers }) as any;
const untouchable = new Proxy({}, { get: (_t, k) => assert.fail(`handler touched ctx.${String(k)}`) }) as ServerContext;

test('read-only: every write route answers 403 before its handler (and is audited as denied); reads still work', async () => {
  const ran: string[] = [];
  const routes: Route[] = [
    { method: 'GET', path: '/api/list', handler: async () => (ran.push('list'), { status: 200, body: 'list' }) },
    { method: 'POST', path: '/api/ports/:port/stop', write: true, handler: async () => (ran.push('stop'), { status: 200, body: 'stopped' }) },
  ];
  const audited: { result: string; status: number }[] = [];
  let readOnly: string | null = 'This Portboard is read-only: container';
  const route = createRouter(routes, {
    caller: async () => ({ source: 'loopback', login: null, owner: true, canWrite: true, addr: '127.0.0.1', device: null }) as any,
    record: async (e) => void audited.push({ result: e.result, status: e.status }),
    readOnly: () => readOnly,
  });
  const at = (method: string, path: string) => route(request(method, { 'x-portboard': '1' }), new URL(`http://x${path}`), untouchable);
  assert.deepEqual(await at('POST', '/api/ports/80/stop'), { status: 403, body: { error: 'read-only', reason: 'This Portboard is read-only: container' } });
  assert.deepEqual(await at('GET', '/api/list'), { status: 200, body: 'list' });
  assert.deepEqual(audited, [{ result: 'denied', status: 403 }]);
  readOnly = null;
  assert.deepEqual(await at('POST', '/api/ports/80/stop'), { status: 200, body: 'stopped' });
  assert.deepEqual(ran, ['list', 'stop']);
});

test('read-only: stop, restart and dev servers refuse in the core too (MCP tools and auto-stop never reach the router)', async () => {
  setPlatform(detectPlatform({ PORTBOARD_CONTAINER: '1' }, 'linux'));
  try {
    assert.equal(platform().readOnly, true);
    assert.equal(readOnlyRefusal()?.ok, false);
    const pid = process.pid + 1_000_000; // never signalled: refused first
    assert.equal((await stopTarget({ type: 'process', pids: [pid] })).ok, false);
    assert.equal((await restartTarget({ type: 'docker', container: 'db' })).ok, false);
    assert.equal(devServersRefusal()?.status, 403);
  } finally {
    setPlatform(null);
  }
  assert.equal(readOnlyRefusal(), null, 'a plain install writes');
});

// ---- launchd ----

test('plistText: a launchd agent that runs this node and this install, escaped, logging to ~/Library/Logs', () => {
  const o = { node: '/opt/homebrew/bin/node', root: '/Users/me/My Apps & Tools/portboard', version: '1.2.3', home: '/Users/me' };
  const text = plistText('dashboard', o);
  assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'));
  assert.match(text, /<!-- Written by `portboard install-service` \(portboard 1\.2\.3\)/);
  assert.ok(text.includes('<string>io.github.c10dev.portboard</string>'));
  assert.ok(text.includes('<string>/Users/me/My Apps &amp; Tools/portboard/bin/portboard</string>'));
  assert.ok(text.includes('<string>--max-semi-space-size=16</string>'));
  assert.ok(text.includes('<string>/Users/me/Library/Logs/portboard/io.github.c10dev.portboard.log</string>'));
  assert.match(text, /\/usr\/sbin/, 'lsof is in /usr/sbin on macOS');
  assert.ok(!text.includes('PORTBOARD_REMOTE_PORT'));
  assert.ok(plistText('remote', o).includes('<key>PORTBOARD_REMOTE_PORT</key>'));
  assert.ok(plistText('agent', o).includes('<string>agent</string>'));
  // comments may not hold "--"
  for (const c of text.match(/<!--[\s\S]*?-->/g) ?? []) assert.ok(!c.slice(4, -3).includes('--'), c);
  assert.equal(xmlString('<a>'), '<string>&lt;a&gt;</string>');
  assert.throws(() => xmlString('a\0b'), /NUL/);
});

test('launchctl commands: bootstrap into gui/<uid>, bootout by label', () => {
  assert.deepEqual(bootstrapCommands(['dashboard', 'remote'], 501, '/Users/me'), [
    ['launchctl', 'bootstrap', 'gui/501', '/Users/me/Library/LaunchAgents/io.github.c10dev.portboard.plist'],
    ['launchctl', 'bootstrap', 'gui/501', '/Users/me/Library/LaunchAgents/io.github.c10dev.portboard-remote.plist'],
  ]);
  assert.deepEqual(bootoutCommands(['agent'], 501), [['launchctl', 'bootout', 'gui/501/io.github.c10dev.portboard-agent']]);
});
