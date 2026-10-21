// The Claude Code port nudge's server side (c10dev/portboard#42): GET /api/claude/port-advice and its text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ADVICE_MARKER, adviceText, worktreeOfCwd, type AdviceFacts, type Holder } from '../src/core/portadvice.ts';
import { holderOf, parseAdviceQuery } from '../src/features/claude.ts';
import { createRouter } from '../src/features/router.ts';
import { REGISTRY } from '../src/features/registry.ts';
import type { ServerContext } from '../src/features/context.ts';
import type { Snapshot } from '../src/core/index.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

const holder = (o: Partial<Holder> = {}): Holder => ({
  name: 'vite',
  pid: 4242,
  unit: null,
  container: null,
  session: null,
  worktree: null,
  worktreePath: null,
  devServer: false,
  cleanupReasons: [],
  cleanable: true,
  ...o,
});
const facts = (o: Partial<AdviceFacts> = {}): AdviceFacts => ({
  port: 5173,
  cmd: 'start',
  tool: 'npm run dev',
  session: 'aaaa-1111',
  holder: null,
  reservation: null,
  here: { owner: 'shop-web@feat-x', path: '/home/dev/projects/shop-web-x', startable: true },
  suggestion: { port: 3104, reserved: true },
  ...o,
});

test('advice text always starts with the marker the adoption metric counts', () => {
  for (const f of [facts(), facts({ cmd: 'kill' }), facts({ holder: holder(), cmd: 'kill' }), facts({ here: null, suggestion: null })]) {
    assert.ok(adviceText(f).startsWith(`${ADVICE_MARKER} `), adviceText(f));
  }
});

test('start on a port another worktree holds: who holds it, the reserved port here, start_dev_server', () => {
  const t = adviceText(
    facts({
      holder: holder({ session: { id: 'bbbb-2222', title: 'map 작업', alive: true }, worktree: 'shop-web@main' }),
      reservation: { owner: 'shop-web@main', note: 'dev server (dev)' },
    }),
  );
  assert.match(t, /포트 5173번을 직접 정해서 dev 서버를 띄우려 해요 \(npm run dev\)/);
  assert.match(t, /지금 쓰는 쪽: "vite" \(pid 4242\) — Claude 세션 "map 작업" \(실행 중\), 워크트리 "shop-web@main"/);
  assert.match(t, /5173번은 다른 쪽이 예약한 포트예요 \(예약: "shop-web@main", 메모 "dev server \(dev\)"\)/);
  assert.match(t, /이 워크트리\("shop-web@feat-x"\)에는 3104번을 쓰세요 \(예약됨\)/);
  assert.match(t, /start_dev_server \{path: "\/home\/dev\/projects\/shop-web-x"\}/);
});

test("start on this worktree's own free reserved port: no other port suggested", () => {
  const t = adviceText(facts({ port: 3104, reservation: { owner: 'shop-web@feat-x' }, suggestion: { port: 3104, reserved: true } }));
  assert.match(t, /3104번은 지금 비어 있어요/);
  assert.match(t, /3104번은 이 워크트리\("shop-web@feat-x"\)의 예약 포트예요/);
  assert.doesNotMatch(t, /번을 쓰세요/);
});

test('start outside a startable worktree: free_port → reserve_port', () => {
  const t = adviceText(facts({ here: null, suggestion: { port: 3000, reserved: false }, port: 8080, tool: null }));
  assert.match(t, /이 작업에는 3000번을 쓰세요 \(비어 있음, reserve_port로 예약 가능\)/);
  assert.match(t, /free_port → reserve_port로 정하세요/);
  const t2 = adviceText(facts({ here: { owner: 'x@y', path: '/x', startable: false } }));
  assert.match(t2, /free_port \{for: "x@y"\} → reserve_port/);
});

test('kill: candidate → cleanup_servers; Portboard dev unit → stop_dev_server; nothing listening; not ours', () => {
  const cand = adviceText(facts({ cmd: 'kill', tool: 'fuser -k', holder: holder({ cleanupReasons: ['브랜치가 이미 머지됨'] }) }));
  assert.match(cand, /포트 5173번을 쥔 프로세스를 직접 kill하려 해요 \(fuser -k\)/);
  assert.match(cand, /정리 후보예요 \(브랜치가 이미 머지됨\) — 대신 MCP cleanup_servers \{ports: \[5173\]\}/);

  const dev = adviceText(facts({ cmd: 'kill', holder: holder({ devServer: true, unit: 'pb-dev-x.service', worktreePath: '/home/dev/projects/x' }) }));
  assert.match(dev, /Portboard start_dev_server가 띄움/);
  assert.match(dev, /stop_dev_server \{path: "\/home\/dev\/projects\/x"\}/);

  assert.match(adviceText(facts({ cmd: 'kill' })), /듣는 프로세스가 없어요/);
  assert.match(adviceText(facts({ cmd: 'kill', holder: holder({ cleanable: false, unit: 'nginx.service' }) })), /멈출 수 있는 개발 서버가 아니에요/);
  assert.match(adviceText(facts({ cmd: 'kill', holder: holder() })), /정리 후보는 아니에요/);
});

