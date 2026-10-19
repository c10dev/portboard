// Site config (c10dev/portboard#37): every host-specific value resolves env → runtime → portboard.json (the user's,
// then the checkout's) → default, and with no file and no runtime the values are generic ones read from this machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { CHECKOUT_SITE, loadSite, mergeSiteFiles, parseSiteFile, resolveDashboardUrl, resolveSite, SITE_DEFAULTS, tildePath } from '../src/core/site.ts';
import { resolvePaths, seedPreview } from '../src/core/paths.ts';
import { checkConfig, DEFAULT_CONFIG } from '../src/core/pveports.ts';
import type { ServeEntry } from '../src/core/tailscale.ts';

const HOME = '/home/u';
const SERVE: ServeEntry[] = [
  { httpsPort: 443, upstream: 'http://127.0.0.1:8794', upstreamPort: 8794, funnel: true },
  { httpsPort: 8443, upstream: 'http://127.0.0.1:8790', upstreamPort: 8790 },
];
const RUNTIME = { hostName: 'box', dnsName: 'box.tail9.ts.net.', checkout: '/srv/pb', user: 'ops', serve: SERVE, dashboardPort: 8790 };
const FILE = {
  host: 'filehost',
  tailnet: 'tailf.ts.net',
  user: 'fileuser',
  checkout: '/opt/portboard',
  reposRoot: ['~/code', '/data/repos'],
  poolUrl: 'http://10.0.0.2:7720',
  dashboardUrl: 'https://filehost.tailf.ts.net:9443',
  publicUrl: 'https://filehost.tailf.ts.net',
};

test('no env, no runtime, no file: generic values from this machine, the SSH readers off', () => {
  const s = resolveSite({ home: HOME });
  assert.equal(s.host, hostname().split('.')[0]);
  assert.equal(s.tailnet, '');
  assert.equal(s.dnsName, s.host);
  assert.equal(s.user, userInfo().username);
  assert.equal(s.checkout, dirname(CHECKOUT_SITE));
  assert.deepEqual(s.reposRoots, ['/home/u/projects']);
  assert.equal(s.poolUrl, 'http://127.0.0.1:7720');
  assert.equal(s.dashboardUrl, null);
  assert.equal(s.publicUrl, `https://${s.host}`);
  assert.deepEqual(s.pve, { host: 'pve', user: 'root', key: '~/.ssh/portboard_ro', node: 'pve', enabled: false });
  assert.deepEqual(s.windows, { host: 'windows', user: null, key: '~/.ssh/portboard_ro', device: 'windows', enabled: false });
  assert.ok(Object.values(s.sources).every((x) => x === 'default'), JSON.stringify(s.sources));
  assert.equal(s.checkoutFile, null);
  // the public URL follows the tailnet name when one is known
  assert.equal(resolveSite({ file: { host: 'box', tailnet: 'example.ts.net' } }).publicUrl, 'https://box.example.ts.net');
  // the generic Proxmox and Windows defaults validate: the readers are off, not misconfigured
  assert.deepEqual(checkConfig(undefined), DEFAULT_CONFIG);
});

test('the file beats the defaults', () => {
  const s = resolveSite({ file: FILE, home: HOME });
  assert.equal(s.host, 'filehost');
  assert.equal(s.tailnet, 'tailf.ts.net');
  assert.equal(s.dnsName, 'filehost.tailf.ts.net');
  assert.equal(s.user, 'fileuser');
  assert.equal(s.checkout, '/opt/portboard');
  assert.deepEqual(s.reposRoots, ['/home/u/code', '/data/repos']);
  assert.equal(s.poolUrl, 'http://10.0.0.2:7720');
  assert.equal(s.dashboardUrl, 'https://filehost.tailf.ts.net:9443');
  assert.equal(s.publicUrl, 'https://filehost.tailf.ts.net');
  assert.equal(s.sources.host, 'file');
  assert.equal(s.sources.dnsName, 'file');
  assert.equal(s.sources.dashboardUrl, 'file');
  // a comma string works like the env variable
  assert.deepEqual(resolveSite({ file: { reposRoot: '~/a,/b' }, home: HOME }).reposRoots, ['/home/u/a', '/b']);
});

