// The SSH reader every remote port reader shares (src/core/sshread.ts), driven directly with a minimal subclass, a
// fake runner and a fake clock: never a real ssh. pveports.test.ts and winports.test.ts cover the two real readers;
// this file pins the shared contract — the exact ssh argv, every error code, the schedule, the first-wait, the fake
// command used for previews, and that ssh's own words reach the log once and never the status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunResult } from '../src/core/exec.ts';
import {
  classifySsh,
  expandHome,
  HOST,
  INTERVAL,
  nextDelay,
  SshReader,
  sshArgs,
  STALE_AFTER,
  type ReaderOptions,
  type SshReadStatus,
  type SshTarget,
} from '../src/core/sshread.ts';

const res = (stdout: string, stderr = '', ok = true): RunResult => ({ ok, stdout, stderr });

// ---- pure parts ----

test('expandHome: ~ and ~/x only; other paths as given', () => {
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('~/.ssh/k'), join(homedir(), '.ssh/k'));
  assert.equal(expandHome('/etc/k'), '/etc/k');
  assert.equal(expandHome('~other/k'), '~other/k', 'another user\'s home is not expanded');
  assert.equal(expandHome('rel/~/k'), 'rel/~/k');
});

test('HOST: names and addresses; nothing ssh could read as an option or a second word', () => {
  for (const h of ['pve1', 'pve1.example.ts.net', '192.168.1.201', 'fe80::1', '100.64.0.9']) assert.ok(HOST.test(h), h);
  for (const h of ['-oProxyCommand=x', 'a b', 'a;b', '', 'user@host', '.hidden', '[::1]']) assert.ok(!HOST.test(h), h);
});

test('sshArgs: the whole argv, in order — key only, no config, known host key, no agent/X11/tty, destination last', () => {
  const a = sshArgs({ host: 'pve1.example.ts.net', user: 'pbread', key: '~/.ssh/portboard_ro', enabled: true });
  assert.deepEqual(a, [
    '-F', '/dev/null',
    '-i', join(homedir(), '.ssh/portboard_ro'),
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=5',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'LogLevel=ERROR',
    '-T', '-x', '-a',
    '-l', 'pbread',
    'pve1.example.ts.net',
  ]);
});

test('classifySsh: timeout first, then a good-looking answer, then stderr; the exit code decides the rest', () => {
  const fail = (stderr: string) => classifySsh(res('', stderr, false), false, false);
  assert.equal(classifySsh(res('good', '', true), true, true), 'timeout', 'a timeout wins over output that looks fine');
  assert.equal(classifySsh(res('good', 'warning', false), false, true), null, 'looksOk wins over the exit code');
  assert.equal(fail('pbread@192.168.1.201: Permission denied (publickey).'), 'not-installed');
  assert.equal(fail('No ED25519 host key is known for pve1 and you have requested strict checking.'), 'host-key');
  assert.equal(fail('Host key verification failed.'), 'host-key');
  assert.equal(fail('ssh: Could not resolve hostname pve1: Name or service not known'), 'unreachable');
  assert.equal(fail('Connection closed by 192.168.1.201 port 22'), 'unreachable');
  assert.equal(fail('kex_exchange_identification: read: Connection reset by peer'), 'unreachable');
  assert.equal(fail('ssh: connect to host 192.168.1.201 port 22: Network is unreachable'), 'unreachable');
  assert.equal(fail('Warning: Identity file /x/k not accessible: No such file or directory.'), 'no-key');
  assert.equal(fail('something else'), 'failed');
  assert.equal(classifySsh(res('???', '', true), false, false), 'bad-output', 'exit 0 with the wrong output');
});

test('nextDelay: setup errors wait 5 min whatever the count; others double from a minute up to 10', () => {
  for (const e of ['no-key', 'no-user', 'bad-config', 'not-installed'] as const) {
    assert.equal(nextDelay(1, e), 5 * 60_000, e);
    assert.equal(nextDelay(12, e), 5 * 60_000, e);
  }
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map((n) => nextDelay(n, 'host-key') / 60_000), [1, 2, 4, 8, 10, 10, 10]);
  assert.equal(nextDelay(3, null), INTERVAL, 'no error means the normal interval');
  assert.equal(nextDelay(0, 'failed'), INTERVAL, 'no failures means the normal interval');
});

// ---- the reader ----

interface Cfg extends SshTarget {}
interface Data {
  at: number;
  lines: string[];
}

