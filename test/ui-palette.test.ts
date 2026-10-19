// The command palette's items (public/features/palette.js) built in node from small /api answers: what each port,
// device and worktree lists, which actions its flags allow, and that "8790 로그" finds the logs action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, paletteItems, VERBS } from '../public/features/palette.js';
import { rank } from '../public/lib/fuzzy.js';
import { verbSplit } from '../public/lib/palette.js';

const port = (over: Record<string, unknown>) => ({
  port: 0, listening: true, scope: 'loopback', addresses: ['127.0.0.1'], kind: 'app', container: null, composeProject: null,
  processes: [{ pid: 1, cmdline: 'node src/server.ts', cwd: '~/projects/portboard', project: 'portboard', unit: null }],
  systemOwner: null, group: null, role: null, name: 'x', detectedName: 'x', label: null, pinned: false, hidden: false, alert: false,
  visible: true, probe: null, served: null, urls: { direct: null, served: null, ssh: null }, canExpose: false, control: null,
  canRestart: false, canStop: false, ...over,
});

const answers = {
  ports: {
    ports: [
      port({ port: 22, name: 'sshd', kind: 'system', visible: false, scope: 'all', urls: { direct: 'tcp://devbox:22', served: null, ssh: null } }),
      port({
        port: 8790, name: 'portboard', pinned: true, alert: true, scope: 'all',
        processes: [{ pid: 2, cmdline: 'node src/server.ts', cwd: '~/projects/portboard', project: 'portboard', unit: 'portboard.service' }],
        urls: { direct: 'http://devbox:8790', served: null, ssh: null },
        control: { type: 'systemd', unit: 'portboard.service' }, canRestart: true, canStop: true,
      }),
    ],
  },
  devices: {
    devices: [
      { id: 'devbox', name: 'devbox', dnsName: 'devbox.example.ts.net', os: 'linux', self: true, online: true, tailscaleIps: ['100.1.1.1'], lanIps: [], pool: { name: 'devbox' } },
      { id: 'iphone', name: 'iphone', dnsName: 'iphone.example.ts.net', os: 'iOS', self: false, online: false, tailscaleIps: ['100.2.2.2'], lanIps: [], pool: null },
    ],
  },
  worktrees: {
    repos: [{
      name: 'portboard', path: '/home/u/projects/portboard',
      worktrees: [
        { path: '/home/u/projects/portboard', short: '~/projects/portboard', branch: 'main', main: true, removable: false, changes: 0, pr: null },
        { path: '/home/u/projects/worktrees/portboard-palette', short: '~/projects/worktrees/portboard-palette', branch: 'palette-35', main: false, removable: true, changes: 2, pr: { number: 35, state: 'OPEN' } },
      ],
    }],
  },
  alerts: { watching: [{ kind: 'device', id: 'iphone', key: 'device:iphone' }] },
};

const byId = (items: ReturnType<typeof paletteItems>, id: string) => items.find((i) => i.id === id)!;
const keys = (item: { actions: { key: string }[] }) => item.actions.map((a) => a.key);

test('paletteItems: one item per port, device and worktree, ids unique, shown ports first', () => {
  const items = paletteItems(answers);
  assert.deepEqual(items.map((i) => i.id), [
    'port:8790', 'port:22', 'device:devbox', 'device:iphone',
    'worktree:/home/u/projects/portboard', 'worktree:/home/u/projects/worktrees/portboard-palette',
  ]);
  for (const i of items) assert.ok(KINDS[i.kind as keyof typeof KINDS], i.kind);
});

test('paletteItems: a port offers what its row offers, 열기 first when it has an address', () => {
  const items = paletteItems(answers);
  const pb = byId(items, 'port:8790');
  assert.equal(pb.title, '8790 portboard');
  assert.deepEqual(keys(pb), ['open', 'detail', 'logs', 'pin', 'alert', 'restart', 'stop']);
  assert.equal(pb.actions.find((a) => a.key === 'pin')!.label, '고정 해제');
  assert.equal(pb.actions.find((a) => a.key === 'alert')!.label, '🔔 다운 알림 끄기');
  assert.ok(pb.actions.find((a) => a.key === 'stop')!.danger);
  assert.match(pb.sub, /portboard\.service/);
  const ssh = byId(items, 'port:22');
  assert.deepEqual(keys(ssh), ['detail', 'pin', 'alert', 'copy'], 'no control: no logs, restart or stop; a tcp address is copied, not opened');
  assert.match(ssh.sub, /시스템/);
});

test('paletteItems: devices and worktrees', () => {
  const items = paletteItems(answers);
  assert.deepEqual(keys(byId(items, 'device:devbox')), ['detail', 'copy-ip', 'copy-dns'], 'no 🔔 for this server / pool hosts');
  const phone = byId(items, 'device:iphone');
  assert.equal(phone.actions.find((a) => a.key === 'alert')!.label, '🔔 오프라인 알림 끄기');
  assert.match(phone.sub, /오프라인 · 100\.2\.2\.2/);
  const wt = byId(items, 'worktree:/home/u/projects/worktrees/portboard-palette');
  assert.equal(wt.title, 'portboard · palette-35');
  assert.match(wt.sub, /PR #35 · 변경 2 · 지울 수 있음/);
  assert.equal(byId(items, 'worktree:/home/u/projects/portboard').title, 'portboard · main (메인)');
});

test('paletteItems: a failed answer (null) leaves its kind out instead of breaking the rest', () => {
  const items = paletteItems({ ports: null, devices: answers.devices, worktrees: null, alerts: null });
  assert.deepEqual(items.map((i) => i.kind), ['device', 'device']);
  assert.equal(byId(items, 'device:iphone').actions.find((a) => a.key === 'alert')!.label, '🔔 오프라인 알림 켜기', 'without /api/alerts nothing reads as watched');
});

test('search: by number, project, unit, IP, branch, initials; "8790 로그" picks the logs action', () => {
  const items = paletteItems(answers);
  const first = (q: string) => rank(q, items)[0]?.item.id;
  assert.equal(first('8790'), 'port:8790');
  assert.equal(first('portboard.service'), 'port:8790');
  assert.equal(first('100.2.2'), 'device:iphone');
  assert.equal(first('palette'), 'worktree:/home/u/projects/worktrees/portboard-palette');
  assert.equal(first('sshd'), 'port:22');
  assert.deepEqual(verbSplit('8790 로그', VERBS), { verb: 'logs', rest: '8790' });
  assert.deepEqual(verbSplit('재시작 portboard', VERBS), { verb: 'restart', rest: 'portboard' });
  for (const v of VERBS) assert.ok(v.names.length > 1, `${v.key} has a Korean and an English name`);
});
