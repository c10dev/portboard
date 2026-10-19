// 채택 지표 (#40): the command classifier, the transcript reader (dedupe, KST days, nudges), the scan over fixture
// transcripts (test/fixtures/adoption, synthetic) and that nothing a transcript said comes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adoptionLine,
  classifyCommand,
  createFileReader,
  dayMinus,
  feedBytes,
  feedLine,
  isNudge,
  kstDate,
  newSeen,
  parseScan,
  portboardTool,
  projectOf,
  readLines,
  scanTranscripts,
  stripHeredocs,
  summarize,
  viewOf,
  type SessionRecord,
} from '../src/core/adoption.ts';
import { buildDigest } from '../src/core/digest.ts';
import { L } from './fixtures/locale.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/adoption/', import.meta.url));
const NOW = Date.parse('2026-10-18T06:00:00Z'); // 15:00 KST

const kind = (cmd: string) => {
  const h = classifyCommand(cmd);
  return { inspect: h.inspect, kill: h.kill, hardcoded: h.hardcoded, ports: h.ports };
};

test('classifyCommand: raw port inspection', () => {
  for (const cmd of ['ss -ltnp', 'ss -tlnp | grep 3001', 'sudo ss -ltnpH', 'ss -H -ltn', 'lsof -i :3000', 'lsof -nP -iTCP:5173 -sTCP:LISTEN', 'netstat -tlnp', 'fuser 3001/tcp', 'cd x && ss -ltn | head', 'watch -n 1 ss -ltn', 'echo $(ss -ltn | wc -l)']) {
    const h = classifyCommand(cmd);
    assert.equal(h.inspect, true, cmd);
    assert.equal(h.kill, false, cmd);
  }
  assert.deepEqual(kind('ss -ltnp | grep 3001'), { inspect: true, kill: false, hardcoded: [], ports: [3001] });
  assert.deepEqual(kind('lsof -i :3000'), { inspect: true, kill: false, hardcoded: [], ports: [3000] });
  assert.deepEqual(kind("ss -ltn '( sport = :8790 )'"), { inspect: true, kill: false, hardcoded: [], ports: [8790] });
  assert.deepEqual(kind('lsof -iTCP:5173 -sTCP:LISTEN'), { inspect: true, kill: false, hardcoded: [], ports: [5173] });
  // a grep prefix (":30" for 30xx) and ssh's port are not ports anyone started
  assert.deepEqual(kind("ss -ltn | grep ':30'").ports, []);
});

test('classifyCommand: kill by port is kill, not also inspect', () => {
  for (const cmd of ['fuser -k 3001/tcp', 'kill $(lsof -t -i:3000)', 'kill -9 `lsof -ti :3000`', "ss -ltnp | grep 3001 | awk '{print $6}' | xargs kill", 'lsof -t -i:5195 | xargs -r kill -9', 'npx kill-port 3000 3001', 'sudo kill $(sudo ss -ltnp | grep 3001)']) {
    const h = classifyCommand(cmd);
    assert.equal(h.kill, true, cmd);
    assert.equal(h.inspect, false, cmd);
  }
  assert.deepEqual(kind('npx kill-port 3000 3001').ports, [3000, 3001]);
  assert.deepEqual(kind('fuser -k 3001/tcp').ports, [3001]);
});

test('classifyCommand: servers started on a hard-coded port', () => {
  assert.deepEqual(kind('PORT=3001 npm run dev').hardcoded, [3001]);
  assert.deepEqual(kind('export PORT=3002; npm start').hardcoded, [3002]);
  assert.deepEqual(kind('env PORT=3003 nohup node server.js &').hardcoded, [3003]);
  assert.deepEqual(kind('PORTBOARD_PORT=8801 node src/server.ts').hardcoded, [8801]);
  assert.deepEqual(kind('npx vite --port 5195 --host').hardcoded, [5195]);
  assert.deepEqual(kind('npm run dev -- --port=5191').hardcoded, [5191]);
  assert.deepEqual(kind('next dev -p 3005').hardcoded, [3005]);
  assert.deepEqual(kind('./node_modules/.bin/astro dev -p 4321').hardcoded, [4321]);
  assert.deepEqual(kind('npx serve -p 8080 dist').hardcoded, [8080]);
  assert.deepEqual(kind('python3 -m http.server 8000').hardcoded, [8000]);
  assert.deepEqual(kind('fuser -k 3001/tcp; PORT=3001 npm run dev'), { inspect: false, kill: true, hardcoded: [3001], ports: [3001] });
  // not starts: -p of other programs, clients taking a port, a port variable that isn't a number, port 0
  for (const cmd of ['mkdir -p 3001', 'ssh -p 2222 host', 'psql --port 5432', 'curl localhost:3001', 'docker ps -p', 'PORT=$PORT npm run dev', 'vite --port 0', 'grep -- --port 3001 notes', 'git log -p 3001']) {
    assert.deepEqual(kind(cmd).hardcoded, [], cmd);
  }
  assert.deepEqual(classifyCommand('npx vite --port 5195').prefixes, ['vite --port']);
  assert.deepEqual(classifyCommand('PORT=3001 npm run dev').prefixes, ['PORT= npm']);
});

