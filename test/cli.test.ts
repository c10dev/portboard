import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableCommands, main, parseArgs, systemdArg, UNIT_MARKER, unitDir, unitsFor, unitText, type Deps } from '../src/cli.ts';
import { VERSION } from '../src/version.ts';

const INPUT = { node: '/home/me/.nvm/versions/node/v24.19.0/bin/node', root: '/home/me/.nvm/versions/node/v24.19.0/lib/node_modules/portboard', version: '1.2.3' };

// ---- arguments ----

test('parseArgs: commands, help and version', () => {
  assert.equal(parseArgs([]).cmd, 'help');
  for (const a of ['--help', '-h', 'help']) assert.equal(parseArgs([a]).cmd, 'help');
  for (const a of ['--version', '-v', 'version']) assert.equal(parseArgs([a]).cmd, 'version');
  assert.equal(parseArgs(['start']).cmd, 'start');
  assert.equal(parseArgs(['mcp']).cmd, 'mcp');
  // the remote server's own subcommands pass through untouched
  assert.deepEqual(parseArgs(['remote', 'revoke', 'c-1']).rest, ['revoke', 'c-1']);
});

test('parseArgs: install-service flags, unknown ones refused', () => {
  assert.deepEqual(parseArgs(['install-service']), { cmd: 'install-service', rest: [], remote: false, agent: false, enable: false, dryRun: false });
  assert.deepEqual(parseArgs(['install-service', '--remote', '--dry-run', '--enable']), { cmd: 'install-service', rest: [], remote: true, agent: false, enable: true, dryRun: true });
  assert.equal(parseArgs(['uninstall-service', '--dry-run']).dryRun, true);
  assert.throws(() => parseArgs(['install-service', '--force']), /unknown option "--force"/);
  assert.throws(() => parseArgs(['uninstall-service', '--remote']), /unknown option/);
  assert.throws(() => parseArgs(['serve']), /unknown command "serve"/);
});

// ---- unit text ----

test('unitText dashboard: this node, this install, the hardening of deploy/portboard.service', () => {
  const u = unitText('dashboard', INPUT);
  assert.ok(u.startsWith(`${UNIT_MARKER} (portboard 1.2.3)`));
  const lines = u.split('\n');
  assert.ok(lines.includes(`WorkingDirectory=${INPUT.root}`));
  assert.ok(lines.includes(`ExecStart=${INPUT.node} --max-semi-space-size=16 ${INPUT.root}/bin/portboard start`));
  assert.ok(lines.includes('Environment=PATH=/home/me/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin'));
  for (const l of ['NoNewPrivileges=yes', 'UMask=0077', 'Restart=always', 'RestartSec=10', 'WantedBy=default.target']) assert.ok(lines.includes(l), l);
  assert.ok(!u.includes('PORTBOARD_REMOTE_PORT'));
  // nothing hard-coded from the owner's machine (#9)
  assert.ok(!u.includes('%h') && !u.includes('projects/portboard'));
});

test('unitText remote: remote subcommand on :8794, same hardening', () => {
  const lines = unitText('remote', INPUT).split('\n');
  assert.ok(lines.includes(`ExecStart=${INPUT.node} ${INPUT.root}/bin/portboard remote`));
  assert.ok(lines.includes('Environment=PORTBOARD_REMOTE_PORT=8794'));
  for (const l of ['NoNewPrivileges=yes', 'UMask=0077', 'Restart=always']) assert.ok(lines.includes(l), l);
});

test('portboard agent and install-service --agent (#10): the agent unit alone, on :8797', () => {
  assert.equal(parseArgs(['agent']).cmd, 'agent');
  assert.equal(parseArgs(['install-service', '--agent']).agent, true);
  assert.throws(() => parseArgs(['install-service', '--agent', '--remote']), /don't go together/);
  assert.deepEqual(unitsFor(false, true), ['agent']);
  assert.deepEqual(unitsFor(true), ['dashboard', 'remote']);
  const lines = unitText('agent', INPUT).split('\n');
  assert.ok(lines.includes(`ExecStart=${INPUT.node} ${INPUT.root}/bin/portboard agent`));
  assert.ok(lines.some((l) => l.startsWith('Description=Portboard agent') && l.includes(':8797')));
  assert.ok(!lines.some((l) => l.includes('PORTBOARD_REMOTE_PORT')));
  for (const l of ['NoNewPrivileges=yes', 'UMask=0077', 'Restart=always']) assert.ok(lines.includes(l), l);
});

test('unitText: the hardening lines match deploy/portboard.service', () => {
  const ref = readFileSync(new URL('../deploy/portboard.service', import.meta.url), 'utf8').split('\n');
  const unit = unitText('dashboard', INPUT).split('\n');
  for (const l of ref.filter((x) => /^(NoNewPrivileges|UMask|Restart|RestartSec|WantedBy)=/.test(x))) assert.ok(unit.includes(l), l);
});

test('unitText: a system node on /usr/bin is not listed twice in PATH', () => {
  assert.ok(unitText('dashboard', { ...INPUT, node: '/usr/bin/node' }).includes('Environment=PATH=/usr/bin:/usr/local/bin:/bin\n'));
});

test('systemdArg: specifiers, variables, spaces and quotes escaped', () => {
  assert.equal(systemdArg('/usr/bin/node'), '/usr/bin/node');
  assert.equal(systemdArg('/opt/50%/x'), '/opt/50%%/x');
  assert.equal(systemdArg('/opt/$HOME/x'), '/opt/$$HOME/x');
  assert.equal(systemdArg('/opt/my apps/x'), '"/opt/my apps/x"');
  assert.equal(systemdArg('/opt/a "b"/x'), '"/opt/a \\"b\\"/x"');
  assert.throws(() => systemdArg('/opt/a\nb'), /newline/);
  const u = unitText('dashboard', { ...INPUT, root: '/opt/my apps/pb' });
  assert.ok(u.includes('WorkingDirectory=/opt/my apps/pb\n'));
  assert.ok(u.includes(`ExecStart=${INPUT.node} --max-semi-space-size=16 "/opt/my apps/pb/bin/portboard" start\n`));
});

test('unitDir and enableCommands', () => {
  assert.equal(unitDir('/home/me'), '/home/me/.config/systemd/user');
  assert.equal(unitDir('/home/me', { XDG_CONFIG_HOME: '/x' }), '/x/systemd/user');
  assert.deepEqual(enableCommands(['dashboard', 'remote']), [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'portboard', 'portboard-remote'],
  ]);
});