test('runtime beats the file', () => {
  const s = resolveSite({ file: FILE, runtime: RUNTIME, home: HOME });
  assert.equal(s.host, 'box');
  assert.equal(s.tailnet, 'tail9.ts.net');
  assert.equal(s.dnsName, 'box.tail9.ts.net');
  assert.equal(s.user, 'ops');
  assert.equal(s.checkout, '/srv/pb');
  assert.equal(s.dashboardUrl, 'https://box.tail9.ts.net:8443');
  assert.deepEqual([s.sources.host, s.sources.tailnet, s.sources.dnsName, s.sources.user, s.sources.checkout, s.sources.dashboardUrl], Array(6).fill('runtime'));
  // values with no runtime source still come from the file
  assert.equal(s.poolUrl, 'http://10.0.0.2:7720');
  assert.equal(s.sources.poolUrl, 'file');
});

test('a runtime source that could not be read falls through to the file, then the default', () => {
  const partial = { hostName: null, dnsName: null, checkout: null, user: null, serve: null, dashboardPort: 8790 };
  const s = resolveSite({ file: { host: 'filehost' }, runtime: partial, home: HOME });
  assert.equal(s.host, 'filehost');
  assert.equal(s.sources.host, 'file');
  assert.equal(s.tailnet, '');
  assert.equal(s.sources.tailnet, 'default');
  assert.equal(s.dnsName, 'filehost');
  assert.equal(s.checkout, SITE_DEFAULTS.checkout);
  // serve read but the dashboard not published there: the file's URL, else none
  assert.equal(resolveSite({ runtime: { ...RUNTIME, serve: [SERVE[0]] }, file: FILE }).dashboardUrl, FILE.dashboardUrl);
  assert.equal(resolveSite({ runtime: { ...RUNTIME, serve: [SERVE[0]] } }).dashboardUrl, null);
});

test('the existing env variables win over runtime, file and default', () => {
  const env = { PORTBOARD_POOL_URL: 'http://pool:1', PORTBOARD_REPOS_ROOT: '/r1,/r2', PORTBOARD_DASHBOARD_URL: 'https://env.example:1' };
  const s = resolveSite({ env, file: FILE, runtime: RUNTIME, home: HOME });
  assert.equal(s.poolUrl, 'http://pool:1');
  assert.deepEqual(s.reposRoots, ['/r1', '/r2']);
  assert.equal(s.dashboardUrl, 'https://env.example:1');
  assert.deepEqual([s.sources.poolUrl, s.sources.reposRoots, s.sources.dashboardUrl], ['env', 'env', 'env']);
  // an empty variable is not set
  assert.equal(resolveSite({ env: { PORTBOARD_POOL_URL: '' }, file: FILE }).poolUrl, FILE.poolUrl);
});

test('resolveDashboardUrl: env, then serve, then the file (callers keep their own port)', () => {
  assert.equal(resolveDashboardUrl('box.t.ts.net', SERVE, 8790, {}, {}), 'https://box.t.ts.net:8443');
  assert.equal(resolveDashboardUrl('box.t.ts.net', SERVE, 8797, {}, {}), null);
  assert.equal(resolveDashboardUrl('box.t.ts.net', SERVE, 8797, {}, { dashboardUrl: 'https://f:1' }), 'https://f:1');
  assert.equal(resolveDashboardUrl('box.t.ts.net', SERVE, 8790, { PORTBOARD_DASHBOARD_URL: 'https://e:2' }, { dashboardUrl: 'https://f:1' }), 'https://e:2');
  assert.equal(resolveDashboardUrl(null, SERVE, 8790, {}, {}), null);
});

test('parseSiteFile: absent, broken, wrong types', () => {
  assert.deepEqual(parseSiteFile(null), { file: {}, found: false, error: null });
  assert.deepEqual(parseSiteFile('{nope'), { file: {}, found: true, error: 'portboard.json is not valid JSON' });
  assert.deepEqual(parseSiteFile('[1]'), { file: {}, found: true, error: 'portboard.json must be an object' });
  const r = parseSiteFile(JSON.stringify({ host: 'ok', tailnet: 3, reposRoot: [], pve: 'x', windows: { device: 'pc' } }));
  assert.deepEqual(r.file, { host: 'ok', windows: { device: 'pc' } });
  assert.equal(r.error, 'portboard.json: ignored tailnet, reposRoot, pve (wrong type)');
});

test('pve/windows: portboard.json changes the defaults, pveports.json still goes on top', () => {
  const s = resolveSite({ file: { pve: { host: '10.0.0.9', node: 'pve02' }, windows: { user: null, enabled: false } } });
  assert.deepEqual(s.pve, { ...SITE_DEFAULTS.pve, host: '10.0.0.9', node: 'pve02' });
  assert.deepEqual(s.windows, { ...SITE_DEFAULTS.windows, user: null, enabled: false });
  // checkConfig merges a pveports.json over its defaults (SITE.pve: this machine's portboard.json, if any)
  assert.deepEqual(checkConfig({ node: 'pve03' }), { ...DEFAULT_CONFIG, node: 'pve03' });
});

