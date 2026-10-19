// 메모리 (src/core/memory.ts, src/features/memory.ts): the /proc parsers, the grouping on a fake /proc
// (test/fixtures/memory/), the pressure state machine and its alert text, suggestions, the state file, and what the
// status resource may carry. Neutral names only: projects alpha/beta, user u.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classify,
  createSampler,
  DEFAULT_THRESHOLDS,
  digestLine,
  emptyPressure,
  memView,
  parseBtime,
  parseMeminfo,
  parsePsi,
  parseStat,
  parseState,
  parseThresholds,
  projectName,
  pressureMessage,
  pushHistory,
  scanTitle,
  sessionIdFromEnviron,
  statusLine,
  stepPressure,
  suggestions,
  useOf,
  versionCmp,
  type MemorySample,
  type PressureState,
  type ServiceRef,
} from '../src/core/memory.ts';
import { memoryReport, statusReport } from '../src/mcp/status.ts';
import { redactStatus } from '../src/remote/redact.ts';
import { toolSummary, viewOf } from '../src/features/memory.ts';
import { createFileReader, newSeen, summarize, type SessionRecord } from '../src/core/adoption.ts';

const FIX = new URL('./fixtures/memory/', import.meta.url).pathname;
const MIN = 60_000;
const HOUR = 60 * MIN;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const BTIME = 1792000000;

interface FakeProc {
  pid: number;
  ppid: number;
  comm: string;
  rss: number;
  start?: number;
  cpu?: number;
  argv: string[];
  environ?: string;
  cwd?: string;
}

const statLine = (p: FakeProc, cpuExtra = 0) => {
  // fields 3..24: state, ppid, 5–13, utime, stime, 16–21, starttime, vsize, rss (pages)
  const f = ['S', p.ppid, ...Array(9).fill(0), (p.cpu ?? 0) + cpuExtra, 0, ...Array(6).fill(0), (p.start ?? 0) * 100, 0, (p.rss * 1024) / 4, 0, 0];
  return `${p.pid} (${p.comm}) ${f.join(' ')}\n`;
};

/** The fixture as a /proc and a cgroup dir in a temp folder; cpu adds ticks per pid (for the second sample) */
async function fakeProc(cpu: Record<number, number> = {}) {
  const fx = JSON.parse(await readFile(join(FIX, 'procs.json'), 'utf8'));
  const dir = await mkdtemp(join(tmpdir(), 'pb-mem-'));
  const proc = join(dir, 'proc');
  await mkdir(join(proc, 'pressure'), { recursive: true });
  await writeFile(join(proc, 'meminfo'), await readFile(join(FIX, 'meminfo')));
  await writeFile(join(proc, 'pressure', 'memory'), await readFile(join(FIX, 'pressure-memory')));
  await writeFile(join(proc, 'stat'), await readFile(join(FIX, 'stat')));
  for (const p of fx.procs as FakeProc[]) {
    const d = join(proc, String(p.pid));
    await mkdir(d);
    await writeFile(join(d, 'stat'), statLine(p, cpu[p.pid] ?? 0));
    await writeFile(join(d, 'cmdline'), p.argv.length ? `${p.argv.join('\0')}\0` : '');
    if (p.environ) await writeFile(join(d, 'environ'), p.environ);
    if (p.cwd) await symlink(p.cwd, join(d, 'cwd'));
  }
  const cg = join(dir, 'cgroup');
  for (const c of fx.docker) {
    const d = join(cg, `docker-${c.id}.scope`);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'memory.current'), `${c.current}\n`);
    await writeFile(join(d, 'memory.stat'), `anon 1\ninactive_file ${c.inactive}\nactive_file 2\n`);
    await writeFile(join(d, 'cgroup.procs'), `${c.procs.join('\n')}\n`);
  }
  return { proc, cg };
}

