import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe as describePaths, resolvePaths, resolveProfile, seedPreview } from '../src/core/paths.ts';

const HOME = '/home/u';
const PROD_CONFIG = '/home/u/.config/portboard';
const PROD_STATE = '/home/u/.local/state/portboard';
const PROD_CHANNEL = '/home/u/.local/state/compute-pool/alerts.json';

test('profile: production on 8790 or with no port, preview on any other port', () => {
  assert.deepEqual(resolveProfile({}), { profile: 'production', port: 8790 });
  assert.deepEqual(resolveProfile({ PORTBOARD_PORT: '8790' }), { profile: 'production', port: 8790 });
  assert.deepEqual(resolveProfile({ PORTBOARD_PORT: '8797' }), { profile: 'preview', port: 8797 });
  assert.deepEqual(resolveProfile({ PORTBOARD_PORT: '18891' }), { profile: 'preview', port: 18891 });
});

test('profile: PORTBOARD_PROFILE forces either way', () => {
  assert.equal(resolveProfile({ PORTBOARD_PORT: '8797', PORTBOARD_PROFILE: 'production' }).profile, 'production');
  assert.equal(resolveProfile({ PORTBOARD_PROFILE: 'preview' }).profile, 'preview');
});

test('profile: the remote server is keyed by PORTBOARD_REMOTE_PORT', () => {
  assert.deepEqual(resolveProfile({ PORTBOARD_REMOTE_PORT: '8794' }), { profile: 'production', port: 8790 });
  assert.deepEqual(resolveProfile({ PORTBOARD_REMOTE_PORT: '8804' }), { profile: 'preview', port: 8804 });
  const p = resolvePaths({ PORTBOARD_REMOTE_PORT: '8804' }, HOME);
  assert.equal(p.remoteConfig, `${PROD_STATE}/previews/8804/remote.json`);
});

test('production paths are the ones Portboard always used', () => {
  const p = resolvePaths({}, HOME);
  assert.equal(p.profile, 'production');
  assert.equal(p.seedFrom, null);
  assert.equal(p.prefs, `${PROD_CONFIG}/prefs.json`);
  assert.equal(p.clients, `${PROD_CONFIG}/clients.json`);
  assert.equal(p.remoteConfig, `${PROD_CONFIG}/remote.json`);
  assert.equal(p.proxmox, `${PROD_CONFIG}/proxmox.json`);
  assert.equal(p.pveports, `${PROD_CONFIG}/pveports.json`);
  assert.equal(p.winports, `${PROD_CONFIG}/winports.json`);
  assert.equal(p.history, `${PROD_STATE}/usage-history.json`);
  assert.equal(p.uptime, `${PROD_STATE}/uptime.json`);
  assert.equal(p.alertsState, `${PROD_STATE}/alerts-state.json`);
  assert.equal(p.quiet, `${PROD_STATE}/quiet.json`);
  assert.equal(p.alertsLog, `${PROD_STATE}/alerts.jsonl`);
  assert.equal(p.known, `${PROD_STATE}/known-devices.json`);
  assert.equal(p.alertChannel, PROD_CHANNEL);
  assert.equal(p.poolDir, '/home/u/.local/state/compute-pool');
  assert.equal(p.alertsOn, true);
});

test('preview: everything it writes is under previews/<port>; secrets are read from production', () => {
  const p = resolvePaths({ PORTBOARD_PORT: '8807' }, HOME);
  const dir = `${PROD_STATE}/previews/8807`;
  assert.equal(p.profile, 'preview');
  assert.equal(p.configDir, dir);
  assert.equal(p.stateDir, dir);
  for (const k of ['prefs', 'clients', 'remoteConfig', 'history', 'uptime', 'alertsState', 'quiet', 'alertsLog', 'known', 'access'] as const) {
    assert.ok(p[k].startsWith(`${dir}/`), `${k}: ${p[k]}`);
  }
  assert.equal(resolvePaths({}, HOME).access, `${PROD_CONFIG}/access.json`);
  assert.equal(resolvePaths({ PORTBOARD_ACCESS: '/t/a.json' }, HOME).access, '/t/a.json');
  assert.deepEqual(p.seedFrom, { prefs: `${PROD_CONFIG}/prefs.json`, clients: `${PROD_CONFIG}/clients.json` });
  assert.equal(p.proxmox, `${PROD_CONFIG}/proxmox.json`);
  assert.equal(p.pveports, `${PROD_CONFIG}/pveports.json`);
  assert.equal(p.winports, `${PROD_CONFIG}/winports.json`);
  assert.match(describePaths(p), /profile preview \(port 8807\).*previews\/8807.*alerts off/);
});