test('classifyCommand: heredoc bodies are text, not commands', () => {
  const cmd = "cat > notes.md <<'EOF'\nss -ltnp\nPORT=4444 npm start\nkill $(lsof -t -i:1)\nEOF\nls";
  assert.equal(stripHeredocs(cmd), 'cat > notes.md <<EOF\n\nls');
  assert.deepEqual(kind(cmd), { inspect: false, kill: false, hardcoded: [], ports: [] });
  // an unterminated heredoc swallows the rest
  assert.deepEqual(kind('cat <<EOF\nss -ltn'), { inspect: false, kill: false, hardcoded: [], ports: [] });
});

test('prefixes are a command word and a flag, never arguments', () => {
  const h = classifyCommand('cd /home/me/secret-dir && SECRET_TOKEN=abc PORT=3001 /home/me/secret-dir/bin/start --token xyz');
  assert.deepEqual(h.hardcoded, [3001]);
  for (const p of h.prefixes) assert.doesNotMatch(p, /secret|abc|xyz|token/i, p);
});

test('projectOf, portboardTool, kstDate', () => {
  assert.equal(projectOf('-home-dev-projects-portboard'), 'portboard');
  assert.equal(projectOf('-home-dev-projects-acme--claude-worktrees-acme-135-mcc-inspector-mcc'), 'acme');
  assert.equal(projectOf('-home-dev-projects-worktrees-webapp-1a2b3c4d-app-541-codex-gate-9f8e7d6c'), 'webapp');
  assert.equal(projectOf('-home-dev-projects'), 'projects');
  assert.equal(projectOf('-home-c10'), '~');
  assert.equal(projectOf('-tmp-claude-1000--home-dev-projects-acme-abc-scratchpad'), 'tmp');
  assert.equal(portboardTool('mcp__portboard__list_ports'), 'list_ports');
  assert.equal(portboardTool('mcp__plugin_portboard_portboard__free_port'), 'free_port');
  assert.equal(portboardTool('mcp__playwright__browser_click'), null);
  assert.equal(portboardTool('Bash'), null);
  assert.equal(kstDate(Date.parse('2026-10-17T14:59:59Z')), '2026-10-17');
  assert.equal(kstDate(Date.parse('2026-10-17T15:00:00Z')), '2026-10-18');
  assert.equal(dayMinus('2026-10-01', 1), '2026-09-30');
});

test('isNudge: hook context with the marker; a tool result only when it is a hook denial', () => {
  const att = (type: string, content: unknown, extra = {}) => ({ type: 'attachment', uuid: 'u', attachment: { type, content, toolUseID: 't', hookEvent: 'PreToolUse', ...extra } });
  assert.equal(isNudge(att('hook_additional_context', ['[portboard] use free_port'])), 't:PreToolUse');
  assert.equal(isNudge(att('hook_system_message', '[portboard] use free_port')), 't:PreToolUse');
  assert.equal(isNudge(att('hook_success', '', { stdout: '{"additionalContext":"[portboard] x"}' })), 't:PreToolUse');
  assert.equal(isNudge(att('hook_additional_context', ['something else'])), null);
  assert.equal(isNudge(att('prompt_snapshot', '[portboard] in a system prompt')), null);
  const result = (content: unknown, is_error?: boolean) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content, is_error }] } });
  assert.equal(isNudge(result([{ type: 'text', text: '[portboard] blocked' }], true)), 'x:result');
  assert.equal(isNudge(result('[portboard] printed by a manual hook test')), null);
  assert.equal(isNudge(result('Exit code 1\n[portboard] x', true)), null);
  assert.equal(isNudge({ type: 'system', uuid: 'v', hookAdditionalContext: ['[portboard] x'] }), 'u:v');
  assert.equal(isNudge({ type: 'user', message: { content: '[portboard] typed by the user' } }), null);
});