const SERVICES: ServiceRef[] = [
  { name: 'vite', ports: [5173], pids: [207], unit: null, dev: true, unused: true },
  { name: 'dashboard', ports: [8790], pids: [600], unit: 'dashboard.service', dev: false, unused: false },
];

const T0 = (BTIME + 4000) * 1000;

/** A sampler over the fixture and its first sample (titles are in once titlesIdle resolves) */
async function firstSample() {
  const { proc, cg } = await fakeProc();
  const sampler = createSampler({
    root: proc,
    cgroupRoot: cg,
    dockerNames: async () => new Map([['aaaaaaaaaaaa', 'db_alpha']]),
    title: async (id: string) => (id === A ? 'Alpha work' : null),
    lastActive: async (id: string) => (id === A ? T0 - 2 * MIN : T0 - 3 * HOUR),
  });
  const s1 = await sampler.sample(SERVICES, DEFAULT_THRESHOLDS, T0);
  await sampler.titlesIdle();
  return { s1, sampler, proc };
}

// ---------- parsers ----------

test('parseStat: comm with spaces and parentheses, cputime, start, rss', () => {
  const s = parseStat('800 (next-server (v1) S 1 800 800 0 -1 4194304 1 0 0 0 1234 56 0 0 20 0 11 0 7000 100 2048 18446744073709551615\n');
  assert.deepEqual(s, { pid: 800, comm: 'next-server (v1', ppid: 1, cpuTicks: 1290, startTicks: 7000, rssKb: 8192 });
  assert.equal(parseStat('garbage'), null);
});

test('parseMeminfo / memView: used + cache + free add up to total; shmem is not reclaimable cache', async () => {
  const m = parseMeminfo(await readFile(join(FIX, 'meminfo'), 'utf8'));
  assert.equal(m.totalKb, 51200000);
  assert.equal(m.availableKb, 3000000);
  const v = memView(m);
  assert.deepEqual(v, { totalMb: 50000, usedMb: 47070, cacheMb: 1387, freeMb: 1543, availableMb: 2930, availablePct: 5.9, shmemMb: 7324, swapTotalMb: 4096, swapUsedMb: 4096, swapPct: 100 });
  assert.equal(v.usedMb + v.cacheMb + v.freeMb, v.totalMb);
  // an old kernel without MemAvailable: free + buffers + cached
  assert.equal(parseMeminfo('MemTotal: 100 kB\nMemFree: 10 kB\nBuffers: 5 kB\nCached: 20 kB\n').availableKb, 35);
});

test('parsePsi / parseBtime', async () => {
  assert.deepEqual(parsePsi(await readFile(join(FIX, 'pressure-memory'), 'utf8')), { some: { avg10: 3.37, avg60: 6.2, avg300: 4.1 }, full: { avg10: 2.79, avg60: 4, avg300: 3 } });
  assert.equal(parsePsi(''), null);
  assert.equal(parseBtime(await readFile(join(FIX, 'stat'), 'utf8')), BTIME);
});

test('sessionIdFromEnviron keeps the session id only, never the token next to it', () => {
  const raw = `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-SECRET\0CLAUDE_CODE_SESSION_ID=${A}\0HOME=/home/u`;
  assert.equal(sessionIdFromEnviron(raw), A);
  assert.equal(sessionIdFromEnviron('CLAUDE_CODE_SESSION_ID=not-a-uuid'), null);
  assert.equal(sessionIdFromEnviron('CLAUDE_CODE_OAUTH_TOKEN=x'), null);
});

