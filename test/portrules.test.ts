// Port rules (src/core/portrules.ts, prefs.ts): key forms, validation, the precedence (exact port entries always win,
// then host:port, the narrowest range, regexes in file order, otherPorts only when nothing matched, the defaults),
// and the writers (a single-port key is an exact entry; an unpin sticks against a rule that pins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrefs, parseRuleKey, removePortRule, ruleProblems, setPortPrefs, setPortRule, type Prefs } from '../src/core/prefs.ts';
import { compileRules, defaultOnNew, hostMatches, isDevServerCommand, resolvePrefs, ruleResolver, ruleRows, type RuleTarget } from '../src/core/portrules.ts';
import { callTool, type Core } from '../src/mcp/tools.ts';
import { FEATURES, REGISTRY } from '../src/features/registry.ts';

const target = (over: Partial<RuleTarget> = {}): RuleTarget => ({ port: 18895, addresses: ['127.0.0.1'], commands: ['node server.js'], kind: 'app', ...over });

const tmp = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-rules-'));
  return { dir, path: join(dir, 'prefs.json') };
};

test('parseRuleKey: port, inclusive range, host:port, else a case-insensitive regex; bad keys say why', () => {
  assert.deepEqual(parseRuleKey('3000'), { kind: 'port', port: 3000 });
  assert.deepEqual(parseRuleKey(' 3000-3010 '), { kind: 'range', from: 3000, to: 3010 });
  assert.deepEqual(parseRuleKey('localhost:5173'), { kind: 'host', host: 'localhost', port: 5173 });
  assert.deepEqual(parseRuleKey('127.0.0.1:5173'), { kind: 'host', host: '127.0.0.1', port: 5173 });
  assert.deepEqual(parseRuleKey('*:3000'), { kind: 'host', host: '*', port: 3000 });
  assert.deepEqual(parseRuleKey('[::1]:3000'), { kind: 'host', host: '::1', port: 3000 });
  const re = parseRuleKey('vite|next dev');
  assert.ok(typeof re !== 'string' && re.kind === 'command' && re.re.test('NODE /x/.bin/VITE'));
  assert.match(parseRuleKey('3010-3000') as string, /backwards/);
  assert.match(parseRuleKey('70000') as string, /outside/);
  assert.match(parseRuleKey('1-70000') as string, /outside/);
  assert.match(parseRuleKey('vite(') as string, /valid regex/);
  assert.match(parseRuleKey('  ') as string, /empty/);
  assert.match(parseRuleKey('x'.repeat(201)) as string, /longer/);
});

test('compileRules: exact port, host:port, ranges narrowest first (then lowest start), regexes in file order', () => {
  const order = compileRules({
    'b|c': {},
    '18000-19000': {},
    a: {},
    '18891-18899': {},
    '18800-18808': {},
    'localhost:18895': {},
    '18895': {},
  }).map((r) => r.key);
  assert.deepEqual(order, ['18895', 'localhost:18895', '18800-18808', '18891-18899', '18000-19000', 'b|c', 'a']);
});

test('precedence: the exact entry wins field by field; a narrower range beats a wider one; otherwise first match fills', () => {
  const prefs: Prefs = {
    ports: { 18895: { label: '내 이름' } },
    portRules: {
      '18000-19000': { label: '넓은 범위', pinned: true, onNew: 'silent' },
      '18891-18899': { label: '스크래치패드 미리보기', onNew: 'openBrowserOnce' },
      'server\\.js': { hidden: true, label: '정규식' },
    },
  };
  const r = ruleResolver(prefs)(target());
  assert.equal(r.label, '내 이름');
  assert.equal(r.from.label, 'port');
  assert.equal(r.onNew, 'openBrowserOnce');
  assert.equal(r.from.onNew, 'rule:18891-18899');
  assert.equal(r.pinned, true);
  assert.equal(r.from.pinned, 'rule:18000-19000');
  assert.equal(r.hidden, true);
  assert.equal(r.from.hidden, 'rule:server\\.js');
  assert.deepEqual(r.matched, ['18891-18899', '18000-19000', 'server\\.js']);

  // without the exact entry the narrower range names it
  const r2 = ruleResolver({ ...prefs, ports: {} })(target());
  assert.equal(r2.label, '스크래치패드 미리보기');
  assert.equal(r2.from.label, 'rule:18891-18899');
});

test('precedence: host:port beats ranges and regexes; it matches the bind address (localhost = loopback, * = all)', () => {
  const prefs: Prefs = { ports: {}, portRules: { 'node': { label: 'regex' }, '5000-6000': { label: 'range' }, 'localhost:5173': { label: 'host' } } };
  const resolve = ruleResolver(prefs);
  assert.equal(resolve(target({ port: 5173 })).label, 'host');
  assert.equal(resolve(target({ port: 5173, addresses: ['0.0.0.0'] })).label, 'range', 'not loopback: host:port does not match');
  assert.equal(resolve(target({ port: 7000 })).label, 'regex');
  assert.ok(hostMatches('*', ['::']) && hostMatches('0.0.0.0', ['*']) && !hostMatches('*', ['127.0.0.1']));
  assert.ok(hostMatches('localhost', ['::1']) && hostMatches('100.64.0.5', ['100.64.0.5']) && !hostMatches('localhost', ['100.64.0.5']));
});

