// The static demo (scripts/demo.ts, #13): how the browser's API calls map to files, the refusal to build from
// anything but the example data, the pages it writes, and a whole build (scan included) in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiFile, demoAnswers, demoPage, demoRefusal, demoShim, EXAMPLE, type DemoCheck } from '../scripts/demo.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('apiFile: path → file, only the query keys that pick other data count', () => {
  assert.equal(apiFile('/api/ports'), 'api/ports.json');
  assert.equal(apiFile('/api/ports?fresh'), 'api/ports.json');
  assert.equal(apiFile('/api/usage?fresh=1'), 'api/usage.json');
  assert.equal(apiFile('/api/worktrees?rescan'), 'api/worktrees.json');
  assert.equal(apiFile('/api/new-ports?since=1792240344356'), 'api/new-ports.json');
  assert.equal(apiFile('/api/ports/8790/detail'), 'api/ports/8790/detail.json');
  assert.equal(apiFile('/api/health?detail'), 'api/health.detail.json');
  assert.equal(apiFile('/api/proxmox/trends?timeframe=hour'), 'api/proxmox/trends.timeframe-hour.json');
  assert.equal(apiFile('/api/audit?port=3000&limit=20'), 'api/audit.port-3000.json');
  assert.equal(apiFile('/api/digest/preview?mode=weekly'), 'api/digest/preview.mode-weekly.json');
  assert.equal(apiFile('/api/settings/write-devices'), 'api/settings/write-devices.json');
  // nothing outside api/, no climbing out of it, no odd values in a file name
  for (const bad of ['/app.js', '/api', '/api/', '/api/../secrets', '/api/a/./b', '/api/ports%2F..', 'api/ports', '/api/audit?port=../x', '/api/x?timeframe=a.b']) {
    assert.equal(apiFile(bad), null, bad);
  }
});

test('apiFile runs as plain JavaScript on its own, as the shim inlines it', () => {
  const inlined = new Function(`return (${apiFile.toString()});`)() as typeof apiFile;
  for (const p of ['/api/ports?fresh', '/api/health?detail', '/api/audit?port=7720&limit=5', '/app.js']) assert.equal(inlined(p), apiFile(p), p);
});

const example: DemoCheck = {
  site: { file: EXAMPLE.siteFile, host: 'devbox', tailnet: 'example.ts.net', dnsName: 'devbox.example.ts.net' },
  data: { hostname: 'devbox', dnsName: 'devbox.example.ts.net' },
};

test('demoRefusal: only the example site config and the example data', () => {
  assert.equal(demoRefusal(example), null);
  // a real install's config (the default path), even when it names the same host
  assert.match(demoRefusal({ ...example, site: { ...example.site, file: '/home/dev/.config/portboard/portboard.json' } })!, /not the example.*npm run demo/);
  // the example file, but an environment variable moved the host or tailnet
  assert.match(demoRefusal({ ...example, site: { ...example.site, host: 'prod-1', dnsName: 'prod-1.example.ts.net' } })!, /resolves to prod-1\.example\.ts\.net/);
  assert.match(demoRefusal({ ...example, site: { ...example.site, tailnet: 'corp.ts.net', dnsName: 'devbox.corp.ts.net' } })!, /not the example devbox\.example\.ts\.net/);
  // data captured from another machine
  assert.match(demoRefusal({ ...example, data: { hostname: 'prod-1', dnsName: 'prod-1.corp.ts.net' } })!, /data describes prod-1\.corp\.ts\.net/);
  assert.match(demoRefusal({ ...example, data: { hostname: null, dnsName: null } })!, /unknown host/);
});