test('classify: Claude CLIs, known MCP servers with their wrappers, other *mcp* packages only when asked', () => {
  assert.deepEqual(classify(['/home/u/.claude/remote/ccd-cli/2.1.299-686c67ec1014', '--verbose']), { kind: 'cli', version: '2.1.299' });
  assert.deepEqual(classify(['/home/u/.local/share/claude/versions/2.1.300/claude']), { kind: 'cli', version: '2.1.300' });
  assert.deepEqual(classify(['/home/u/.local/bin/claude', '-p']), { kind: 'cli', version: null });
  assert.deepEqual(classify(['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js']), { kind: 'cli', version: null });
  assert.deepEqual(classify(['npm', 'exec', 'rea-agents@6.7.0', 'mcp']), { kind: 'mcp', name: 'rea' });
  assert.deepEqual(classify(['sh', '-c', "'rea'", 'mcp']), { kind: 'mcp', name: 'rea' });
  assert.deepEqual(classify(['node', '/home/u/.npm/_npx/x/node_modules/.bin/rea', 'mcp']), { kind: 'mcp', name: 'rea' });
  assert.deepEqual(classify(['node', '/home/u/.npm/_npx/x/node_modules/.bin/rea', 'analyze']), { kind: 'proc' });
  assert.deepEqual(classify(['node', '/x/node_modules/@playwright/mcp/cli.js']), { kind: 'mcp', name: 'playwright' });
  assert.deepEqual(classify(['node', '/home/u/projects/portboard/src/mcp.ts']), { kind: 'mcp', name: 'portboard' });
  assert.deepEqual(classify(['node', '/home/u/.claude/plugins/cache/p/claude-plugin/bin/mcp.ts']), { kind: 'mcp', name: 'portboard' });
  assert.deepEqual(classify(['node', '/y/node_modules/some-mcp-server/dist/index.js']), { kind: 'proc' });
  assert.deepEqual(classify(['node', '/y/node_modules/some-mcp-server/dist/index.js'], true), { kind: 'mcp', name: 'some-mcp-server' });
  assert.deepEqual(classify(['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp'], true), { kind: 'mcp', name: '@modelcontextprotocol/server-filesystem' });
  assert.deepEqual(classify(['/bin/bash', '-c', 'npm test'], true), { kind: 'proc' });
  assert.deepEqual(classify(['uvx', 'thing', 'mcp'], true), { kind: 'proc' }, 'a bare "mcp" argument is not a package');
  assert.equal(projectName('/home/u/projects/alpha/src'), 'alpha');
  assert.equal(projectName('/home/u/projects/worktrees/alpha-fb15f20d5543d62b/brave-fox-e675b0'), 'alpha/brave-fox-e675b0');
  assert.equal(projectName('/home/u/projects/beta/.claude/worktrees/beta-12-x'), 'beta/beta-12-x');
  assert.equal(projectName('/srv/app'), '/srv/app');
  assert.equal(versionCmp('2.1.295', '2.1.299'), -1);
  assert.equal(versionCmp('2.10.0', '2.9.9'), 1);
  assert.equal(versionCmp('2.1.299', '2.1.299'), 0);
});

test('scanTitle: the last customTitle, across 1 MB chunk edges, then only what was appended; a rewritten file starts over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-title-'));
  const path = join(dir, 't.jsonl');
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  // the second title straddles the 1 MB boundary
  const pad = 'x'.repeat((1 << 20) - 40);
  await writeFile(path, line({ type: 'custom-title', customTitle: 'First' }) + line({ type: 'user', text: pad }).slice(0, (1 << 20) - 60) + '\n' + line({ type: 'custom-title', customTitle: '두 번째 "quoted"' }));
  const a = await scanTitle(path);
  assert.equal(a.title, '두 번째 "quoted"');
  const { appendFile, writeFile: wf } = await import('node:fs/promises');
  await appendFile(path, line({ type: 'assistant', text: 'no title here' }));
  const b = await scanTitle(path, a.size, a.title);
  assert.equal(b.title, '두 번째 "quoted"', 'nothing new: the previous title stays');
  assert.ok(b.size > a.size);
  await appendFile(path, line({ type: 'custom-title', customTitle: 'Third' }));
  assert.equal((await scanTitle(path, b.size, b.title)).title, 'Third');
  await wf(path, line({ type: 'user' }));
  assert.equal((await scanTitle(path, b.size + 100, 'Third')).title, null, 'shrank: read again from the start');
  assert.deepEqual(await scanTitle(join(dir, 'missing.jsonl'), 5, 'kept'), { title: 'kept', size: 5 });
});