/** The smallest reader: config from a function, lines that start with "ok " are an answer. */
class TestReader extends SshReader<Cfg, Data> {
  private readonly cfg: () => Cfg | string;
  constructor(cfg: () => Cfg | string, opts: ReaderOptions) {
    super(opts, 'PORTBOARD_TEST_SSHREAD_CMD', { enabled: true, ok: false, pending: true, checkedAt: null, lastOk: null, error: null, failures: 0, nextAt: null, setupUrl: 'https://example.com/setup' } as SshReadStatus);
    this.cfg = cfg;
  }
  protected async loadConfig() {
    return this.cfg();
  }
  protected parse(stdout: string, at: number) {
    const lines = stdout.split('\n').filter((l) => l.startsWith('ok '));
    return lines.length ? { at, lines } : null;
  }
  protected looksOk(stdout: string) {
    return /^ok\b/m.test(stdout);
  }
  protected label() {
    return 'test ports (box)';
  }
  protected summary(d: Data) {
    return `${d.lines.length} lines`;
  }
}

async function keyFile() {
  const dir = await mkdtemp(join(tmpdir(), 'pb-sshread-'));
  const key = join(dir, 'k');
  await writeFile(key, 'not a key\n', { mode: 0o600 });
  return key;
}

function harness(cfg: () => Cfg | string, reply: (cmd: string, args: string[]) => RunResult | Promise<RunResult>, opts: Partial<ReaderOptions> = {}) {
  let t = 5_000_000;
  const calls: { cmd: string; args: string[]; timeout: number }[] = [];
  const logs: string[] = [];
  const r = new TestReader(cfg, {
    fakeCmd: null,
    now: () => t,
    log: (l) => logs.push(l),
    runner: async (cmd, args, timeout) => {
      calls.push({ cmd, args, timeout });
      return reply(cmd, args);
    },
    ...opts,
  });
  return { r, calls, logs, now: () => t, advance: (ms: number) => (t += ms) };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('reader: no user yet → no-user, no ssh, the 5-minute wait; the config is re-read every attempt', async () => {
  const key = await keyFile();
  let user: string | null = null;
  const h = harness(() => ({ host: 'box', user, key, enabled: true }), () => res('ok 1'));
  const first = await h.r.get(Infinity);
  assert.equal(first.status.error, 'no-user');
  assert.equal(first.status.pending, false);
  assert.equal(first.status.nextAt, h.now() + 5 * 60_000);
  assert.equal(h.calls.length, 0);
  user = 'pbread';
  h.advance(5 * 60_000);
  await h.r.refresh();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].args.slice(-3), ['-l', 'pbread', 'box']);
  assert.equal(h.calls[0].timeout, 15_000);
  assert.equal(h.r.current().status.ok, true);
});

test('reader: an invalid config is bad-config with its reason only in the log', async () => {
  const h = harness(() => 'host must be a name or an address', () => assert.fail('no ssh'));
  const { status } = await h.r.get(Infinity);
  assert.equal(status.error, 'bad-config');
  assert.equal(status.failures, 1);
  assert.deepEqual(h.logs, ['[portboard] test ports (box): bad-config — host must be a name or an address']);
});

test('reader: a run that lasts the whole timeout is "timeout", not what stderr says', async () => {
  const key = await keyFile();
  const h = harness(() => ({ host: 'box', user: 'u', key, enabled: true }), () => {
    h.advance(15_000);
    return res('', 'timed out after 15000ms', false);
  });
  assert.equal((await h.r.get(Infinity)).status.error, 'timeout');
});

test('reader: output that looks right but parses to nothing is bad-output; a non-zero exit with a good answer is ok', async () => {
  const key = await keyFile();
  let out = res('ok\n', '', true); // looksOk, but parse wants "ok <something>"
  const h = harness(() => ({ host: 'box', user: 'u', key, enabled: true }), () => out);
  assert.equal((await h.r.get(Infinity)).status.error, 'bad-output');
  out = res('ok a\nok b\n', 'one sub-command failed', false);
  h.advance(INTERVAL);
  await h.r.refresh();
  const { status, data } = h.r.current();
  assert.equal(status.ok, true);
  assert.deepEqual(data?.lines, ['ok a', 'ok b']);
});