test("kill: another live session's server says to ask; this session's own does not", () => {
  const other = adviceText(facts({ cmd: 'kill', holder: holder({ session: { id: 'bbbb-2222', title: null, alive: true } }) }));
  assert.match(other, /Claude 세션 bbbb-222 \(실행 중\)/);
  assert.match(other, /사용자에게 물어보세요/);
  const mine = adviceText(facts({ cmd: 'kill', holder: holder({ session: { id: 'aaaa-1111', title: 't', alive: true } }) }));
  assert.match(mine, /이 세션이 띄움/);
  assert.doesNotMatch(mine, /다른 실행 중인 세션/);
});

test('port-advice query: checked, never guessed', () => {
  const at = (q: string) => parseAdviceQuery(new URL(`http://x/api/claude/port-advice?${q}`));
  assert.deepEqual(at('port=5173&cmd=kill&cwd=/tmp&tool=fuser%20-k&session=abc-1'), { ok: true, value: { port: 5173, cmd: 'kill', cwd: '/tmp', tool: 'fuser -k', session: 'abc-1' } });
  assert.deepEqual(at('port=5173'), { ok: true, value: { port: 5173, cmd: 'start', cwd: null, tool: null, session: null } });
  for (const bad of ['', 'port=0', 'port=70000', 'port=12a', 'port=80&cmd=stop', 'port=80&cwd=relative', 'port=80&session=a%20b']) assert.equal(at(bad).ok, false, bad);
});

test('worktreeOfCwd names the worktree as start_dev_server does (<main repo dir>@<branch>)', async () => {
  const wt = await worktreeOfCwd(`${ROOT}/src`);
  assert.ok(wt, 'the test checkout is a git worktree');
  assert.equal(wt.path, ROOT);
  assert.match(wt.owner, /^portboard(-[\w-]+)?@.+/);
  assert.equal(await worktreeOfCwd('/nonexistent/dir'), null);
  assert.equal(await worktreeOfCwd('relative'), null);
  assert.equal(await worktreeOfCwd('/'), null);
});

test('holderOf: a port nobody listens on has no holder; a process that is gone has no owner', async () => {
  const snap = { ports: [{ port: 3999, listening: true, name: 'ghost', processes: [{ pid: 2 ** 22 + 7, unit: null }], control: { type: 'process' }, container: null, owned: true, canStop: true, pinned: false }] } as unknown as Snapshot;
  assert.equal(await holderOf(snap, 4000), null);
  const h = await holderOf(snap, 3999);
  assert.equal(h?.name, 'ghost');
  assert.equal(h?.session, null);
  assert.deepEqual(h?.cleanupReasons, []);
});

test('GET /api/claude/port-advice is a read route: 400 on a bad query before touching the context', async () => {
  const r = REGISTRY.routes.find((x) => x.path === '/api/claude/port-advice');
  assert.equal(r?.method, 'GET');
  const route = createRouter(REGISTRY.routes);
  const untouchable = new Proxy({}, { get: (_t, k) => assert.fail(`handler touched ctx.${String(k)}`) }) as ServerContext;
  const res = await route({ method: 'GET', headers: {} } as any, new URL('http://x/api/claude/port-advice?port=nope'), untouchable);
  assert.deepEqual(res, { status: 400, body: { error: 'port must be 1–65535' } });
});

test("start advice names the worktree's launch.json port, and write_launch_config when it isn't the reserved one", () => {
  const here = { owner: 'shop-web@feat-x', path: '/home/dev/projects/shop-web-x', startable: true };
  const off = adviceText(facts({ here: { ...here, launchPort: 3000 } }));
  assert.match(off, /3000/);
  assert.match(off, /write_launch_config/);
  const same = adviceText(facts({ here: { ...here, launchPort: 3104 } }));
  assert.match(same, /3104/);
  assert.doesNotMatch(same, /write_launch_config/);
  assert.doesNotMatch(adviceText(facts()), /launch\.json/);
});