// ---------- grouping on the fake /proc ----------

test('sample: the partition counts every process once and adds up to all RSS', async () => {
  const { s1 } = await firstSample();
  const g = Object.fromEntries(s1.groups.map((x) => [x.key, x.mb]));
  assert.deepEqual(g, { claude: 613, mcp: 702, services: 340, docker: 100, other: 900 });
  assert.equal(s1.rssMb, 2655);
  assert.equal(Object.values(g).reduce((a, b) => a + b, 0), s1.rssMb);
  assert.ok(!s1.groups.some((x) => x.procs === 0 && x.mb > 0));
});

test('sample: MCP servers summed across sessions, wrappers folded into one instance, the ones left behind counted', async () => {
  const { s1 } = await firstSample();
  assert.deepEqual(
    s1.mcp.map((m) => [m.name, m.instances, m.mb, m.orphans, m.sessions, m.procs]),
    [
      ['rea', 2, 462, 1, 1, 4],
      ['playwright', 2, 150, 0, 2, 2],
      ['portboard', 1, 60, 0, 1, 1],
      ['some-mcp-server', 1, 30, 0, 1, 1],
    ],
  );
  assert.equal(s1.mcp[0].label, 'rea');
});

test('sample: sessions with their whole tree, id from a child, version, helper, project, uptime; idle needs two samples', async () => {
  const { s1, sampler, proc } = await firstSample();
  const [alpha, beta, helper] = s1.sessions;
  assert.deepEqual([alpha.pid, beta.pid, helper.pid], [200, 300, 400]);
  assert.equal(alpha.id, A, 'from the playwright child (the CLI itself has no CLAUDE_CODE_SESSION_ID)');
  assert.equal(alpha.mb, 855);
  assert.deepEqual(alpha.breakdown, { cli: 300, mcp: 402, servers: 150, tools: 3 });
  assert.deepEqual(alpha.mcp, ['playwright', 'portboard', 'rea']);
  assert.equal(alpha.project, 'alpha');
  assert.equal(alpha.version, '2.1.299');
  assert.equal(alpha.stale, false);
  assert.equal(alpha.uptimeSec, 3000);
  assert.equal(alpha.title, null, 'titles come from the background queue, after the first sample');
  assert.equal(alpha.idle, null, 'no CPU history yet');
  assert.equal(beta.id, B);
  assert.equal(beta.version, '2.1.295');
  assert.equal(beta.stale, true);
  assert.equal(s1.newestVersion, '2.1.299');
  assert.equal(helper.helper, true);
  assert.equal(helper.id, A, 'a helper fork names its session in --resume');

  // a minute later: alpha's CLI used a whole core, beta nothing and its transcript is 3 h old
  const fx = JSON.parse(await readFile(join(FIX, 'procs.json'), 'utf8'));
  await writeFile(join(proc, '200', 'stat'), statLine(fx.procs.find((p: FakeProc) => p.pid === 200), 6000));
  const s2 = await sampler.sample(SERVICES, DEFAULT_THRESHOLDS, T0 + MIN);
  const a2 = s2.sessions.find((x) => x.pid === 200)!;
  const b2 = s2.sessions.find((x) => x.pid === 300)!;
  assert.equal(a2.cpuPct, 100);
  assert.equal(a2.idle, false);
  assert.equal(a2.title, 'Alpha work');
  assert.equal(b2.cpuPct, 0);
  assert.equal(b2.idleMin, 181);
  assert.equal(b2.idle, true);
  const vite = s2.services.find((x) => x.name === 'vite')!;
  assert.equal(vite.session, 'Alpha work');
  assert.equal(vite.mb, 150);
  assert.equal(s2.docker[0].name, 'db_alpha');
  assert.equal(s2.docker[0].mb, 100);
  assert.deepEqual(s2.other.map((o) => o.name), ['next-server (v1', 'server']);
});