test('reader: failures count up and back off; ssh\'s stderr goes to the log once per state, never into the status', async () => {
  const key = await keyFile();
  const stderr = 'ssh: connect to host 192.168.1.201 port 22: No route to host';
  let reply = res('', stderr, false);
  const h = harness(() => ({ host: '192.168.1.201', user: 'secretuser', key, enabled: true }), () => reply);
  for (let i = 1; i <= 4; i++) {
    await h.r.refresh();
    const st = h.r.current().status;
    assert.equal(st.failures, i);
    assert.equal(st.nextAt, h.now() + Math.min(10 * 60_000, 60_000 * 2 ** (i - 1)));
    assert.doesNotMatch(JSON.stringify(st), /192\.168|secretuser|No route/);
    h.advance(st.nextAt! - h.now());
  }
  reply = res('ok x');
  await h.r.refresh();
  assert.equal(h.r.current().status.failures, 0);
  assert.deepEqual(h.logs, [`[portboard] test ports (box): unreachable — ${stderr}`, '[portboard] test ports (box): ok, 1 lines']);
});

test('reader: turned off drops the data, clears the error and never runs ssh', async () => {
  const key = await keyFile();
  let enabled = true;
  const h = harness(() => ({ host: 'box', user: 'u', key, enabled }), () => res('ok x'));
  assert.ok((await h.r.get(Infinity)).data);
  enabled = false;
  h.advance(INTERVAL);
  await h.r.refresh();
  const { status, data } = h.r.current();
  assert.equal(data, null);
  assert.deepEqual([status.enabled, status.ok, status.error, status.failures, status.nextAt], [false, false, null, 0, h.now() + INTERVAL]);
  assert.equal(h.calls.length, 1);
});

test('reader: data is shown until STALE_AFTER after it was read, then null with lastOk kept', async () => {
  const key = await keyFile();
  const h = harness(() => ({ host: 'box', user: 'u', key, enabled: true }), () => res('ok x'));
  await h.r.get(Infinity);
  const readAt = h.now();
  h.advance(STALE_AFTER - 1);
  assert.ok(h.r.current().data);
  h.advance(1);
  assert.equal(h.r.current().data, null);
  assert.equal(h.r.current().status.lastOk, readAt);
});

test('reader: get() waits at most firstWaitMs for the first answer, then answers pending; later calls never wait', async () => {
  const key = await keyFile();
  let release!: (r: RunResult) => void;
  const h = harness(() => ({ host: 'box', user: 'u', key, enabled: true }), () => new Promise<RunResult>((r) => (release = r)));
  const first = await h.r.get(20);
  assert.equal(first.status.pending, true);
  assert.equal(first.data, null);
  const second = await h.r.get(20);
  assert.equal(second.status.pending, true);
  assert.equal(h.calls.length, 1, 'the second caller joined the attempt in flight');
  release(res('ok x'));
  await settle();
  const later = await h.r.get(20);
  assert.equal(later.status.pending, false);
  assert.equal(later.status.ok, true);
  assert.equal(h.calls.length, 1, 'not due yet: no new attempt');
});

test('reader: refreshLater runs only when due, or forced at least 20 s after the last check', async () => {
  const key = await keyFile();
  const h = harness(() => ({ host: 'box', user: 'u', key, enabled: true }), () => res('ok x'));
  await h.r.refresh();
  h.r.refreshLater();
  h.advance(19_999);
  h.r.refreshLater(true);
  await settle();
  assert.equal(h.calls.length, 1);
  h.advance(1);
  h.r.refreshLater(true);
  await settle();
  assert.equal(h.calls.length, 2, 'forced');
  h.advance(INTERVAL);
  h.r.refreshLater();
  await settle();
  assert.equal(h.calls.length, 3, 'due');
});

test('reader: a fake command (previews) stands in for ssh — no user or key needed, argv split on whitespace', async () => {
  const h = harness(() => ({ host: 'box', user: null, key: '/nonexistent/k', enabled: true }), () => res('ok fake'), { fakeCmd: '  cat  /tmp/fixture.txt ' });
  const { status, data } = await h.r.get(Infinity);
  assert.equal(status.ok, true);
  assert.deepEqual(h.calls.map((c) => [c.cmd, c.args]), [['cat', ['/tmp/fixture.txt']]]);
  assert.deepEqual(data?.lines, ['ok fake']);
});

test('reader: without fakeCmd in the options the environment variable names the fake command', async () => {
  process.env.PORTBOARD_TEST_SSHREAD_CMD = 'printf ok';
  try {
    const h = harness(() => ({ host: 'box', user: null, key: '/nonexistent/k', enabled: true }), () => res('ok env'), { fakeCmd: undefined });
    await h.r.get(Infinity);
    assert.deepEqual(h.calls.map((c) => [c.cmd, c.args]), [['printf', ['ok']]]);
  } finally {
    delete process.env.PORTBOARD_TEST_SSHREAD_CMD;
  }
});
