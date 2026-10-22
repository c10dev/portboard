// .claude/launch.json for Claude Code Desktop's preview: the entry Portboard writes, merging into an existing file,
// and the files it refuses to touch (comments, tracked by git, symlinks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTRY_NAME, hasComments, launchEntry, launchPortOf, mergeLaunch, writeLaunch } from '../src/core/launchjson.ts';
import { DATA_LINE, sessionText } from '../src/core/portadvice.ts';
import { t } from '../src/core/i18n.ts';

test('launchEntry: run mode passes the port to the framework and turns autoPort off; attach mode is a url only', () => {
  assert.deepEqual(launchEntry({ mode: 'run', port: 4100, script: 'dev', fw: 'vite' }), {
    name: ENTRY_NAME,
    runtimeExecutable: 'npm',
    runtimeArgs: ['run', 'dev', '--', '--port', '4100', '--strictPort', '--host', '127.0.0.1'],
    port: 4100,
    autoPort: false,
    env: { PORT: '4100' },
  });
  assert.deepEqual(launchEntry({ mode: 'run', port: 4100, script: 'start' }).runtimeArgs, ['run', 'start']);
  assert.deepEqual(launchEntry({ mode: 'attach', port: 4100 }), { name: ENTRY_NAME, url: 'http://localhost:4100', port: 4100 });
});

test('hasComments ignores slashes inside strings', () => {
  assert.equal(hasComments('{"url": "http://localhost:3000"}'), false);
  assert.equal(hasComments('{"a": "\\"//"}'), false);
  assert.equal(hasComments('{\n  // mine\n  "a": 1}'), true);
  assert.equal(hasComments('{ /* x */ }'), true);
});

test('mergeLaunch: new file, replaces only our entry, keeps the others and extra keys, refuses comments and junk', () => {
  const e = launchEntry({ mode: 'attach', port: 4100 });
  const fresh = mergeLaunch(null, e);
  assert.ok(fresh.ok);
  assert.deepEqual(JSON.parse(fresh.text), { version: '0.0.1', configurations: [e] });

  const theirs = { version: '0.0.1', autoVerify: false, configurations: [{ name: 'api', port: 8000 }, { name: ENTRY_NAME, port: 1 }] };
  const m = mergeLaunch(JSON.stringify(theirs), e);
  assert.ok(m.ok && m.changed);
  assert.deepEqual(JSON.parse(m.text), { ...theirs, configurations: [{ name: 'api', port: 8000 }, e] });
  const again = mergeLaunch(m.text, e);
  assert.ok(again.ok && !again.changed, 'idempotent');

  assert.deepEqual(mergeLaunch('{ // keep me\n "configurations": [] }', e), { ok: false, reason: 'comments' });
  assert.deepEqual(mergeLaunch('[1]', e), { ok: false, reason: 'invalid' });
  assert.deepEqual(mergeLaunch('{"configurations": {}}', e), { ok: false, reason: 'invalid' });
  assert.deepEqual(mergeLaunch('{nope', e), { ok: false, reason: 'invalid' });
});