test('nothing from an environment (the OAuth token) or a full command line ends up in the sample or the tool answer', async () => {
  const { s1 } = await firstSample();
  const text = JSON.stringify(s1);
  assert.ok(!text.includes('SECRET'));
  assert.ok(!text.includes('--allowedTools'));
  const view = viewOf(s1, { version: 1, pressure: emptyPressure(), history: [], view: null }, DEFAULT_THRESHOLDS, null);
  const tool = JSON.stringify(toolSummary(view));
  assert.ok(!tool.includes('SECRET') && !tool.includes('/home/u'));
});

// ---------- pressure ----------

const LOW = { availablePct: 5, swapPct: 50, swapTotalMb: 4096, psiSome60: 1 };
const OK = { availablePct: 30, swapPct: 20, swapTotalMb: 4096, psiSome60: 0.5 };

function run(steps: { at: number; s: typeof LOW }[], th = DEFAULT_THRESHOLDS) {
  let st: PressureState | undefined;
  const events: [number, string][] = [];
  for (const { at, s } of steps) {
    const r = stepPressure(st, s, at, th);
    st = r.next;
    if (r.event) events.push([at, r.event]);
  }
  return { st: st!, events };
}

const every = (from: number, to: number, s: typeof LOW, step = MIN) => {
  const out: { at: number; s: typeof LOW }[] = [];
  for (let t = from; t <= to; t += step) out.push({ at: t, s });
  return out;
};

test('stepPressure: a breach must last sustainMin, then one warning; reminders every reminderHours; recovery after a clear sustainMin', () => {
  const { events, st } = run([...every(0, 4 * MIN, LOW), ...every(5 * MIN, 7 * HOUR, LOW), ...every(7 * HOUR + MIN, 7 * HOUR + 10 * MIN, OK)]);
  assert.deepEqual(events, [
    [5 * MIN, 'warn'],
    [5 * MIN + 6 * HOUR, 'remind'],
    [7 * HOUR + 6 * MIN, 'recover'],
  ]);
  assert.equal(st.active, false);
  assert.equal(st.breachSince, null, 'a new breach after recovery starts its own clock');
});

test('stepPressure: a short dip, a hovering value and a gap in sampling do not alert or recover', () => {
  // 3 minutes low, then fine: nothing
  assert.deepEqual(run([...every(0, 3 * MIN, LOW), ...every(4 * MIN, 20 * MIN, OK)]).events, []);
  // active, then hovering just above the threshold (10.5 % < 10 + 2 margin): no recovery
  const hover = { ...OK, availablePct: 10.5 };
  assert.deepEqual(run([...every(0, 10 * MIN, LOW), ...every(11 * MIN, 60 * MIN, hover)]).events, [[5 * MIN, 'warn']]);
  // 4 minutes low, the server is down for an hour, 2 minutes low: the run starts again
  assert.deepEqual(run([...every(0, 4 * MIN, LOW), ...every(64 * MIN, 66 * MIN, LOW)]).events, []);
  // swap and PSI count too; no swap at all is not "swap full"
  assert.deepEqual(run(every(0, 5 * MIN, { ...OK, swapPct: 95 })).events, [[5 * MIN, 'warn']]);
  assert.deepEqual(run(every(0, 5 * MIN, { ...OK, psiSome60: 6 })).events, [[5 * MIN, 'warn']]);
  assert.deepEqual(run(every(0, 10 * MIN, { ...OK, swapPct: 100, swapTotalMb: 0 })).events, []);
});