test('loadSite reads the file at PORTBOARD_SITE (or the profile’s config dir)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-site-'));
  const path = join(dir, 'portboard.json');
  await writeFile(path, JSON.stringify({ host: 'gpu-box', tailnet: 'tailx.ts.net', poolUrl: 'http://127.0.0.1:9' }));
  const s = loadSite(path, { PORTBOARD_POOL_URL: 'http://env:1' }, null);
  assert.equal(s.host, 'gpu-box');
  assert.equal(s.dnsName, 'gpu-box.tailx.ts.net');
  assert.equal(s.poolUrl, 'http://env:1');
  assert.equal(s.fileFound, true);
  assert.equal(s.file, path);
  const missing = loadSite(join(dir, 'none.json'), {}, null);
  assert.equal(missing.fileFound, false);
  assert.equal(missing.host, SITE_DEFAULTS.host);
  // paths: production's config dir, a preview's own dir, or PORTBOARD_SITE
  assert.equal(resolvePaths({}, HOME).site, '/home/u/.config/portboard/portboard.json');
  assert.equal(resolvePaths({ PORTBOARD_PORT: '8807' }, HOME).site, '/home/u/.local/state/portboard/previews/8807/portboard.json');
  assert.equal(resolvePaths({ PORTBOARD_SITE: '/x/site.json', PORTBOARD_PORT: '8807' }, HOME).site, '/x/site.json');
});

test('the checkout’s portboard.json sits under the user’s, key by key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-site-co-'));
  const user = join(dir, 'user.json');
  const co = join(dir, 'checkout.json');
  await writeFile(co, JSON.stringify({ host: 'co-host', tailnet: 'co.ts.net', pve: { host: '10.0.0.5', enabled: true } }));
  await writeFile(user, JSON.stringify({ host: 'user-host', pve: { node: 'pve9' } }));
  const s = loadSite(user, {}, co);
  assert.equal(s.host, 'user-host');
  assert.equal(s.tailnet, 'co.ts.net');
  assert.equal(s.dnsName, 'user-host.co.ts.net');
  assert.deepEqual(s.pve, { ...SITE_DEFAULTS.pve, host: '10.0.0.5', enabled: true, node: 'pve9' });
  assert.equal(s.checkoutFile, co);
  assert.equal(s.fileFound, true);
  // only the checkout file
  const only = loadSite(join(dir, 'none.json'), {}, co);
  assert.equal(only.host, 'co-host');
  assert.equal(only.sources.host, 'file');
  assert.equal(only.fileFound, false);
  // a broken checkout file is reported and ignored
  await writeFile(co, '{nope');
  const broken = loadSite(join(dir, 'none.json'), {}, co);
  assert.equal(broken.host, SITE_DEFAULTS.host);
  assert.match(broken.fileError ?? '', /checkout\.json: portboard\.json is not valid JSON/);
  assert.deepEqual(mergeSiteFiles({ host: 'a', windows: { device: 'x' } }, { windows: { user: null } }), { host: 'a', windows: { device: 'x', user: null } });
});

test('a preview is seeded with its own copy of production’s portboard.json', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pb-site-home-'));
  await mkdir(join(home, '.config', 'portboard'), { recursive: true });
  await writeFile(join(home, '.config', 'portboard', 'portboard.json'), '{"host":"h"}');
  const p = resolvePaths({ PORTBOARD_PORT: '8809' }, home);
  const copied = await seedPreview(p);
  assert.ok(copied.includes(p.site), JSON.stringify(copied));
  assert.equal(await readFile(p.site, 'utf8'), '{"host":"h"}');
});

test('tildePath', () => {
  assert.equal(tildePath('/home/u/projects/portboard', HOME), '~/projects/portboard');
  assert.equal(tildePath('/srv/pb', HOME), '/srv/pb');
});

test('portboard.example.json is a valid site file with every key', async () => {
  const r = parseSiteFile(await readFile(new URL('../portboard.example.json', import.meta.url), 'utf8'));
  assert.equal(r.error, null);
  assert.deepEqual(Object.keys(r.file).sort(), ['checkout', 'dashboardUrl', 'host', 'poolUrl', 'publicUrl', 'pve', 'reposRoot', 'tailnet', 'user', 'windows']);
});