test('reader: one tool_use id counts once, days are KST, records outside the window are ignored', () => {
  const s: SessionRecord = { dir: 'd', project: 'p', subagents: 0, days: {} };
  const seen = newSeen();
  const r = createFileReader(s, seen, '2026-10-17', '2026-10-18');
  const a = (ts: string, blocks: unknown[]) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: blocks } });
  const ss = { type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'ss -ltn' } };
  feedLine(r, a('2026-10-17T14:00:00Z', [ss]));
  feedLine(r, a('2026-10-17T14:00:00Z', [ss]));
  feedLine(r, a('2026-10-17T15:30:00Z', [{ type: 'text', text: 'hi' }]));
  feedLine(r, a('2026-10-10T00:00:00Z', [{ type: 'tool_use', id: 'x2', name: 'mcp__portboard__list_ports', input: {} }]));
  feedLine(r, '{"type":"assistant","timestamp":"2026-10-1');
  assert.deepEqual(Object.keys(s.days).sort(), ['2026-10-17', '2026-10-18']);
  assert.equal(s.days['2026-10-17'].inspect, 1);
  assert.equal(s.days['2026-10-17'].tools, 1);
  assert.equal(s.days['2026-10-18'].tools, 0);
  // the same id in another file of the same scan (a resumed session's copy) still counts once
  const r2 = createFileReader({ dir: 'd', project: 'p', subagents: 0, days: {} }, seen, '2026-10-17', '2026-10-18');
  r2.record(JSON.parse(a('2026-10-17T14:00:00Z', [ss])));
  assert.equal(s.days['2026-10-17'].inspect, 1);
});

test('readLines: lines across reads, CRLF, a last line without newline, U+2028 inside a line, a too-long line skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-lines-'));
  try {
    const path = join(dir, 't.jsonl');
    const long = 'x'.repeat(100);
    // U+2028 is valid unescaped in JSON; readline used to split the line there
    writeFileSync(path, `{"a":1}\r\n{"b":"two\u2028lines"}\n\n${long}\n{"c":"${'y'.repeat(40)}"}\n{"torn":`);
    const lines: string[] = [];
    // an 8-byte first buffer has to grow (and compact) many times; lines over 64 bytes are dropped whole
    const lb = { buf: Buffer.alloc(8) };
    await readLines(path, (b) => lines.push(b.toString('utf8')), lb, 64);
    assert.deepEqual(lines, ['{"a":1}', '{"b":"two\u2028lines"}', '', `{"c":"${'y'.repeat(40)}"}`, '{"torn":']);
    assert.equal(lb.buf.length, 64, 'the buffer grows up to the cap, not past it');
    const all: string[] = [];
    await readLines(path, (b) => all.push(b.toString('utf8')));
    assert.equal(all[3], long);
    await readLines(join(dir, 'gone.jsonl'), () => assert.fail('no lines from a missing file'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feedBytes decides like feedLine: parsed tool_use and marker lines, a timestamp for other assistant lines', () => {
  const a = (ts: string, blocks: unknown[]) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: blocks } });
  const lines = [
    a('2026-10-17T14:00:00Z', [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'lsof -i :3000 # 한글' } }]),
    a('2026-10-17T15:30:00Z', [{ type: 'text', text: 'hi' }]),
    JSON.stringify({ type: 'user', timestamp: '2026-10-18T01:00:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'x'.repeat(1000) }] } }),
    JSON.stringify({ type: 'attachment', timestamp: '2026-10-18T02:00:00Z', attachment: { type: 'hook_additional_context', content: ['[portboard] use free_port'] }, toolUseID: 't9' }),
    '{"type":"assistant","timestamp":"2026-10-1',
    '{"type":"assistant","timestamp":"',
  ];
  const run = (feed: (r: ReturnType<typeof createFileReader>, l: string) => void) => {
    const s: SessionRecord = { dir: 'd', project: 'p', subagents: 0, days: {} };
    const r = createFileReader(s, newSeen(), '2026-10-17', '2026-10-18');
    for (const l of lines) feed(r, l);
    return s;
  };
  const viaBytes = run((r, l) => feedBytes(r, Buffer.from(l)));
  assert.deepEqual(viaBytes, run(feedLine));
  assert.equal(viaBytes.days['2026-10-17'].inspect, 1);
});