test('a single-port key in portRules acts as an exact rule, but the port entry in ports still wins', () => {
  const prefs: Prefs = { ports: { 3000: { label: 'mine' } }, portRules: { '3000': { label: 'rule', onNew: 'ignore' }, '3000-3010': { onNew: 'notify' } } };
  const r = ruleResolver(prefs)(target({ port: 3000 }));
  assert.equal(r.label, 'mine');
  assert.equal(r.onNew, 'ignore');
  assert.equal(r.from.onNew, 'rule:3000');
});

test('otherPorts applies only when no rule matched; the port entry does not count as a match', () => {
  const prefs: Prefs = { ports: { 4000: { label: 'renamed' } }, portRules: { '3000-3010': { label: 'r' } }, otherPorts: { onNew: 'ignore', label: 'other' } };
  const resolve = ruleResolver(prefs);
  const matched = resolve(target({ port: 3005 }));
  assert.equal(matched.onNew, 'silent');
  assert.equal(matched.from.onNew, 'default');
  assert.deepEqual(matched.matched, ['3000-3010']);
  const other = resolve(target({ port: 4000 }));
  assert.equal(other.label, 'renamed', 'the exact entry still wins over otherPorts');
  assert.equal(other.onNew, 'ignore');
  assert.equal(other.from.onNew, 'otherPorts');
  assert.deepEqual(other.matched, ['otherPorts']);
});

test('onNew default: notify for well-known dev servers on app ports from 1024, silent otherwise; ignore also hides', () => {
  for (const cmd of [
    'node /home/dev/projects/x/node_modules/.bin/vite --port 5173',
    'node /x/node_modules/.bin/astro dev',
    'next-server (v15.1.0)',
    'node /x/node_modules/next/dist/bin/next dev -p 3001',
    'npm run dev',
    'pnpm dev --port 5191',
    'bun run dev',
  ]) assert.ok(isDevServerCommand(cmd), cmd);
  for (const cmd of ['node src/server.ts', 'python3 -m http.server 8000', 'npm run build', 'vitest --watch', 'node /x/devtools.js', 'next start']) assert.ok(!isDevServerCommand(cmd), cmd);
  const vite = ['node /x/node_modules/.bin/vite'];
  assert.equal(defaultOnNew(target({ port: 5173, commands: vite })), 'notify');
  assert.equal(defaultOnNew(target({ port: 5173, commands: vite, kind: 'system' })), 'silent');
  assert.equal(defaultOnNew(target({ port: 40000, commands: vite, kind: 'ephemeral' })), 'silent');
  assert.equal(defaultOnNew(target({ port: 80, commands: vite })), 'silent');
  assert.equal(defaultOnNew(target({ port: 8790, commands: ['node src/server.ts'] })), 'silent');

  const ignored = resolvePrefs(undefined, compileRules({ 'code-server': { onNew: 'ignore' } }), undefined, target({ commands: ['code-server --bind'] }));
  assert.equal(ignored.hidden, true);
  assert.equal(ignored.from.hidden, 'rule:code-server');
  const shown = resolvePrefs({ hidden: false }, compileRules({ 'code-server': { onNew: 'ignore' } }), undefined, target({ commands: ['code-server --bind'] }));
  assert.equal(shown.hidden, false, 'an explicit un-hide beats the ignore');
});

test('loadPrefs drops invalid rules and keys; ruleProblems names them', async () => {
  const { dir, path } = await tmp();
  await writeFile(path, JSON.stringify({
    ports: {},
    portRules: { '3000-3010': { label: 'ok' }, '3010-3000': { label: 'backwards' }, 'vite(': {}, '4000': { onNew: 'loud' }, '5000': { color: 'red' } },
    otherPorts: { onNew: 'silent' },
  }));
  const prefs = await loadPrefs(path);
  assert.deepEqual(prefs.portRules, { '3000-3010': { label: 'ok' } });
  assert.deepEqual(prefs.otherPorts, { onNew: 'silent' });
  const problems = await ruleProblems(path);
  assert.equal(problems.length, 4);
  assert.ok(problems.some((p) => p.startsWith('3010-3000:') && /backwards/.test(p)));
  assert.ok(problems.some((p) => p.startsWith('4000:') && /onNew/.test(p)));
  assert.ok(problems.some((p) => p.startsWith('5000:') && /unknown field: color/.test(p)));
  assert.deepEqual(ruleRows(prefs).map((r) => [r.key, r.kind, r.rank]), [['3000-3010', 'range', 0], ['otherPorts', 'otherPorts', 1]]);
  await rm(dir, { recursive: true, force: true });
});