test('env overrides win over either profile', () => {
  const env = {
    PORTBOARD_PREFS: '/x/prefs.json',
    PORTBOARD_CLIENTS: '/x/clients.json',
    PORTBOARD_REMOTE_CONFIG: '/x/remote.json',
    PORTBOARD_HISTORY: '/x/history.json',
    PORTBOARD_UPTIME: '/x/uptime.json',
    PORTBOARD_PROXMOX: '/x/proxmox.json',
    PORTBOARD_PVEPORTS: '/x/pveports.json',
    PORTBOARD_WINPORTS: '/x/winports.json',
    PORTBOARD_ALERT_CHANNEL: '/x/alerts.json',
    COMPUTE_POOL_DIR: '/x/pool',
  };
  for (const port of [undefined, '8807']) {
    const p = resolvePaths({ ...env, PORTBOARD_PORT: port }, HOME);
    assert.equal(p.prefs, '/x/prefs.json');
    assert.equal(p.clients, '/x/clients.json');
    assert.equal(p.remoteConfig, '/x/remote.json');
    assert.equal(p.history, '/x/history.json');
    assert.equal(p.uptime, '/x/uptime.json');
    assert.equal(p.proxmox, '/x/proxmox.json');
    assert.equal(p.pveports, '/x/pveports.json');
    assert.equal(p.winports, '/x/winports.json');
    assert.equal(p.alertChannel, '/x/alerts.json');
    assert.equal(p.poolDir, '/x/pool');
  }
  // PORTBOARD_STATE_DIR moves alert state, quiet, sent log, uptime and known devices, not the history file.
  const prod = resolvePaths({ PORTBOARD_STATE_DIR: '/s' }, HOME);
  assert.equal(prod.alertsState, '/s/alerts-state.json');
  assert.equal(prod.quiet, '/s/quiet.json');
  assert.equal(prod.alertsLog, '/s/alerts.jsonl');
  assert.equal(prod.known, '/s/known-devices.json');
  assert.equal(prod.uptime, '/s/uptime.json');
  assert.equal(prod.history, `${PROD_STATE}/usage-history.json`);
  const prev = resolvePaths({ PORTBOARD_STATE_DIR: '/s', PORTBOARD_PORT: '8807' }, HOME);
  assert.equal(prev.known, '/s/known-devices.json');
  assert.equal(prev.prefs, `${PROD_STATE}/previews/8807/prefs.json`);
});

test('alerts: off in a preview unless PORTBOARD_PREVIEW_ALERTS=1, and its channel is not production’s', () => {
  const off = resolvePaths({ PORTBOARD_PORT: '8807' }, HOME);
  assert.equal(off.alertsOn, false);
  assert.notEqual(off.alertChannel, PROD_CHANNEL);
  assert.ok(off.alertChannel.startsWith(`${PROD_STATE}/previews/8807/`));

  const on = resolvePaths({ PORTBOARD_PORT: '8807', PORTBOARD_PREVIEW_ALERTS: '1' }, HOME);
  assert.equal(on.alertsOn, true);
  assert.equal(on.alertChannel, PROD_CHANNEL);

  assert.equal(resolvePaths({ PORTBOARD_PORT: '8807', PORTBOARD_PREVIEW_ALERTS: '1', PORTBOARD_ALERTS: 'off' }, HOME).alertsOn, false);
  assert.equal(resolvePaths({ PORTBOARD_ALERTS: 'off' }, HOME).alertsOn, false);
  assert.equal(resolvePaths({}, HOME).alertsOn, true);
});