async function fixtureScan() {
  const root = mkdtempSync(join(tmpdir(), 'pb-adoption-'));
  cpSync(FIXTURES, root, { recursive: true });
  const old = new Date('2026-09-01T00:00:00Z');
  utimesSync(join(root, '-home-dev-projects-old', '33333333-3333-3333-3333-333333333333.jsonl'), old, old);
  try {
    return await scanTranscripts({ root, days: 14, now: NOW });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('scanTranscripts over the fixtures: sessions, subagents folded in, every count', async () => {
  const scan = await fixtureScan();
  assert.equal(scan.from, '2026-10-05');
  assert.equal(scan.to, '2026-10-18');
  assert.deepEqual({ read: scan.files.read, skipped: scan.files.skipped, subagents: scan.files.subagents }, { read: 3, skipped: 1, subagents: 1 });
  const s = summarize(scan.sessions, '2026-10-12', '2026-10-18');
  assert.deepEqual(s.totals, { sessions: 2, tools: 15, shell: 12, mcp: 3, inspect: 4, kill: 2, hardcoded: 4, nudges: 3, followed: 1 });
  assert.deepEqual(s.byDay.filter((d) => d.sessions).map((d) => [d.day, d.sessions, d.tools]), [['2026-10-17', 1, 4], ['2026-10-18', 2, 11]]);
  assert.equal(s.byDay.length, 7);
  assert.deepEqual(s.byProject.map((p) => [p.project, p.sessions, p.mcp, p.nudges, p.dirs]), [
    ['acme', 1, 2, 3, ['-home-dev-projects-acme--claude-worktrees-acme-9-x']],
    ['shop-web', 1, 1, 0, ['-home-dev-projects-shop-web']],
  ]);
  assert.deepEqual(s.topPorts, [
    { port: 3001, start: 1, inspect: 1, kill: 1, total: 3 },
    { port: 3005, start: 1, inspect: 1, kill: 0, total: 2 },
    { port: 5195, start: 1, inspect: 0, kill: 1, total: 2 },
    { port: 8801, start: 1, inspect: 0, kill: 0, total: 1 },
  ]);
  assert.deepEqual(s.mcpTools, { free_port: 1, list_ports: 1, list_dev_servers: 1 });
  const acme = scan.sessions.find((x) => x.project === 'acme')!;
  assert.equal(acme.subagents, 1);
});

test('nothing a transcript said comes out of a scan, only counts, dirs, ports and prefixes', async () => {
  const scan = await fixtureScan();
  const out = JSON.stringify([scan, viewOf(scan, 7)]);
  assert.doesNotMatch(out, /SECRET/);
  assert.doesNotMatch(out, /1111111|2222222/, 'no session ids');
  assert.doesNotMatch(out, /9999|4444/, 'no port only mentioned in a prompt or a heredoc');
});

test('viewOf: this window and the one before, when the scan reaches back that far', async () => {
  const scan = await fixtureScan();
  const v = viewOf(scan, 7);
  assert.equal(v.current?.from, '2026-10-12');
  assert.equal(v.previous?.from, '2026-10-05');
  assert.equal(v.previous?.totals.sessions, 0);
  assert.equal(viewOf(scan, 8).previous, null);
  assert.equal(viewOf(scan, 15).current, null);
  assert.deepEqual(viewOf(null, 7), { at: null, scanning: false, tookMs: null, days: 7, current: null, previous: null, files: null });
  assert.deepEqual(parseScan(JSON.stringify(scan)), scan);
  assert.equal(parseScan('{"version":2}'), null);
  assert.equal(parseScan('not json'), null);
});

test('adoptionLine, and the digest shows it as an info line', () => {
  const t = (mcp: number, inspect: number, kill: number, hardcoded: number, nudges = 0) => ({ sessions: 20, tools: 0, shell: 0, mcp, inspect, kill, hardcoded, nudges, followed: 0 });
  assert.equal(adoptionLine(t(14, 100, 10, 300), t(4, 120, 10, 300)), L('🤖 Claude 세션 20개 포트 사용: Portboard MCP 14(+10) · 직접 조회·종료 110(−20) · 고정 포트 300', '🤖 Port use in 20 Claude sessions: Portboard MCP 14(+10) · direct lookups/kills 110(−20) · hard-coded ports 300'));
  assert.equal(adoptionLine(t(1, 2, 0, 3, 5), null), L('🤖 Claude 세션 20개 포트 사용: Portboard MCP 1 · 직접 조회·종료 2 · 고정 포트 3 · 안내 5', '🤖 Port use in 20 Claude sessions: Portboard MCP 1 · direct lookups/kills 2 · hard-coded ports 3 · 5 hints'));
  const input = { watching: [], uptime: { version: 1 as const, ports: {} }, known: null, cleanup: [{ port: 3001, name: 'vite' }], worktrees: null, selfwatch: null, history: null, adoption: { current: t(1, 2, 0, 3), previous: null } };
  const d = buildDigest(input, 'weekly', { from: NOW - 7 * 86_400_000, to: NOW }, NOW);
  const line = d.lines.find((l) => l.text.startsWith('🤖'));
  assert.ok(line && !line.problem, 'an info line');
  assert.ok(d.body.includes(L('🤖 Claude 세션 20개', '🤖 Port use in 20 Claude sessions')));
  // without the source the digest is as before
  const { adoption: _a, ...without } = input;
  assert.ok(!buildDigest(without, 'weekly', { from: NOW - 7 * 86_400_000, to: NOW }, NOW).body.includes('🤖'));
});

test('store: scans when there is no cache or it is a day old, saves it, shares a running scan', async () => {
  const { createAdoptionStore, STALE_MS } = await import('../src/features/adoption.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pb-adoption-store-'));
  let t = NOW;
  let scans = 0;
  const fake = async (o: { days: number; now?: number }) => {
    scans++;
    assert.equal(o.days, 15);
    return { version: 1 as const, at: new Date(o.now!).toISOString(), from: dayMinus(kstDate(o.now!), 14), to: kstDate(o.now!), tookMs: 1, files: { read: 0, skipped: 0, bytes: 0, subagents: 0 }, sessions: [] };
  };
  try {
    const path = join(dir, 'adoption.json');
    const s = createAdoptionStore({ path, now: () => t, scan: fake });
    assert.equal(await s.load(), null);
    const [a, b] = await Promise.all([s.refresh(), s.refresh()]);
    assert.equal(scans, 1, 'one scan at a time');
    assert.equal(a, b);
    assert.equal(await s.refreshIfStale(), 'fresh');
    // a new process reads the file
    const s2 = createAdoptionStore({ path, now: () => t, scan: fake });
    assert.equal((await s2.load())?.at, new Date(NOW).toISOString());
    t = NOW + STALE_MS + 1;
    assert.equal(await s.refreshIfStale(), 'scanned');
    assert.equal(scans, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adoption_stats: validates days, answers from the core, says when there is no scan yet', async () => {
  const { callTool } = await import('../src/mcp/tools.ts');
  const scan = await fixtureScan();
  const asked: unknown[] = [];
  const core = { adoption: async (days: number, refresh?: boolean) => (asked.push([days, refresh]), viewOf(scan, days)) } as any;
  const r = JSON.parse((await callTool('adoption_stats', {}, core)).content[0].text);
  assert.deepEqual(r.window, { from: '2026-10-12', to: '2026-10-18' });
  assert.equal(r.totals.mcp, 3);
  assert.equal(r.previous.totals.sessions, 0);
  assert.equal(r.byProject[0].dirs, undefined, 'no dir list in the MCP answer');
  await callTool('adoption_stats', { days: 3, refresh: true }, core);
  assert.deepEqual(asked, [[7, false], [3, true]]);
  assert.equal((await callTool('adoption_stats', { days: 8 }, core)).isError, true);
  assert.equal((await callTool('adoption_stats', { days: 1.5 }, core)).isError, true);
  const none = JSON.parse((await callTool('adoption_stats', {}, { adoption: async () => viewOf(null, 7) } as any)).content[0].text);
  assert.equal(none.message, 'no scan yet');
});

test('GET /api/adoption: bad days is 400', async () => {
  const { adoptionFeature } = await import('../src/features/adoption.ts');
  const route = adoptionFeature.routes![0];
  const r = await route.handler({ url: new URL('http://x/api/adoption?days=30'), params: { port: 0, device: '' }, body: null, req: {} as any }, {} as any);
  assert.equal(r.status, 400);
});