test('pressureMessage: sizes and names only, the idle sessions hint, and a recovery with its length', async () => {
  const { s1 } = await firstSample();
  const idle = { ...s1, sessions: s1.sessions.map((x) => (x.pid === 300 ? { ...x, idle: true } : x)) };
  const warn = pressureMessage('warn', idle, T0 - 10 * MIN, T0, 'host-a');
  assert.equal(warn.key, 'memory:pressure');
  assert.equal(warn.kind, 'warning');
  assert.equal(warn.high, true);
  assert.match(warn.title, /host-a is low on memory/);
  assert.match(warn.body, /for 10 min: available 2\.9 GB of 48\.8 GB \(5\.9%\), swap 100% used, PSI some avg60 6\.2/);
  assert.match(warn.body, /rea 0\.5 GB ×2/);
  assert.match(warn.body, /1 idle Claude sessions hold 0\.3 GB: archive them in the Claude app/);
  assert.ok(!/\/home|projects/.test(warn.body));
  assert.match(pressureMessage('remind', s1, null, T0, 'host-a').title, /\(still\)/);
  const up = pressureMessage('recover', s1, T0 - 2 * HOUR, T0, 'host-a');
  assert.equal(up.kind, 'recovered');
  assert.match(up.body, /after 2 h 0 min/);
});

// ---------- suggestions, thresholds, state ----------

test('suggestions: idle sessions, stale CLIs, per-session MCP servers (확인 전 without counts), long-idle dev servers with the cleanup link', async () => {
  const { s1 } = await firstSample();
  const s: MemorySample = {
    ...s1,
    sessions: s1.sessions.map((x) => (x.pid === 300 ? { ...x, idle: true } : x)),
    mcp: [{ name: 'rea', label: 'rea', instances: 6, mb: 1500, orphans: 0, sessions: 6, procs: 18 }],
    services: s1.services.map((x) => (x.name === 'vite' ? { ...x, uptimeSec: 30 * 3600 } : x)),
  };
  const none = suggestions(s, DEFAULT_THRESHOLDS, null);
  assert.deepEqual(none.map((x) => x.kind), ['mcp-unused', 'idle-sessions', 'stale-cli', 'dev-idle']);
  assert.match(none[0].text, /확인 전/);
  assert.match(none[1].text, /쉬는 세션 1개가 0\.3 GB.*Claude 앱에서 보관/);
  assert.match(none[2].text, /구버전 CLI\(2\.1\.295\) 세션 1개/);
  assert.equal(none[3].href, './#ownersBanner');
  assert.match(none[3].text, /vite :5173/);
  // with counts: rarely used → suggested; used by most sessions → not
  const rare = { days: 7, sessions: 100, servers: { rea: { calls: 9, sessions: 3 } } };
  assert.match(suggestions(s, DEFAULT_THRESHOLDS, rare)[0].text, /지난 7일 Claude 세션 100개 중 3개만 썼어요 \(호출 9번\)/);
  const used = { days: 7, sessions: 100, servers: { rea: { calls: 900, sessions: 60 } } };
  assert.ok(!suggestions(s, DEFAULT_THRESHOLDS, used).some((x) => x.kind === 'mcp-unused'));
  // a tool name's server segment names the row: plugin_portboard_portboard → portboard
  assert.deepEqual(useOf({ days: 7, sessions: 5, servers: { plugin_portboard_portboard: { calls: 4, sessions: 2 }, playwright: { calls: 1, sessions: 1 } } }, 'portboard'), { calls: 4, sessions: 2 });
  assert.deepEqual(useOf({ days: 7, sessions: 5, servers: { playwright: { calls: 1, sessions: 1 } } }, 'playwright'), { calls: 1, sessions: 1 });
});

test('parseThresholds: defaults, and each key in range or the default', () => {
  assert.deepEqual(parseThresholds(null), DEFAULT_THRESHOLDS);
  assert.deepEqual(parseThresholds({ availablePct: 15, psiSome60: 'x', swapPct: 500, sustainMin: 2, extra: 1 }), { ...DEFAULT_THRESHOLDS, availablePct: 15, sustainMin: 2 });
});