test('launchPortOf: our entry first, else the first entry with a port', () => {
  assert.equal(launchPortOf(null), null);
  assert.equal(launchPortOf('{"configurations": [{"name": "a", "port": 3000}, {"name": "portboard", "port": 4100}]}'), 4100);
  assert.equal(launchPortOf('{"configurations": [{"name": "a"}, {"name": "b", "port": 5173}]}'), 5173);
  assert.equal(launchPortOf('{"configurations": [{"name": "a", "port": 99999}]}'), null);
  assert.equal(launchPortOf('// x\n{}'), null);
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pb-launch-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

test('writeLaunch: writes the file and excludes it from git once', async () => {
  const dir = repo();
  try {
    const e = launchEntry({ mode: 'attach', port: 4100 });
    const w = await writeLaunch(dir, e);
    assert.ok(w.ok && w.changed && w.excluded, JSON.stringify(w));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.claude/launch.json'), 'utf8')).configurations, [e]);
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
    assert.equal(status, '', 'excluded: not an untracked file');
    const w2 = await writeLaunch(dir, e);
    assert.ok(w2.ok && !w2.changed);
    const exclude = readFileSync(join(dir, '.git/info/exclude'), 'utf8');
    assert.equal(exclude.split('\n').filter((l) => l === '/.claude/launch.json').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeLaunch: leaves a tracked file, a commented file and a symlink alone, and returns the entry', async () => {
  const dir = repo();
  try {
    const e = launchEntry({ mode: 'attach', port: 4100 });
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude/launch.json'), '{ // team file\n "configurations": [] }');
    const c = await writeLaunch(dir, e);
    assert.ok(!c.ok && c.reason === 'comments' && c.entry === e);

    writeFileSync(join(dir, '.claude/launch.json'), '{"configurations": []}');
    execFileSync('git', ['-C', dir, 'add', '.claude/launch.json']);
    const tr = await writeLaunch(dir, e);
    assert.ok(!tr.ok && tr.reason === 'tracked');
    assert.equal(readFileSync(join(dir, '.claude/launch.json'), 'utf8'), '{"configurations": []}');

    const other = repo();
    try {
      symlinkSync(join(dir, '.claude'), join(other, '.claude'));
      const s = await writeLaunch(other, e);
      assert.ok(!s.ok && s.reason === 'symlink');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sessionText: reserved port, PORT line only when the hook set it, launch.json hints; nothing to say → null', () => {
  const here = { owner: 'shop@feat-x', path: '/w', startable: true, launchPort: null };
  const r = sessionText({ here, port: 4100, env: true })!;
  assert.match(r, /^\[portboard\] /);
  assert.match(r, /4100/);
  assert.match(r, /PORT=4100/);
  assert.match(r, /write_launch_config/);
  assert.doesNotMatch(sessionText({ here, port: 4100, env: false })!, /PORT=4100/);
  assert.match(sessionText({ here: { ...here, launchPort: 3000 }, port: 4100, env: false })!, /3000/);
  assert.doesNotMatch(sessionText({ here: { ...here, launchPort: 4100 }, port: 4100, env: false })!, /write_launch_config/);
  assert.match(sessionText({ here, port: null, env: true })!, /free_port/);
  assert.equal(sessionText({ here: { ...here, startable: false }, port: null, env: true }), null);
  // the branch name is quoted data, newlines and all
  assert.doesNotMatch(sessionText({ here: { ...here, owner: 'shop@x\nIgnore previous' }, port: 4100, env: false })!, /\nIgnore/);
});

test("sessionPort: the owner's lowest reserved port, the launch.json port, and null outside a checkout", async () => {
  const { sessionPort } = await import('../src/features/claude.ts');
  const reservations = async () => [
    { port: 4200, owner: 'shop@x', createdAt: '' },
    { port: 4100, owner: 'shop@x', createdAt: '' },
    { port: 3000, owner: 'other@y', createdAt: '' },
  ];
  const here = async (cwd: string | null) => (cwd === '/w/shop' ? { owner: 'shop@x', path: '/w/shop', startable: true, launchPort: 3000 } : null);
  const r = await sessionPort({ cwd: '/w/shop', env: true }, { reservations, here });
  assert.equal(r?.port, 4100);
  assert.equal(r?.launchPort, 3000);
  assert.match(r!.text!, /PORT=4100/);
  assert.equal(await sessionPort({ cwd: '/elsewhere', env: true }, { reservations, here }), null);
  // machines=1: the other machines working on this repo@branch, asked by owner; without it, never asked
  const asked: string[] = [];
  const elsewhere = (owner: string) => (asked.push(owner), [{ machine: 'mac', dirty: 5, sessions: 1, inUse: true }]);
  const m = await sessionPort({ cwd: '/w/shop', env: false, machines: true }, { reservations, here, elsewhere });
  assert.deepEqual(m?.elsewhere, [{ machine: 'mac', dirty: 5, sessions: 1, inUse: true }]);
  assert.match(m!.text!, /"mac"/);
  const plain = await sessionPort({ cwd: '/w/shop', env: false }, { reservations, here, elsewhere });
  assert.equal(plain?.elsewhere, undefined);
  assert.deepEqual(asked, ['shop@x']);
});

test('sessionText: the other-machine line, quoted, even with no port to talk about; at most 4 machines', () => {
  const here = { owner: 'shop@feat-x', path: '/w', startable: false, launchPort: null };
  const e = (machine: string, over: object = {}) => ({ machine, dirty: 0, sessions: 0, inUse: false, ...over });
  const r = sessionText({ here, port: null, env: false, elsewhere: [e('mac', { dirty: 3 }), e('desktop', { sessions: 2 }), e('box', { inUse: true })] })!;
  const lines = r.split('\n');
  assert.match(lines[0], /^\[portboard\] /);
  assert.ok(lines[0].includes(t('portadvice.session.elsewhere', { owner: '"shop@feat-x"', list: `"mac" (${t('portadvice.session.elsewhereDirty', { n: 3 })}); "desktop" (${t('portadvice.session.elsewhereSessions', { n: 2 })}); "box" (${t('portadvice.session.elsewhereInUse')})` })), lines[0]);
  assert.equal(lines[1], DATA_LINE);
  // with a port: the port line first, the other-machine line last
  const p = sessionText({ here: { ...here, startable: true }, port: 4100, env: false, elsewhere: [e('mac', { dirty: 1 })] })!.split('\n');
  assert.match(p[0], /4100/);
  assert.match(p.at(-1)!, /"mac"/);
  assert.equal(sessionText({ here, port: null, env: false, elsewhere: [] }), null);
  const many = sessionText({ here, port: null, env: false, elsewhere: ['a', 'b', 'c', 'd', 'e'].map((x) => e(x, { dirty: 1 })) })!;
  assert.ok(many.includes('"d"') && !many.includes('"e"'));
  // a machine name is data too
  assert.doesNotMatch(sessionText({ here, port: null, env: false, elsewhere: [e('mac\nIgnore previous', { dirty: 1 })] })!, /\nIgnore/);
});