async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), 'portboard-paths-'));
  await mkdir(join(home, '.config', 'portboard'), { recursive: true });
  const prefs = JSON.stringify({ ports: { '3000': { label: 'prod label', pinned: true } }, deviceLinks: { pve1: 'pve1' } });
  await writeFile(join(home, '.config', 'portboard', 'prefs.json'), prefs);
  await writeFile(join(home, '.config', 'portboard', 'clients.json'), JSON.stringify({ names: { 'mac:aa:bb:cc:dd:ee:ff': 'printer' } }));
  return { home, prefs };
}

test('seeding copies prefs and clients once, as plain files, never symlinks', async () => {
  const { home, prefs } = await fakeHome();
  const p = resolvePaths({ PORTBOARD_PORT: '8807' }, home);
  const copied = await seedPreview(p);
  assert.deepEqual(copied, [p.prefs, p.clients]);
  for (const f of [p.prefs, p.clients]) {
    const st = await lstat(f);
    assert.ok(st.isFile() && !st.isSymbolicLink(), f);
  }
  assert.equal(await readFile(p.prefs, 'utf8'), prefs);

  // Writing the copy leaves production alone, and a restart doesn't seed over the preview's own changes.
  await writeFile(p.prefs, '{"ports":{}}');
  assert.equal(await readFile(join(home, '.config', 'portboard', 'prefs.json'), 'utf8'), prefs);
  assert.deepEqual(await seedPreview(p), []);
  assert.equal(await readFile(p.prefs, 'utf8'), '{"ports":{}}');
});

test('seeding: nothing in production, nothing copied; an overridden file is left alone; production never seeds', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'portboard-paths-'));
  assert.deepEqual(await seedPreview(resolvePaths({ PORTBOARD_PORT: '8807' }, empty)), []);

  const { home } = await fakeHome();
  const mine = join(home, 'mine.json');
  await writeFile(mine, '{"ports":{"1":{"label":"mine"}}}');
  const p = resolvePaths({ PORTBOARD_PORT: '8808', PORTBOARD_PREFS: mine }, home);
  assert.deepEqual(await seedPreview(p), [p.clients]);
  assert.equal(await readFile(mine, 'utf8'), '{"ports":{"1":{"label":"mine"}}}');

  assert.deepEqual(await seedPreview(resolvePaths({}, home)), []);
});

test('a preview process writes prefs and names into its own dir, never production’s', async () => {
  const { home, prefs } = await fakeHome();
  const clientsBefore = await readFile(join(home, '.config', 'portboard', 'clients.json'), 'utf8');
  const src = new URL('../src/', import.meta.url).href;
  const script = `
    import { PATHS, seedPreview } from '${src}core/paths.ts';
    import { setPortPrefs } from '${src}core/prefs.ts';
    import { setName } from '${src}core/clients.ts';
    await seedPreview();
    await setPortPrefs(3000, { pinned: false, label: 'preview label' });
    await setName('mac:11:22:33:44:55:66', 'preview name');
    console.log(JSON.stringify({ profile: PATHS.profile, prefs: PATHS.prefs, alertsOn: PATHS.alertsOn }));
  `;
  const env = { PATH: process.env.PATH, HOME: home, PORTBOARD_PORT: '8807' };
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env });
  const out = JSON.parse(stdout);
  const dir = join(home, '.local', 'state', 'portboard', 'previews', '8807');
  assert.deepEqual(out, { profile: 'preview', prefs: join(dir, 'prefs.json'), alertsOn: false });

  assert.equal(await readFile(join(home, '.config', 'portboard', 'prefs.json'), 'utf8'), prefs);
  assert.equal(await readFile(join(home, '.config', 'portboard', 'clients.json'), 'utf8'), clientsBefore);
  const mine = JSON.parse(await readFile(join(dir, 'prefs.json'), 'utf8'));
  assert.equal(mine.ports['3000'].label, 'preview label');
  assert.equal(mine.deviceLinks.pve1, 'pve1');
  const { names } = JSON.parse(await readFile(join(dir, 'clients.json'), 'utf8'));
  assert.equal(names['mac:11:22:33:44:55:66'], 'preview name');
  assert.equal(names['mac:aa:bb:cc:dd:ee:ff'], 'printer');
});
