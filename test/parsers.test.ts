import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseSs } from '../src/core/ss.ts';
import { parseServe, servedUrl } from '../src/core/tailscale.ts';
import { parseDockerPs } from '../src/core/docker.ts';
import { extractTitle } from '../src/core/probe.ts';
import { projectOf, unitOf } from '../src/core/proc.ts';
import { homedir } from 'node:os';

test('parseSs handles v4, v6, wildcard, iface suffix and names with spaces', () => {
  const out = parseSs(
    [
      'LISTEN 0      511                                 127.0.0.1:8780       0.0.0.0:*    users:(("MainThread",pid=3247206,fd=25))',
      'LISTEN 0      4096                                     [::]:22            [::]:*',
      'LISTEN 0      511                                         *:3000             *:*    users:(("next-server (v1",pid=42,fd=20))',
      'LISTEN 0      4096                           127.0.0.53%lo:53         0.0.0.0:*',
      'LISTEN 0      4096      [fd7a:115c:a1e0::10:1]:7721             [::]:*    users:(("cpool",pid=1,fd=7),("cpool",pid=2,fd=7))',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    out.map((l) => [l.address, l.port, l.scope]),
    [
      ['127.0.0.1', 8780, 'loopback'],
      ['::', 22, 'all'],
      ['*', 3000, 'all'],
      ['127.0.0.53', 53, 'loopback'],
      ['fd7a:115c:a1e0::10:1', 7721, 'tailnet'],
    ],
  );
  assert.deepEqual(out[0].processes, [{ name: 'MainThread', pid: 3247206 }]);
  assert.equal(out[2].processes[0].name, 'next-server (v1');
  assert.equal(out[4].processes.length, 2);
});

test('classify', () => {
  assert.equal(classify('100.64.10.1'), 'tailnet');
  assert.equal(classify('100.200.1.1'), 'other');
  assert.equal(classify('192.168.0.5'), 'other');
  assert.equal(classify('::1'), 'loopback');
});

test('parseServe reads Web handlers and the upstream port', () => {
  const entries = parseServe(
    JSON.stringify({
      TCP: { '443': { HTTPS: true }, '8780': { HTTPS: true } },
      Web: {
        'devbox.example.ts.net:8780': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8780' } } },
        'devbox.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } } },
        'devbox.example.ts.net:9000': { Handlers: { '/': { Proxy: 'http://10.0.0.5:9000' } } },
      },
    }),
  );
  assert.deepEqual(entries, [
    { httpsPort: 443, upstream: 'http://127.0.0.1:8790', upstreamPort: 8790 },
    { httpsPort: 8780, upstream: 'http://127.0.0.1:8780', upstreamPort: 8780 },
    { httpsPort: 9000, upstream: 'http://10.0.0.5:9000', upstreamPort: null },
  ]);
  assert.deepEqual(parseServe('{}'), []);
  assert.deepEqual(parseServe('not json'), []);
  assert.equal(servedUrl('h.ts.net', 443), 'https://h.ts.net/');
  assert.equal(servedUrl('h.ts.net', 8780), 'https://h.ts.net:8780');
});

test('parseDockerPs maps published host ports', () => {
  const map = parseDockerPs(
    'supabase_db\t0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp\nmeta\t8080/tcp\nr\t0.0.0.0:9000-9001->9000-9001/tcp\n',
  );
  assert.equal(map.get(54322), 'supabase_db');
  assert.equal(map.get(9001), 'r');
  assert.equal(map.has(8080), false);
});

test('extractTitle', () => {
  assert.equal(extractTitle('<html><title>\n  A &amp; B </title>'), 'A & B');
  assert.equal(extractTitle('<html></html>'), null);
});

test('projectOf and unitOf', () => {
  const h = homedir();
  assert.equal(projectOf(`${h}/projects/acme/server`), 'acme');
  assert.equal(projectOf(`${h}/projects/worktrees/repo-1/branch/src`), 'worktrees/repo-1/branch');
  assert.equal(projectOf('/tmp'), null);
  assert.equal(unitOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/agent-web.service\n'), 'agent-web.service');
  assert.equal(unitOf('0::/user.slice/user-1000.slice/session-796.scope\n'), null);
});

test('dashboardUrl: the serve port that proxies to the dashboard, no port for 443', async () => {
  const { dashboardUrl } = await import('../src/core/tailscale.ts');
  const e = (httpsPort: number, upstreamPort: number) => ({ httpsPort, upstream: `http://127.0.0.1:${upstreamPort}`, upstreamPort });
  assert.equal(dashboardUrl('h.ts.net', [e(443, 8794), e(8443, 8790)], 8790), 'https://h.ts.net:8443');
  assert.equal(dashboardUrl('h.ts.net', [e(443, 8790)], 8790), 'https://h.ts.net');
  assert.equal(dashboardUrl('h.ts.net', [e(443, 8794)], 8790), null);
  assert.equal(dashboardUrl(null, [e(8443, 8790)], 8790), null);
});