test('demoShim fills the mapping and the capture time; the result parses', () => {
  const shim = demoShim(read('scripts/demo/shim.js'), 1792240344356);
  assert.ok(!shim.includes('__API_FILE__') && !shim.includes('__CAPTURED_AT__'));
  assert.match(shim, /const CAPTURED = 1792240344356;/);
  assert.match(shim, /const apiFile = function apiFile\(/);
  assert.doesNotThrow(() => new Function(shim));
  assert.throws(() => demoShim('nothing to fill', 0), /expected/);
});

test('demoPage: shell expanded, feature scripts added, the shim right after the charset, Auto follows the browser', () => {
  const html = demoPage(read('public/index.html'), 'index.html', { shim: '/* shim */', hostname: 'devbox' });
  assert.ok(!html.includes('<!--#shell:'), 'every shell marker expanded');
  assert.ok(html.includes('<script src="features/nav.js" type="module"></script>'), 'feature scripts');
  const shimAt = html.indexOf('<script>/* shim */</script>');
  assert.ok(shimAt > html.indexOf('<meta charset="utf-8">') && shimAt < html.indexOf('PortboardBoot'), 'shim after the charset, before the boot script');
  assert.ok(html.indexOf('<meta charset="utf-8">') < 1024, 'the charset stays in the first 1024 bytes');
  assert.ok(html.includes('"explicit":false') && !html.includes('"explicit":true'));
  // a page without the shell (settings.html) still gets its text and the shim
  const settings = demoPage(read('public/settings.html'), 'settings.html', { shim: '/* shim */', hostname: 'devbox' });
  assert.ok(settings.includes('<script>/* shim */</script>'));
  assert.ok(!/data-t="[\w.-]+"><\//.test(settings), 'static text filled');
});

test('demoAnswers: what the pages read is there, computed at the capture time', () => {
  const data = new Map<string, unknown>();
  const dir = join(ROOT, 'scripts/demo/data/');
  for (const f of execFileSync('find', ['.', '-name', '*.json'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean)) {
    data.set(f.replace(/^\.\//, ''), JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
  const { files, capturedAt } = demoAnswers(data);
  const ports = files.get('api/ports.json') as { at: string; host: { hostname: string }; ports: { port: number; group?: unknown }[] };
  assert.equal(capturedAt, Date.parse(ports.at));
  assert.equal(ports.host.hostname, EXAMPLE.host);
  // every GET the pages make on load (public/**/*.js)
  for (const p of ['/api/ports?fresh', '/api/usage', '/api/devices', '/api/whoami', '/api/health', '/api/health?detail', '/api/onboarding', '/api/worktrees',
    '/api/alerts', '/api/settings', '/api/settings/write-devices', '/api/suggestions', '/api/new-ports', '/api/claude/sessions', '/api/owners', '/api/adoption',
    '/api/digest', '/api/digest/preview', '/api/memory', '/api/port-rules', '/api/reservations', '/api/dev-servers', '/api/remote/clients', '/api/audit',
    '/api/proxmox/trends?timeframe=hour']) {
    assert.ok(files.has(apiFile(p)!), p);
  }
  // each port has its page and its audit lines; groups, history and the network map are joined in
  for (const { port } of ports.ports) {
    assert.ok(files.has(`api/ports/${port}/detail.json`), `detail ${port}`);
    assert.ok(files.has(`api/audit.port-${port}.json`), `audit ${port}`);
  }
  assert.ok(ports.ports.some((p) => p.group), 'grouped');
  const usage = files.get('api/usage.json') as { history: { startedAt: string }; tree: { roots: unknown[] } };
  assert.ok(usage.history.startedAt && usage.tree.roots.length);
  const d7720 = files.get('api/ports/7720/detail.json') as { uptime: { outages: unknown[] }; events: unknown[] };
  assert.equal(d7720.uptime.outages.length, 1);
  assert.equal(d7720.events.length, 2);
  // the data is English and the example's (the server's text in it would otherwise be Korean, as captured)
  assert.ok(![...files.values()].some((v) => /[가-힣]/.test(JSON.stringify(v))));
});

test('npm run demo: refuses another site config and leaves no output; builds and scans the example', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-demo-'));
  try {
    const other = join(tmp, 'portboard.json');
    writeFileSync(other, JSON.stringify({ host: 'prod-1', tailnet: 'corp.ts.net' }));
    const refused = spawnSync(process.execPath, ['scripts/demo.ts', '--out', join(tmp, 'refused')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PORTBOARD_SITE: other } });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing to build the demo/);
    assert.ok(!existsSync(join(tmp, 'refused')) && !existsSync(join(tmp, 'refused.staging')));

    const out = join(tmp, 'site');
    const built = spawnSync(process.execPath, ['scripts/demo.ts', '--out', out], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PORTBOARD_SITE: 'portboard.example.json' } });
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stderr, /public-scan: 0 finding/);
    for (const f of ['index.html', '.nojekyll', 'images/services-1200.png', 'app/index.html', 'app/service.html', 'app/lib/api.js', 'app/i18n/ko.json', 'app/api/ports.json', 'app/api/ports/8790/detail.json']) {
      assert.ok(existsSync(join(out, f)), f);
    }
    assert.ok(!existsSync(`${out}.staging`));
    assert.match(readFileSync(join(out, 'app/manifest.webmanifest'), 'utf8'), /"start_url": "\.\/"/);
    assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /href="app\/"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