test('state file: parse with defaults, history window, status line only while fresh; the digest line', async () => {
  const { s1 } = await firstSample();
  const { cpu: _c, ...view } = s1;
  assert.deepEqual(parseState('nope'), { version: 1, pressure: emptyPressure(), history: [], view: null });
  const f = parseState(JSON.stringify({ version: 1, pressure: { active: true, reasons: ['available', 'swap'] }, history: [{ t: 1 }, { bad: 1 }], view }));
  assert.equal(f.history.length, 1);
  assert.deepEqual(statusLine(f, T0 + MIN), { at: new Date(T0).toISOString(), pressure: true, reasons: ['available', 'swap'], availablePct: 5.9, swapPct: 100, psiSome60: 6.2 });
  assert.equal(statusLine(f, T0 + 10 * MIN), null, 'the server stopped sampling');
  let h: ReturnType<typeof pushHistory> = [];
  for (let i = 0; i < 70; i++) h = pushHistory(h, { t: i * MIN, availablePct: i, swapPct: 0, psi60: null, claudeMb: 0, mcpMb: 0 });
  assert.equal(h.length, 60);
  assert.equal(h[0].availablePct, 10);
  const line = digestLine(s1, f.pressure, [])!;
  assert.equal(line.problem, true);
  assert.match(line.text, /^🧠 메모리 사용 가능 2\.9 GB\/48\.8 GB \(5\.9%\) · 스왑 100% · 부족 알림 중/);
});

test('portboard://status memory line: rebuilt field by field, locally and remotely', () => {
  const m = { at: '2026-10-19T00:00:00.000Z', pressure: true, reasons: ['swap', 'evil' as never], availablePct: 7.5, swapPct: 99, psiSome60: 3, cmdline: '/home/u/x' } as never;
  assert.deepEqual(memoryReport(m), { pressure: true, reasons: ['swap'], availablePct: 7.5, swapPct: 99, psiSome60: 3, at: '2026-10-19T00:00:00.000Z' });
  const local = statusReport({ at: 'now', ports: null, devices: null, usage: null, watching: null, newDevices: null, memory: null });
  assert.equal(local.memory, null);
  assert.ok(local.unavailable.includes('memory'));
  const remote = redactStatus({ at: 'now', snap: null, devices: null, usage: null, extras: { watching: null, newDevices: null, memory: m } });
  assert.deepEqual((remote as any).memory, memoryReport(m));
  assert.ok(!JSON.stringify(remote).includes('/home/u'));
  // without the field (an older remote state) the section is left out
  assert.equal('memory' in redactStatus({ at: 'now', snap: null, devices: null, usage: null, extras: { watching: null, newDevices: null } }), false);
});

// ---------- adoption: calls per MCP server ----------

test('adoption counts tool calls per MCP server, and says so only for scans that counted them', () => {
  const session: SessionRecord = { dir: '-home-u-projects-alpha', project: 'alpha', subagents: 0, days: {} };
  const r = createFileReader(session, newSeen(), '2026-10-01', '2026-10-31');
  const use = (id: string, name: string) => ({ type: 'assistant', timestamp: '2026-10-18T03:00:00Z', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
  r.record(use('t1', 'mcp__rea__open_binary'));
  r.record(use('t2', 'mcp__rea__close_binary'));
  r.record(use('t3', 'mcp__plugin_portboard_portboard__list_ports'));
  r.record(use('t3', 'mcp__plugin_portboard_portboard__list_ports'));
  r.record(use('t4', 'Bash'));
  const sum = summarize([session], '2026-10-01', '2026-10-31');
  assert.deepEqual(sum.mcpServers, { rea: { calls: 2, sessions: 1 }, plugin_portboard_portboard: { calls: 1, sessions: 1 } });
  // a scan from before the count (days without mcpServers): null, not "never used"
  const old: SessionRecord = { ...session, days: { '2026-10-18': { ...session.days['2026-10-18'], mcpServers: undefined } } };
  assert.equal(summarize([old], '2026-10-01', '2026-10-31').mcpServers, null);
});