// ---- main, with a temporary home and a fake systemctl ----

function harness(over: Partial<Deps> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pb-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const deps: Partial<Deps> = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    node: INPUT.node,
    root: INPUT.root,
    home,
    env: {},
    platform: 'linux',
    systemctl: async (args) => (calls.push(args), true),
    ...over,
  };
  const dir = join(home, '.config', 'systemd', 'user');
  return { home, dir, out, err, calls, deps, done: () => rmSync(home, { recursive: true, force: true }) };
}

test('main: --version, --help, unknown command', async () => {
  const h = harness();
  assert.equal(await main(['--version'], h.deps), 0);
  assert.deepEqual(h.out, [VERSION]);
  assert.equal(await main(['--help'], h.deps), 0);
  assert.match(h.out[1], /install-service/);
  assert.equal(await main(['nope'], h.deps), 2);
  assert.match(h.err[0], /unknown command/);
  h.done();
});

test('main install-service --dry-run writes nothing and runs nothing', async () => {
  const h = harness();
  assert.equal(await main(['install-service', '--remote', '--dry-run'], h.deps), 0);
  assert.ok(!existsSync(h.dir));
  assert.deepEqual(h.calls, []);
  const text = h.out.join('\n');
  assert.ok(text.includes(`# ${join(h.dir, 'portboard.service')}`));
  assert.ok(text.includes(`# ${join(h.dir, 'portboard-remote.service')}`));
  assert.ok(text.includes('systemctl --user daemon-reload && systemctl --user enable --now portboard portboard-remote'));
  h.done();
});

test('main install-service writes the unit, prints systemctl, runs it only with --enable', async () => {
  const h = harness();
  assert.equal(await main(['install-service'], h.deps), 0);
  const file = join(h.dir, 'portboard.service');
  assert.equal(readFileSync(file, 'utf8'), unitText('dashboard', { ...INPUT, version: VERSION }));
  assert.ok(!existsSync(join(h.dir, 'portboard-remote.service')));
  assert.deepEqual(h.calls, []);
  assert.ok(h.out.some((l) => l.includes('systemctl --user daemon-reload && systemctl --user enable --now portboard')));
  assert.equal(await main(['install-service', '--enable'], h.deps), 0);
  assert.ok(h.out.includes(`unchanged ${file}`));
  assert.deepEqual(h.calls, [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'portboard']]);
  h.done();
});

test('main install-service: not on macOS; warns for an npx cache copy', async () => {
  const mac = harness({ platform: 'darwin' });
  assert.equal(await main(['install-service'], mac.deps), 1);
  assert.match(mac.err[0], /Linux only/);
  mac.done();
  const npx = harness({ root: '/home/me/.npm/_npx/abc/node_modules/portboard' });
  assert.equal(await main(['install-service', '--dry-run'], npx.deps), 0);
  assert.match(npx.err[0], /npx cache/);
  npx.done();
});

test('main uninstall-service: disables, then removes only the units it wrote', async () => {
  const h = harness();
  await main(['install-service', '--remote'], h.deps);
  h.calls.length = 0;
  assert.equal(await main(['uninstall-service', '--dry-run'], h.deps), 0);
  assert.deepEqual(h.calls, []);
  assert.ok(existsSync(join(h.dir, 'portboard.service')));
  assert.equal(await main(['uninstall-service'], h.deps), 0);
  assert.deepEqual(h.calls, [['--user', 'disable', '--now', 'portboard', 'portboard-remote'], ['--user', 'daemon-reload']]);
  assert.ok(!existsSync(join(h.dir, 'portboard.service')) && !existsSync(join(h.dir, 'portboard-remote.service')));
  h.done();

  // a hand-copied unit (deploy/portboard.service) is left alone
  const hand = harness();
  mkdirSync(hand.dir, { recursive: true });
  writeFileSync(join(hand.dir, 'portboard.service'), '[Unit]\nDescription=by hand\n');
  assert.equal(await main(['uninstall-service'], hand.deps), 1);
  assert.ok(existsSync(join(hand.dir, 'portboard.service')));
  assert.match(hand.err[0], /not written by install-service/);
  assert.deepEqual(hand.calls, []);
  hand.done();
});

// ---- the npm package ----

test('package.json: publishable, bin/portboard is plain JavaScript with a shebang', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.bin, { portboard: 'bin/portboard' });
  assert.equal(pkg.publishConfig.access, 'public');
  assert.equal(pkg.scripts.prepack, 'npm run build');
  // Node won't strip types under node_modules: the tarball carries dist/, never src/ or tests
  assert.ok(pkg.files.includes('dist') && pkg.files.includes('public'));
  assert.ok(!pkg.files.some((f: string) => /^(src|test|mac-app|scripts)\b/.test(f)));
  const bin = readFileSync(new URL('../bin/portboard', import.meta.url), 'utf8');
  assert.ok(bin.startsWith('#!/usr/bin/env node\n'));
  assert.ok(bin.includes("'../src/cli.ts'") && bin.includes("'../dist/cli.js'"));
});