test('setPortRule: ranges and regexes go to portRules, a single port to its own entry, otherPorts to the default; null clears', async () => {
  const { dir, path } = await tmp();
  assert.deepEqual(await setPortRule('18891-18899', { label: ' 스크래치패드 ', onNew: 'notify' }, path), { key: '18891-18899', where: 'portRules', rule: { label: '스크래치패드', onNew: 'notify' } });
  await setPortRule('vite|next dev', { label: '개발 서버' }, path);
  await setPortRule('5173', { label: '앱', onNew: 'silent', pinned: null }, path);
  await setPortRule('otherPorts', { onNew: 'ignore' }, path);
  let prefs = await loadPrefs(path);
  assert.deepEqual(prefs.portRules, { '18891-18899': { label: '스크래치패드', onNew: 'notify' }, 'vite|next dev': { label: '개발 서버' } });
  assert.deepEqual(prefs.ports, { 5173: { label: '앱', onNew: 'silent' } });
  assert.deepEqual(prefs.otherPorts, { onNew: 'ignore' });

  await setPortRule('18891-18899', { onNew: null }, path);
  assert.deepEqual((await loadPrefs(path)).portRules?.['18891-18899'], { label: '스크래치패드' });
  await setPortRule('vite|next dev', { label: null }, path);
  assert.ok(!('vite|next dev' in ((await loadPrefs(path)).portRules ?? {})), 'a rule left empty is removed');
  assert.equal(await removePortRule('18891-18899', path), true);
  assert.equal(await removePortRule('otherPorts', path), true);
  assert.equal(await removePortRule('nope', path), false);
  prefs = await loadPrefs(path);
  assert.equal(prefs.portRules, undefined);
  assert.equal(prefs.otherPorts, undefined);

  await assert.rejects(setPortRule('3010-3000', { label: 'x' }, path), /backwards/);
  await assert.rejects(setPortRule('3000-3010', { onNew: 'loud' }, path), /onNew/);
  await assert.rejects(setPortRule('3000-3010', { label: 'x'.repeat(81) }, path), /80/);
  await rm(dir, { recursive: true, force: true });
});

test('an unpin or un-hide in the UI sticks against a rule that pins or hides (stored as false)', async () => {
  const { dir, path } = await tmp();
  await setPortRule('3000-3010', { pinned: true, hidden: true }, path);
  await setPortPrefs(3005, { pinned: false, hidden: false }, path);
  const prefs = await loadPrefs(path);
  assert.deepEqual(prefs.ports[3005], { pinned: false, hidden: false });
  const r = ruleResolver(prefs)(target({ port: 3005 }));
  assert.equal(r.pinned, false);
  assert.equal(r.hidden, false);
  assert.equal(r.from.pinned, 'port');
  assert.equal(ruleResolver(prefs)(target({ port: 3006 })).pinned, true, 'the rest of the range is still pinned');
  // without rules an unpin still just removes the flag (as before)
  const plain = await tmp();
  await setPortPrefs(3005, { pinned: true }, plain.path);
  await setPortPrefs(3005, { pinned: false }, plain.path);
  assert.deepEqual(JSON.parse(await readFile(plain.path, 'utf8')).ports, {});
  await rm(dir, { recursive: true, force: true });
  await rm(plain.dir, { recursive: true, force: true });
});

test('MCP list_port_rules / set_port_rule: local only, validated, passed to the core', async () => {
  const f = FEATURES.find((x) => x.name === 'port-rules')!;
  assert.ok(f && !f.tools!.some((t) => t.remote) && !f.remoteTools?.length, 'nothing remote');
  assert.ok(!REGISTRY.remoteTools.some((t) => t.name === 'list_port_rules' || t.name === 'set_port_rule'));
  assert.ok(REGISTRY.routes.some((r) => r.method === 'POST' && r.path === '/api/port-rules' && r.write === true));
  const calls: unknown[] = [];
  const core = {
    portRules: async () => ({ rules: [], exact: [], problems: [], onNew: [] }),
    setPortRule: async (key: string, rule: Record<string, unknown> | null) => {
      calls.push([key, rule]);
      return { ok: true, key, where: 'portRules' as const, rule: rule as any };
    },
  } as unknown as Core;
  assert.equal((await callTool('list_port_rules', {}, core)).isError, undefined);
  assert.equal((await callTool('set_port_rule', { key: '3000-3010', label: 'x', onNew: 'notify' }, core)).isError, undefined);
  assert.equal((await callTool('set_port_rule', { key: 'vite', remove: true }, core)).isError, undefined);
  assert.equal((await callTool('set_port_rule', { key: '3000-3010' }, core)).isError, true, 'nothing to set');
  assert.equal((await callTool('set_port_rule', { key: '3000-3010', color: 'red' }, core)).isError, true);
  assert.deepEqual(calls, [['3000-3010', { label: 'x', onNew: 'notify' }], ['vite', null]]);
});
