// The GPT lane of the accounts proxy (docs/accounts.md#gpt-lane, src/core/accounts/gpt.ts and proxy.ts): the settings, the
// routing, the request and answer conversion (fixtures in test/fixtures/accounts-gpt/), and the proxy path with a fake fetch and
// a real listener on 127.0.0.1 port 0. HOME, the config folders, accounts.json and the proxy key are mkdtemp paths. No real
// endpoint is called and no real ~/.claude or ~/.codex is read. Every token and account id is checked for in every output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Safety net first (src/ is imported dynamically, after these lines).
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'pb-gpt-'));
globalThis.fetch = (() => {
  throw new Error('test reached the real fetch: inject one');
}) as typeof fetch;
process.env.HOME = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, 'claude-dir');
process.env.CODEX_HOME = join(FAKE_HOME, 'codex-dir');
for (const k of Object.keys(process.env)) if (k.startsWith('PORTBOARD_') && k !== 'PORTBOARD_LOCALE') delete process.env[k];
const FILE = join(FAKE_HOME, 'accounts.json');
const HOMES = join(FAKE_HOME, 'account-homes');
const KEY_FILE = join(FAKE_HOME, 'cfg', 'accounts-proxy.key');
process.env.PORTBOARD_ACCOUNTS = FILE;
process.env.PORTBOARD_ACCOUNT_HOMES = HOMES;
process.env.PORTBOARD_ACCOUNTS_PROXY_KEY = KEY_FILE;

const { AccountsProxy, PROXY_HOST, PROXY_REQUESTS } = await import('../src/core/accounts/proxy.ts');
const { clipText, ConvertError, fromResponse, MODEL_ID, ResponsesToMessages, routeModel, sessionIdOf, ThreadStore, toolNames, toResponsesRequest } = await import('../src/core/accounts/gpt.ts');
const { resetRefreshForTest } = await import('../src/core/accounts/refresh.ts');
const { upsertAccount } = await import('../src/core/accounts/store.ts');
const { clearQuotaCache } = await import('../src/core/accounts/quota.ts');
const { accountsConfig, SITE_DEFAULTS } = await import('../src/core/site.ts');
type Proxy = InstanceType<typeof AccountsProxy>;
type UsageLine = import('../src/core/accounts/usage.ts').UsageLine;

const FIX = join(import.meta.dirname, 'fixtures', 'accounts-gpt');
const text = (name: string) => readFileSync(join(FIX, name), 'utf8');
const fixture = (name: string): any => JSON.parse(text(name));

/** The `[event, data]` pairs of an SSE text */
function frames(sse: string): [string, unknown][] {
  return sse
    .split('\n\n')
    .filter((b) => b.trim() !== '')
    .map((b) => {
      const ev = b.split('\n').find((l) => l.startsWith('event: '))?.slice(7) ?? '';
      const data = b.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? 'null';
      return [ev, JSON.parse(data)];
    });
}
/** Feed `bytes` to the translator in pieces of `size` bytes (0: all at once) and return what it wrote */
async function translate(bytes: Buffer, size = 0, model = 'claude-opus-5-5') {
  const tr = new ResponsesToMessages(model, toolNames());
  const out: Buffer[] = [];
  tr.on('data', (c: Buffer) => out.push(c));
  const done = new Promise<void>((resolve, reject) => {
    tr.on('end', resolve);
    tr.on('error', reject);
  });
  if (size <= 0) tr.write(bytes);
  else for (let i = 0; i < bytes.length; i += size) tr.write(bytes.subarray(i, i + size));
  tr.end();
  await done;
  return { out: Buffer.concat(out).toString('utf8'), tr };
}

// ---- settings ----

test('accountsConfig: proxy.gpt is off unless enabled is true; models keep valid entries, at most 32', () => {
  assert.deepEqual(SITE_DEFAULTS.accounts, { enabled: false, proxy: { enabled: false, port: 8795, gpt: { enabled: false, models: {} }, desktop: { enabled: false } } });
  assert.deepEqual(accountsConfig(undefined).proxy.gpt, { enabled: false, models: {} });
  for (const gpt of [null, 'on', 5, [], true]) assert.deepEqual(accountsConfig({ proxy: { gpt } }).proxy.gpt, { enabled: false, models: {} }, JSON.stringify(gpt));
  assert.equal(accountsConfig({ proxy: { gpt: { enabled: 'true' } } }).proxy.gpt.enabled, false);
  assert.equal(accountsConfig({ proxy: { gpt: { enabled: true } } }).proxy.gpt.enabled, true);
  assert.deepEqual(accountsConfig({ proxy: { gpt: { enabled: true, models: { 'claude-opus-5-5': 'gpt-6-astra' } } } }).proxy.gpt, { enabled: true, models: { 'claude-opus-5-5': 'gpt-6-astra' } });
  const mixed = accountsConfig({ proxy: { gpt: { models: { ok: 'gpt-6', 'has space': 'gpt-6', '': 'gpt-6', bad: 'a b', worse: '-x', num: 5, obj: {}, long: 'x'.repeat(129), tag: 'gpt-6:high.v2_x' } } } }).proxy.gpt.models;
  assert.deepEqual(mixed, { ok: 'gpt-6', tag: 'gpt-6:high.v2_x' });
  for (const models of [null, 'x', [], 5]) assert.deepEqual(accountsConfig({ proxy: { gpt: { models } } }).proxy.gpt.models, {}, JSON.stringify(models));
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`m${String(i).padStart(2, '0')}`, 'gpt-6']));
  const kept = Object.keys(accountsConfig({ proxy: { gpt: { models: many } } }).proxy.gpt.models);
  assert.equal(kept.length, 32);
  assert.deepEqual(kept, Object.keys(many).slice(0, 32));
  assert.equal(accountsConfig({ proxy: { gpt: { models: { [`${'k'.repeat(128)}`]: 'gpt-6', [`${'k'.repeat(129)}`]: 'gpt-6' } } } }).proxy.gpt.models['k'.repeat(128)], 'gpt-6');
});

// ---- routing ----

test('routeModel: the listed name, then codex/<valid id>, else null; off or a non-string is null', () => {
  const cfg = { enabled: true, models: { 'claude-opus-5-5': 'gpt-6-astra', 'codex/odd': 'gpt-mapped' } };
  assert.equal(routeModel('claude-opus-5-5', cfg), 'gpt-6-astra');
  assert.equal(routeModel('codex/odd', cfg), 'gpt-mapped', 'a listed name wins over the prefix');
  assert.equal(routeModel('codex/gpt-6', cfg), 'gpt-6');
  assert.equal(routeModel('codex/', cfg), null);
  assert.equal(routeModel('codex/bad id', cfg), null);
  assert.equal(routeModel('codex/-x', cfg), null);
  assert.equal(routeModel(`codex/${'a'.repeat(129)}`, cfg), null);
  assert.equal(routeModel('claude-sonnet-5', cfg), null);
  assert.equal(routeModel('openai/gpt-6', cfg), null);
  assert.equal(routeModel('toString', cfg), null, 'no inherited keys');
  assert.equal(routeModel('claude-opus-5-5', { ...cfg, enabled: false }), null);
  assert.equal(routeModel('codex/gpt-6', { ...cfg, enabled: false }), null);
  for (const m of [undefined, null, 5, {}, ['codex/gpt-6']]) assert.equal(routeModel(m, cfg), null);
  assert.ok(MODEL_ID.test('gpt-6-astra') && !MODEL_ID.test('.x'));
});

// ---- request ----

test('request conversion: a Claude Code body (system array, system message, adaptive thinking, metadata) becomes the Responses body', () => {
  const out = toResponsesRequest(fixture('request-text.json'), 'gpt-6-astra', toolNames());
  assert.deepEqual(out, fixture('request-text.expected.json'));
  assert.ok(!JSON.stringify(out).includes('user_example_session_1'), 'the raw user id never goes up');
  assert.ok(!JSON.stringify(out).includes('billing-header'), 'the Anthropic billing block is not an instruction');
  assert.deepEqual(Object.keys(out).sort(), ['input', 'instructions', 'model', 'reasoning', 'store', 'stream'], 'no session id, no prompt_cache_key');
  const keyed = toResponsesRequest(fixture('request-text.json'), 'gpt-6-astra', toolNames(), '11111111-2222-3333-4444-555555555555');
  assert.equal(keyed.prompt_cache_key, '11111111-2222-3333-4444-555555555555');
});

test('session id: the client header when it is a UUID (lower-cased), else a UUID-shaped hash of metadata.user_id, else none', () => {
  const body = fixture('request-text.json');
  assert.equal(sessionIdOf('ABCDEF12-3456-7890-ABCD-EF1234567890', body), 'abcdef12-3456-7890-abcd-ef1234567890');
  assert.equal(sessionIdOf(['abcdef12-3456-7890-abcd-ef1234567890'], null), 'abcdef12-3456-7890-abcd-ef1234567890');
  const hashed = sessionIdOf(undefined, body);
  assert.match(String(hashed), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(sessionIdOf('not-a-uuid', body), hashed, 'a header that is not a UUID is not used');
  assert.ok(!String(hashed).includes('user_example'));
  assert.equal(sessionIdOf(undefined, { metadata: { user_id: '' } }), null);
  assert.equal(sessionIdOf(undefined, { metadata: {} }), null);
  assert.equal(sessionIdOf(undefined, null), null);
});

test('upstream text: a word cut at the 4096-character edge is dropped, so no secret survives as a fragment', () => {
  assert.equal(clipText(`${'Q'.repeat(4080)} alice.longname@corp.example.com`), '[redacted]');
  const out = clipText(`${'Q'.repeat(4080)} alice.longname@corp.example.com`);
  assert.ok(!out.includes('alice') && !out.includes('@'));
  assert.equal(clipText(`${'ab '.repeat(2000)}tail`).length, 500, 'ordinary long text is only cut to 500');
  assert.equal(clipText('x'.repeat(4096)), '[redacted]', 'a text of exactly 4096 characters is not cut by this rule');
});

test('upstream text: e-mail, ids, UUIDs and long token runs are redacted; ordinary messages stay; control characters go; 500 characters', () => {
  const dirty = 'x org-EXAMPLE123456 y owner@example.com z 123e4567-e89b-12d3-a456-426614174000 w ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd end\u0007';
  const out = clipText(dirty);
  for (const bad of ['org-EXAMPLE', 'owner@', '@example', '123e4567', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) assert.ok(!out.includes(bad), bad);
  assert.equal(out, 'x [redacted] y [redacted] z [redacted] w [redacted] end');
  for (const [prefix, id] of [['user', 'user-abc123XYZ'], ['req', 'req_0123456789'], ['resp', 'resp_abcdef'], ['call', 'call-aaaaaa1']]) assert.equal(clipText(`id ${id}`), 'id [redacted]', prefix);
  for (const fine of ['The usage limit has been reached', "The 'no-such-model-x' model is not supported when using Codex with a ChatGPT account."]) assert.equal(clipText(fine), fine);
  assert.equal(clipText('a'.repeat(700).replace(/a{20}/g, 'ab cd ef gh ij ')).length, 500);
  assert.equal(clipText(5), 'upstream error');
  // a long run with no '@' made the e-mail pattern backtrack from every position (about 1 s for 40k characters): it must stay fast
  const started = performance.now();
  assert.equal(clipText('a'.repeat(1024 * 1024)), '[redacted]');
  assert.equal(clipText(`${'a'.repeat(30_000)} owner@example.com`), '[redacted]');
  assert.ok(performance.now() - started < 200, `scrubbing took ${Math.round(performance.now() - started)} ms`);
});

test('request conversion: tools, deferred tools, tool results, images, documents, tool_choice and a long tool name', () => {
  const names = toolNames();
  const out = toResponsesRequest(fixture('request-tools.json'), 'gpt-6-astra', names);
  assert.deepEqual(out, fixture('request-tools.expected.json'));
  const long = fixture('request-tools.json').tools[1].name as string;
  const up = names.toUpstream(long);
  assert.equal(names.fromUpstream(up), long);
  assert.equal((out.tools as { name: string }[]).some((t) => t.name === 'Hidden' || t.name === 'DeferredToolPlaceholder' || t.name === 'web_search'), false);
});

test('request conversion: effort map, tool_choice forms, stream and store are fixed, unknown fields are dropped', () => {
  const base = { messages: [{ role: 'user', content: 'hi' }], stream: false, temperature: 0.2, top_p: 0.9, stop_sequences: ['x'], max_tokens: 5, service_tier: 'auto', mcp_servers: [{}], extra: 1 };
  const conv = (extra: Record<string, unknown>) => toResponsesRequest({ ...base, ...extra }, 'gpt-x', toolNames());
  const plain = conv({});
  assert.deepEqual(plain, { model: 'gpt-x', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], stream: true, store: false });
  for (const [e, want] of [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['minimal', 'minimal'], ['xhigh', 'high'], ['max', 'high']]) assert.deepEqual(conv({ output_config: { effort: e } }).reasoning, { effort: want }, e);
  assert.deepEqual(conv({ output_config: { effort: 'weird' }, thinking: { type: 'adaptive' } }).reasoning, { effort: 'medium' });
  assert.deepEqual(conv({ thinking: { type: 'enabled', budget_tokens: 1 } }).reasoning, { effort: 'medium' });
  assert.equal(conv({ thinking: { type: 'disabled' } }).reasoning, undefined);
  assert.equal(conv({ output_config: { effort: 'toString' } }).reasoning, undefined);
  assert.equal(conv({ tool_choice: { type: 'auto' } }).tool_choice, 'auto');
  assert.equal(conv({ tool_choice: { type: 'any' } }).tool_choice, undefined, 'no tool is sent, so none can be required');
  assert.equal(conv({ tools: [{ name: 'Bash', input_schema: {} }], tool_choice: { type: 'any' } }).tool_choice, 'required');
  assert.equal(conv({ tool_choice: { type: 'none' } }).tool_choice, 'none');
  assert.equal(conv({ tool_choice: { type: 'tool', name: 'Bash' } }).tool_choice, undefined, 'a tool that is not sent cannot be chosen');
  assert.deepEqual(conv({ tools: [{ name: 'Bash', input_schema: {} }], tool_choice: { type: 'tool', name: 'Bash' } }).tool_choice, { type: 'function', name: 'Bash' });
  assert.equal(conv({ tools: [{ name: 'Bash', input_schema: {}, defer_loading: true }], tool_choice: { type: 'tool', name: 'Bash' } }).tool_choice, undefined, 'nor a deferred one');
  assert.equal(conv({ tool_choice: { type: 'auto', disable_parallel_tool_use: true } }).parallel_tool_calls, false);
  assert.equal(conv({ tool_choice: { type: 'auto', disable_parallel_tool_use: false } }).parallel_tool_calls, undefined);
  assert.equal(conv({ metadata: { user_id: 'u' } }).prompt_cache_key, undefined, 'the body alone gives no cache key');
  assert.equal(conv({ system: '' }).instructions, undefined);
  assert.equal(conv({ system: 'plain' }).instructions, 'plain');
  assert.equal(conv({ tools: [{ name: 'a', input_schema: {} }] }).tools?.length, 1);
  assert.equal(conv({ tools: [{ name: 'a' }] }).tools, undefined);
});

test('request conversion: a body that is not an object or has no messages array is a ConvertError with a closed text', () => {
  for (const body of [null, 'x', 5, [], undefined]) assert.throws(() => toResponsesRequest(body, 'g', toolNames()), (e: unknown) => e instanceof ConvertError && e.message === 'request is not a JSON object');
  for (const messages of [undefined, 'secret-text', {}, null]) assert.throws(() => toResponsesRequest({ messages }, 'g', toolNames()), (e: unknown) => e instanceof ConvertError && e.message === 'messages must be an array');
});

test('tool names: a valid name stays; others are cut and hashed the same way every time and map back', () => {
  const a = toolNames();
  const b = toolNames();
  assert.equal(a.toUpstream('Bash'), 'Bash');
  const long = `mcp__server__${'t'.repeat(70)}`;
  const odd = 'mcp.server/tool name';
  const x = a.toUpstream(long);
  const y = a.toUpstream(odd);
  for (const n of [x, y]) assert.match(n, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(x.length, 64);
  assert.match(y, /^mcp_server_tool_name_[0-9a-f]{8}$/);
  assert.equal(b.toUpstream(long), x, 'the same in another instance');
  assert.equal(a.toUpstream(long), x, 'the same twice');
  assert.notEqual(a.toUpstream(`${long}x`), x, 'a name that differs only after the cut differs');
  assert.equal(a.fromUpstream(x), long);
  assert.equal(a.fromUpstream(y), odd);
  assert.equal(a.fromUpstream('Bash'), 'Bash');
  assert.equal(b.fromUpstream(y), y, 'an instance that never mapped the name returns it unchanged');
  assert.match(a.toUpstream(''), /^_[0-9a-f]{8}$/);
});

// ---- whole answer ----

test('whole answer: text, refusal and function calls become a Message; stop reason and usage follow the rules', () => {
  const tool = fromResponse(fixture('response-tool.json'), 'claude-opus-5-5', toolNames());
  assert.deepEqual(tool, fixture('response-tool.expected.json'));
  const inc = fromResponse(fixture('response-incomplete.json'), 'claude-opus-5-5', toolNames());
  assert.deepEqual(inc, fixture('response-incomplete.expected.json'));
  const filtered = fromResponse({ id: 'resp_z', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }, 'm', toolNames());
  assert.equal(filtered.stop_reason, 'refusal');
  assert.equal(fromResponse({ id: 'resp_z', status: 'completed', output: [] }, 'm', toolNames()).stop_reason, 'end_turn');
  const over = fromResponse({ usage: { input_tokens: 3, input_tokens_details: { cached_tokens: 9 } } }, 'm', toolNames()).usage as { input_tokens: number; cache_read_input_tokens: number };
  assert.deepEqual([over.input_tokens, over.cache_read_input_tokens], [0, 9], 'input never goes below 0');
  assert.match(String(fromResponse(null, 'm', toolNames()).id), /^msg_[0-9a-f]{24}$/);
  const names = toolNames();
  const mapped = names.toUpstream('mcp.a/b');
  const back = fromResponse({ id: 'resp_q', output: [{ type: 'function_call', call_id: 'c1', name: mapped, arguments: '[1]' }] }, 'm', names);
  assert.deepEqual(back.content, [{ type: 'tool_use', id: 'c1', name: 'mcp.a/b', input: {} }]);
});

// ---- stream ----

for (const name of ['stream-text-captured', 'stream-tool-captured', 'stream-failed', 'stream-cut']) {
  test(`stream ${name}: the Anthropic events match, whole and one byte at a time`, async () => {
    const bytes = readFileSync(join(FIX, `${name}.sse`));
    const whole = await translate(bytes);
    assert.deepEqual(frames(whole.out), fixture(`${name}.expected.json`));
    const slow = await translate(bytes, 1);
    assert.equal(slow.out, whole.out, 'one byte at a time gives the same bytes');
    const odd = await translate(bytes, 7);
    assert.equal(odd.out, whole.out);
  });
}

test('stream: finalResponse and failure, the model name is the requested one, and unreadable input never throws', async () => {
  const done = await translate(readFileSync(join(FIX, 'stream-tool-captured.sse')));
  const final = done.tr.finalResponse() as { status: string; usage: { input_tokens: number } };
  assert.equal(final.status, 'completed');
  assert.equal(final.usage.input_tokens, 151);
  assert.equal(done.tr.failure(), null);
  const failed = await translate(readFileSync(join(FIX, 'stream-failed.sse')));
  assert.equal(failed.tr.finalResponse(), null);
  assert.equal(failed.tr.failure(), 'codex: badthing');
  const cut = await translate(readFileSync(join(FIX, 'stream-cut.sse')));
  assert.equal(cut.tr.failure(), null, 'a cut stream has no failure text; it ends with an error event');
  const named = await translate(readFileSync(join(FIX, 'stream-text-captured.sse')), 0, 'my-model');
  assert.equal((frames(named.out)[0][1] as { message: { model: string } }).message.model, 'my-model');
  const junk = await translate(Buffer.from('data: not json\n\nevent: x\n\n: comment\n\ndata: {"type":"error","message":"x\\u0001y"}\n\n'));
  assert.deepEqual(frames(junk.out), [['error', { type: 'error', error: { type: 'api_error', message: 'codex: xy' } }]]);
  const nonString = await translate(Buffer.from('data: {"type":"error","message":5}\n\n'));
  assert.deepEqual(frames(nonString.out), [['error', { type: 'error', error: { type: 'api_error', message: 'codex: upstream error' } }]]);
  const long = await translate(Buffer.from(`data: {"type":"error","message":"${'ab '.repeat(300)}"}\n\n`));
  assert.equal(((frames(long.out)[0][1] as { error: { message: string } }).error.message).length, 'codex: '.length + 500);
  const empty = await translate(Buffer.alloc(0));
  assert.deepEqual(frames(empty.out), [['error', { type: 'error', error: { type: 'api_error', message: 'codex stream ended early' } }]]);
  const large = await translate(Buffer.from(`data: {"type":"response.completed","response":{"id":"resp_k","instructions":"${'x'.repeat(3 * 1024 * 1024)}","usage":{"input_tokens":5,"output_tokens":2}}}\n\n`));
  assert.deepEqual(frames(large.out).map((f) => f[0]), ['message_start', 'message_delta', 'message_stop'], 'a 3 MiB response.completed is not dropped');
  assert.equal((frames(large.out)[1][1] as { usage: { input_tokens: number } }).usage.input_tokens, 5);
});

test('stream: a second text block and a tool after text get their own indexes; arguments of the done item are used when no delta came', async () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const sse =
    ev({ type: 'response.created', response: { id: 'resp_m' } }) +
    ev({ type: 'response.output_text.delta', item_id: 'm1', content_index: 0, delta: 'a' }) +
    ev({ type: 'response.output_text.delta', item_id: 'm1', content_index: 1, delta: 'b' }) +
    ev({ type: 'response.refusal.delta', item_id: 'm2', content_index: 0, delta: 'no' }) +
    ev({ type: 'response.output_item.added', item: { type: 'function_call', id: 'f1', call_id: 'c1', name: 'T', arguments: '' } }) +
    ev({ type: 'response.output_item.done', item: { type: 'function_call', id: 'f1', call_id: 'c1', name: 'T', arguments: '{"a":1}' } }) +
    ev({ type: 'response.incomplete', response: { id: 'resp_m', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 2 } } });
  const got = frames((await translate(Buffer.from(sse))).out).map(([e, d]) => [e, (d as { index?: number }).index]);
  assert.deepEqual(got, [
    ['message_start', undefined],
    ['content_block_start', 0], ['content_block_delta', 0],
    ['content_block_stop', 0], ['content_block_start', 1], ['content_block_delta', 1],
    ['content_block_stop', 1], ['content_block_start', 2], ['content_block_delta', 2],
    ['content_block_stop', 2], ['content_block_start', 3], ['content_block_delta', 3], ['content_block_stop', 3],
    ['message_delta', undefined], ['message_stop', undefined],
  ]);
  const last = frames((await translate(Buffer.from(sse))).out).at(-2)?.[1] as { delta: { stop_reason: string }; usage: unknown };
  assert.equal(last.delta.stop_reason, 'tool_use', 'a tool call makes it tool_use even when incomplete');
  assert.deepEqual(last.usage, { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 });
});

// ---- the proxy ----

const NOW = Date.parse('2026-11-24T09:00:00Z');
let clock = NOW;
const iso = (ms: number) => new Date(ms).toISOString();
const CX = { A: 'TESTTOKENCODEXA0123456789', B: 'TESTTOKENCODEXB0123456789' };
const ACCOUNT_ID = { A: 'cx-account-aaaa', B: 'cx-account-bbbb' };
const CLAUDE_TOKEN = 'sk-ant-oat01-TESTTOKENCLAUDE0123456789';
const REFRESH = 'sk-ant-ort01-TESTREFRESH0123456789';
const MARKERS = ['TESTTOKEN', 'TESTREFRESH', 'cx-account-'];

interface Up {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}
const ups: Up[] = [];
let upstream: (u: Up) => Response | Promise<Response> = () => new Response('{}', { status: 200 });
const fake = (async (url: string | URL | Request, init?: RequestInit) => {
  const u: Up = { url: String(url), headers: Object.fromEntries(new Headers(init?.headers as Record<string, string>)), body: Buffer.from((init?.body as Buffer | undefined) ?? Buffer.alloc(0)) };
  ups.push(u);
  return upstream(u);
}) as typeof fetch;

const sseResponse = (name: string) => new Response(readFileSync(join(FIX, name)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const failure = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
const limited = (marker: string) =>
  new Response(JSON.stringify({ error: { type: 'usage_limit_reached', marker } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': String(Math.floor(NOW / 1000) + 600) },
  });

let proxy: Proxy;
let key = '';
let gptCfg = { enabled: true, models: { 'claude-opus-5-5': 'gpt-6-astra' } as Record<string, string> };
const usage: UsageLine[] = [];
/** called after each usage line is written; a waiter that is done returns true and is dropped */
let waiters: (() => boolean)[] = [];
const logged: string[] = [];
const outputs: string[] = [];
const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
const portOf = () => proxy.report().port;

test.beforeEach(async () => {
  resetRefreshForTest();
  clearQuotaCache();
  rmSync(FILE, { force: true });
  rmSync(HOMES, { recursive: true, force: true });
  rmSync(join(FAKE_HOME, 'cfg'), { recursive: true, force: true });
  ups.length = 0;
  usage.length = 0;
  waiters = [];
  logged.length = 0;
  outputs.length = 0;
  clock = NOW;
  gptCfg = { enabled: true, models: { 'claude-opus-5-5': 'gpt-6-astra' } };
  upstream = () => sseResponse('stream-text-captured.sse');
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  const home = { fetch: fake, now: () => clock, accountsPath: FILE, accountHomes: HOMES, home: FAKE_HOME, env: { CLAUDE_CONFIG_DIR: join(FAKE_HOME, 'c'), CODEX_HOME: join(FAKE_HOME, 'x') }, platform: 'linux' };
  proxy = new AccountsProxy({
    ...home,
    keyPath: KEY_FILE,
    gpt: () => gptCfg,
    appendUsage: async (line) => {
      usage.push(line);
      waiters = waiters.filter((w) => !w());
    },
  });
  await proxy.sync({ enabled: true, port: 0 });
  key = await proxy.key();
});
test.afterEach(async () => {
  await proxy.close();
  Object.assign(console, saved);
  for (const o of [...outputs, ...logged, JSON.stringify(usage), JSON.stringify(proxy.report())]) {
    for (const m of MARKERS) assert.ok(!o.includes(m), `output holds ${m}`);
    assert.ok(!o.includes(key), 'output holds the proxy key');
  }
});

type Tokens = { access: string; refresh: string | null; idToken: string | null; expiresAt: string | null };
let seq = 0;
const codex = (access: string, identity: string, tokens: Partial<Tokens> = {}) =>
  upsertAccount({ provider: 'codex', alias: `cx-${seq++}`, identity, email: 'c@example.com', plan: 'plus', tokens: { access, refresh: REFRESH, idToken: 'TESTTOKENIDTOKEN', expiresAt: iso(NOW + 100 * 3600_000), ...tokens } }, { path: FILE, now: () => clock });
const claude = (access: string) =>
  upsertAccount({ provider: 'claude', alias: 'cl', identity: 'uuid-gpt-1', email: 'a@example.com', plan: 'max', tier: 'default_claude_max_5x', subscriptionType: 'max', tokens: { access, refresh: REFRESH, idToken: null, expiresAt: iso(NOW + 100 * 3600_000) } }, { path: FILE, now: () => clock });

interface Got {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: any;
}
async function call(body: unknown, path = '/v1/messages', headers: Record<string, string> = {}): Promise<Got> {
  const req = httpRequest({ host: PROXY_HOST, port: portOf(), path, method: 'POST', agent: false, headers: { authorization: `Bearer ${key}`, 'user-agent': 'claude-cli/2.1.330', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'x', ...headers } });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
  });
  req.end(typeof body === 'string' ? body : JSON.stringify(body));
  const res = await response;
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  const t = Buffer.concat(chunks).toString('utf8');
  outputs.push(t, JSON.stringify(res.headers));
  let json: unknown = null;
  try {
    json = JSON.parse(t);
  } catch {
    // an SSE answer
  }
  return { status: res.statusCode ?? 0, headers: res.headers, text: t, json };
}
/** The usage lines are written when the answer ended: wait for them */
function lines(n: number): Promise<UsageLine[]> {
  if (usage.length >= n) return Promise.resolve(usage);
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('no usage line')), 10_000);
    guard.unref();
    waiters.push(() => {
      if (usage.length < n) return false;
      clearTimeout(guard);
      resolve(usage);
      return true;
    });
  });
}
const claudeBody = (model: string, extra: Record<string, unknown> = {}) => ({ ...fixture('request-text.json'), model, ...extra });

test('gpt lane: a mapped model goes to the Codex address with exactly these headers and the converted body; the client gets Anthropic SSE; the usage line is a codex line', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  assert.ok(PROXY_REQUESTS.codex.origin === 'https://chatgpt.com' && PROXY_REQUESTS.codex.upstreamPath === '/backend-api/codex/responses');
  const hashed = sessionIdOf(undefined, claudeBody('claude-opus-5-5')) as string;
  const r = await call(claudeBody('claude-opus-5-5'), '/v1/messages?beta=true');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/event-stream');
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.deepEqual(frames(r.text), fixture('stream-text-captured.expected.json'));
  assert.equal(ups.length, 1);
  assert.equal(ups[0].url, 'https://chatgpt.com/backend-api/codex/responses', 'no query goes up');
  assert.deepEqual(ups[0].headers, {
    authorization: `Bearer ${CX.A}`,
    'chatgpt-account-id': ACCOUNT_ID.A,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'accept-encoding': 'identity',
    'session-id': hashed,
  });
  const sent = JSON.parse(ups[0].body.toString('utf8'));
  assert.deepEqual(sent, { ...fixture('request-text.expected.json'), prompt_cache_key: hashed }, 'the model is the upstream one; stream is true and store is false; the cache key is the session id');
  const l = await lines(1);
  assert.equal(l.length, 1);
  assert.deepEqual({ ...l[0], at: '', ms: 0 }, { at: '', provider: 'codex', account: l[0].account, model: 'gpt-6-astra', status: 200, input: 104, output: 12, cacheRead: 0, cacheWrite: 0, ms: 0 });
  assert.match(l[0].account, /^acc-/);
});

test('gpt lane: the tool stream reaches the client as tool_use with argument deltas, and codex/<id> is routed without a list entry', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  upstream = () => sseResponse('stream-tool-captured.sse');
  gptCfg = { enabled: true, models: {} };
  const r = await call(claudeBody('codex/gpt-6-astra'));
  assert.equal(r.status, 200);
  const want = fixture('stream-tool-captured.expected.json');
  want[0][1].message.model = 'codex/gpt-6-astra';
  assert.deepEqual(frames(r.text), want, 'the answer names the model the client asked for');
  assert.equal(JSON.parse(ups[0].body.toString('utf8')).model, 'gpt-6-astra');
  const l = await lines(1);
  assert.deepEqual([l[0].provider, l[0].model, l[0].input, l[0].output], ['codex', 'gpt-6-astra', 151, 18]);
});

test('gpt lane: an unmapped model, the lane off, and a body that is not JSON all pass through to Anthropic with the original bytes', async () => {
  await claude(CLAUDE_TOKEN);
  upstream = () => new Response('{"type":"message"}', { status: 200, headers: { 'content-type': 'application/json' } });
  const bytes = JSON.stringify(claudeBody('claude-sonnet-5'));
  const a = await call(bytes);
  assert.equal(a.status, 200);
  assert.equal(ups[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(ups[0].body.toString('utf8'), bytes);
  assert.equal(ups[0].headers['user-agent'], 'claude-cli/2.1.330', 'the client headers go on as before');
  // lane off, a codex/ model
  gptCfg = { enabled: false, models: { 'claude-opus-5-5': 'gpt-6-astra' } };
  const off = JSON.stringify(claudeBody('codex/x'));
  const b = await call(off);
  assert.equal(b.status, 200);
  assert.equal(ups[1].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(ups[1].body.toString('utf8'), off);
  const mapped = JSON.stringify(claudeBody('claude-opus-5-5'));
  await call(mapped);
  assert.equal(ups[2].url, 'https://api.anthropic.com/v1/messages', 'a listed model with the lane off is not routed');
  assert.equal(ups[2].body.toString('utf8'), mapped);
  // lane on, not JSON
  gptCfg = { enabled: true, models: { 'claude-opus-5-5': 'gpt-6-astra' } };
  const c = await call('not json');
  assert.equal(c.status, 200);
  assert.equal(ups[3].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(ups[3].body.toString('utf8'), 'not json');
  assert.equal(ups.length, 4);
});

test('gpt lane: a first account at its limit sends the request to the next account; the switch is a codex event', async () => {
  const a = await codex(CX.A, ACCOUNT_ID.A);
  const b = await codex(CX.B, ACCOUNT_ID.B);
  upstream = (u) => (u.headers.authorization === `Bearer ${CX.A}` ? limited('A') : sseResponse('stream-text-captured.sse'));
  const r = await call(claudeBody('claude-opus-5-5'));
  assert.equal(r.status, 200);
  assert.deepEqual(frames(r.text), fixture('stream-text-captured.expected.json'));
  assert.deepEqual(ups.map((u) => u.headers['chatgpt-account-id']), [ACCOUNT_ID.A, ACCOUNT_ID.B]);
  assert.equal(ups[0].body.toString('utf8'), ups[1].body.toString('utf8'));
  const rep = proxy.report();
  assert.deepEqual(rep.events.filter((e) => e.kind === 'switch').map((e) => [e.provider, e.from, e.to, e.status]), [['codex', a.id, b.id, 429]]);
  assert.deepEqual(rep.current, { claude: null, codex: b.id });
  const l = await lines(1);
  assert.equal(l[0].account, b.id);
});

test('gpt lane: an upstream 400 with a detail text is a 400 invalid_request_error in the Anthropic shape', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  upstream = () => failure(400, { detail: 'Stream must be set to true' });
  const r = await call(claudeBody('claude-opus-5-5'));
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { type: 'error', error: { type: 'invalid_request_error', message: 'codex: Stream must be set to true' } });
  const l = await lines(1);
  assert.deepEqual([l[0].provider, l[0].status, l[0].input, l[0].output], ['codex', 400, null, null]);
});

test('gpt lane: error statuses map to closed types; an error.message is read; no text is "codex: upstream error"; retry-after is kept', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  const cases: [number, unknown, string, string][] = [
    [422, { error: { message: 'bad\u0001 field' } }, 'invalid_request_error', 'codex: bad field'],
    [404, { detail: 'nope' }, 'not_found_error', 'codex: nope'],
    [413, 'junk', 'request_too_large', 'codex: upstream error'],
    [500, { detail: 5 }, 'api_error', 'codex: upstream error'],
    [403, { detail: 'TESTTOKEN in text' }, 'permission_error', 'chatgpt.com refused the request'],
    [503, { detail: 'ab '.repeat(300) }, 'api_error', `codex: ${'ab '.repeat(300).slice(0, 500)}`],
  ];
  for (const [status, body, type, message] of cases) {
    upstream = () => failure(status, body);
    const r = await call(claudeBody('claude-opus-5-5'));
    assert.deepEqual([r.status, r.json], [status, { type: 'error', error: { type, message } }], String(status));
  }
  await codex(CX.B, ACCOUNT_ID.B);
  upstream = (u) => (u.headers.authorization === `Bearer ${CX.A}` ? limited('A') : new Response('{"detail":"slow down"}', { status: 429, headers: { 'retry-after': '7', 'content-type': 'application/json' } }));
  const r = await call(claudeBody('claude-opus-5-5'));
  assert.equal(r.status, 429);
  assert.equal(r.headers['retry-after'], '7');
  assert.equal(r.json.error.type, 'rate_limit_error');
});

test('gpt lane: a 401 on every account is a 401 with a closed text and no token in it', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  await codex(CX.B, ACCOUNT_ID.B);
  upstream = (u) => failure(401, { detail: `token ${u.headers.authorization} refused` });
  const r = await call(claudeBody('claude-opus-5-5'));
  assert.deepEqual([r.status, r.json], [401, { type: 'error', error: { type: 'authentication_error', message: 'codex account token refused' } }]);
  assert.equal(ups.length, 2);
  assert.ok(!r.text.includes('TESTTOKEN'));
});

test('gpt lane: no account is 503 no usable account in the Anthropic shape; a network failure is 502 with a status 0 line', async () => {
  const none = await call(claudeBody('claude-opus-5-5'));
  assert.deepEqual([none.status, none.json], [503, { type: 'error', error: { type: 'api_error', message: 'no usable account' } }]);
  assert.equal(ups.length, 0);
  assert.equal(proxy.report().events.some((e) => e.kind === 'no usable account' && e.provider === 'codex'), true);
  await codex(CX.A, ACCOUNT_ID.A);
  upstream = () => {
    throw new Error(`network ${CX.A}`);
  };
  const net = await call(claudeBody('claude-opus-5-5'));
  assert.deepEqual([net.status, net.json], [502, { type: 'error', error: { type: 'api_error', message: 'upstream request failed' } }]);
  const l = await lines(1);
  assert.deepEqual([l[0].provider, l[0].status], ['codex', 0]);
});

test('gpt lane: stream false gets one JSON Message built from the final Response; a failed response is 500; a cut stream is 502', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  upstream = () => sseResponse('stream-tool-captured.sse');
  const r = await call(claudeBody('claude-opus-5-5', { stream: false }));
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /application\/json/);
  assert.deepEqual(r.json, {
    id: 'msg_0d345680552ec14a016b0536b9087887d094f725f7e693b9d9',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'tool_use', id: 'call_b51e9239ae4f409c9a6e083f2b27decb', name: 'get_time', input: { tz: 'UTC' } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 151, output_tokens: 18, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  assert.equal(JSON.parse(ups[0].body.toString('utf8')).stream, true, 'upstream always streams');
  const l = await lines(1);
  assert.deepEqual([l[0].provider, l[0].model, l[0].status, l[0].input, l[0].output], ['codex', 'gpt-6-astra', 200, 151, 18]);
  upstream = () => sseResponse('stream-failed.sse');
  const failed = await call(claudeBody('claude-opus-5-5', { stream: false }));
  assert.deepEqual([failed.status, failed.json], [500, { type: 'error', error: { type: 'api_error', message: 'codex: badthing' } }]);
  upstream = () => sseResponse('stream-cut.sse');
  const cut = await call(claudeBody('claude-opus-5-5', { stream: false }));
  assert.equal(cut.status, 502);
  assert.equal(cut.json.error.message, 'upstream request failed');
  assert.equal((await lines(2))[1].status, 200, 'a clean end with no final Response keeps the upstream status');
  // the upstream body breaks off after its headers
  upstream = () =>
    new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_b"}}\n\n')), pull(c) { c.error(new Error('reset')); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const broke = await call(claudeBody('claude-opus-5-5', { stream: false }));
  assert.deepEqual([broke.status, broke.json.error.message], [502, 'upstream request failed']);
  assert.equal((await lines(3))[2].status, 200, 'a stream that broke off after its headers keeps the upstream status, not 0');
  upstream = () => new Response('', { status: 200 });
  assert.equal((await call(claudeBody('claude-opus-5-5', { stream: false }))).status, 502);
});

test('gpt lane: count_tokens on a mapped model is an estimate of bytes / 4, with no upstream call and no usage line', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  const bytes = JSON.stringify(claudeBody('claude-opus-5-5'));
  const r = await call(bytes, '/v1/messages/count_tokens?beta=true');
  assert.deepEqual([r.status, r.json], [200, { input_tokens: Math.ceil(Buffer.byteLength(bytes) / 4) }]);
  assert.equal(ups.length, 0);
  await proxy.close(); // waits for the usage writes that are still running
  assert.equal(usage.length, 0);
});

test('gpt lane: a body the converter refuses is a 400 invalid_request_error with a closed text; /codex/responses is never routed', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  const bad = await call({ model: 'claude-opus-5-5', messages: 'secret-text' });
  assert.deepEqual([bad.status, bad.json], [400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages must be an array' } }]);
  assert.equal(ups.length, 0);
  const own = JSON.stringify({ model: 'claude-opus-5-5', input: [] });
  upstream = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  await call(own, '/codex/responses');
  assert.equal(ups[0].body.toString('utf8'), own, 'a Codex request keeps its bytes');
});

test('gpt lane: only a caller with the proxy key reaches it', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  const req = httpRequest({ host: PROXY_HOST, port: portOf(), path: '/v1/messages', method: 'POST', agent: false, headers: { authorization: 'Bearer wrong' } });
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
    req.end(JSON.stringify(claudeBody('claude-opus-5-5')));
  });
  res.resume();
  assert.equal(res.statusCode, 401);
  assert.equal(ups.length, 0);
});

test('gpt lane: the client session header becomes session-id and prompt_cache_key; no other client header goes up', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  await call(claudeBody('claude-opus-5-5'), '/v1/messages', { 'x-claude-code-session-id': id.toUpperCase(), 'x-app': 'cli', 'x-stainless-os': 'Linux' });
  assert.deepEqual(Object.keys(ups[0].headers).sort(), ['accept', 'accept-encoding', 'authorization', 'chatgpt-account-id', 'content-type', 'session-id']);
  assert.equal(ups[0].headers['session-id'], id);
  assert.equal(JSON.parse(ups[0].body.toString('utf8')).prompt_cache_key, id);
  // no header and no metadata: no session id at all
  const { metadata: _drop, ...bare } = claudeBody('claude-opus-5-5');
  await call(bare);
  assert.equal(ups[1].headers['session-id'], undefined);
  assert.equal('prompt_cache_key' in JSON.parse(ups[1].body.toString('utf8')), false);
});

test('gpt lane: a redirect, or a 200 that is not an event stream, is 502 "unexpected answer" for a stream and for no stream; the body is cancelled; the line has the status and no counts', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  let cancelled = 0;
  const open = (status: number, type: string | null) => () => {
    const body = new ReadableStream({
      pull() {},
      cancel() {
        cancelled++;
      },
    });
    return new Response(body, { status, headers: type ? { 'content-type': type, location: 'https://example.com/x' } : { location: 'https://example.com/x' } });
  };
  let n = 0;
  for (const [status, type] of [[302, 'text/html'], [302, null], [200, 'application/json']] as [number, string | null][]) {
    for (const stream of [true, false]) {
      upstream = open(status, type);
      const r = await call(claudeBody('claude-opus-5-5', { stream }));
      assert.deepEqual([r.status, r.json], [502, { type: 'error', error: { type: 'api_error', message: `codex: unexpected answer ${status}` } }], `${status} ${type} ${stream}`);
      n++;
      const l = await lines(n);
      assert.deepEqual([l[n - 1].provider, l[n - 1].status, l[n - 1].input, l[n - 1].output], ['codex', status, null, null]);
    }
  }
  assert.equal(cancelled, 6);
  assert.ok(!outputs.some((o) => o.includes('example.com')), 'the location does not reach the client');
});

test('gpt lane: a 200 stream with no content-type (as chatgpt.com sends it, seen 2026-11-24) is converted', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  upstream = () => new Response(readFileSync(join(FIX, 'stream-text-captured.sse')), { status: 200 });
  const r = await call(claudeBody('claude-opus-5-5', { stream: true }));
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/event-stream');
  assert.match(r.text, /event: message_stop/);
});

test('gpt lane: an upstream error body that never ends is given up after the wait, and the client gets the mapped status at once', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  await proxy.close();
  const home = { fetch: fake, now: () => clock, accountsPath: FILE, accountHomes: HOMES, home: FAKE_HOME, env: { CLAUDE_CONFIG_DIR: join(FAKE_HOME, 'c'), CODEX_HOME: join(FAKE_HOME, 'x') }, platform: 'linux' };
  proxy = new AccountsProxy({ ...home, keyPath: KEY_FILE, gpt: () => gptCfg, errorBodyMs: 40, appendUsage: async (line) => void usage.push(line) });
  await proxy.sync({ enabled: true, port: 0 });
  key = await proxy.key();
  let stalled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    stalled = resolve;
  });
  upstream = () =>
    new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"detail":"par')), pull() {}, cancel: () => stalled() }), { status: 400, headers: { 'content-type': 'application/json' } });
  const r = await call(claudeBody('claude-opus-5-5'));
  assert.deepEqual([r.status, r.json], [400, { type: 'error', error: { type: 'invalid_request_error', message: 'codex: upstream error' } }], 'the part that came is not used');
  await cancelled;
});

test('gpt lane: error text from upstream is scrubbed in a status answer and in a failed stream', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  upstream = () => failure(400, { detail: 'org-EXAMPLE123456 owner@example.com 123e4567-e89b-12d3-a456-426614174000 ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd' });
  const r = await call(claudeBody('claude-opus-5-5'));
  assert.equal(r.json.error.message, 'codex: [redacted] [redacted] [redacted] [redacted]');
  const sse = `data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'bad org-EXAMPLE123456' } } })}\n\n`;
  upstream = () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const s = await call(claudeBody('claude-opus-5-5', { stream: false }));
  assert.equal(s.json.error.message, 'codex: bad [redacted]');
  const f = await call(claudeBody('claude-opus-5-5'));
  assert.ok(f.text.includes('codex: bad [redacted]') && !f.text.includes('EXAMPLE123456'));
});

test('gpt lane: the body is parsed once for the lane (the model name of the line comes from it); a body that is not JSON still passes through', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  const body = claudeBody('claude-opus-5-5');
  const real = JSON.parse;
  let parses = 0;
  JSON.parse = ((...a: Parameters<typeof JSON.parse>) => {
    const text = String(a[0]);
    if (text.includes('"user_example_session_1"') && text.includes('claude-opus-5-5')) parses++;
    return real(...a);
  }) as typeof JSON.parse;
  try {
    await call(body);
  } finally {
    JSON.parse = real;
  }
  assert.equal(parses, 1);
});

// ---- threads ----

test('ThreadStore: get and put, expiry by time, least recently touched goes first, a size budget, and an oversized thread is not kept', () => {
  let t = 1000;
  const mk = (n: number) => ({ system: 's', tools: null, messages: ['x'.repeat(n)], parent: null });
  const store = new ThreadStore({ maxThreads: 3, maxBytes: 1000, ttlMs: 100, now: () => t });
  assert.equal(store.get('a'), null);
  store.put('a', { system: 'sys', tools: [{ name: 'T' }], messages: [{ role: 'user', content: 'hi' }], parent: null });
  const got = store.get('a');
  assert.deepEqual([got?.system, got?.tools, got?.messages], ['sys', [{ name: 'T' }], [{ role: 'user', content: 'hi' }]]);
  assert.ok((got?.bytes ?? 0) > 0);
  // a hit refreshes the time
  t += 90;
  assert.ok(store.get('a'));
  t += 90;
  assert.ok(store.get('a'), 'touched 90 ms ago');
  t += 101;
  assert.equal(store.get('a'), null, 'expired');
  assert.equal(store.get('a'), null);
  // by count: the least recently touched goes
  t = 5000;
  for (const id of ['a', 'b', 'c']) store.put(id, mk(10));
  store.get('a');
  store.put('d', mk(10));
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => store.get(id) !== null), [true, false, true, true]);
  // by bytes
  const small = new ThreadStore({ maxThreads: 10, maxBytes: 300, ttlMs: 1e9, now: () => t });
  small.put('a', mk(100));
  small.put('b', mk(100));
  small.put('c', mk(100));
  assert.equal(small.get('a'), null, 'the oldest went to make room');
  assert.ok(small.get('b') && small.get('c'));
  small.put('big', mk(400));
  assert.equal(small.get('big'), null, 'larger than the whole budget: not kept');
  assert.ok(small.get('b') && small.get('c'), 'and nothing else was dropped for it');
  // a put under a known id replaces it
  small.put('b', mk(20));
  assert.deepEqual(small.get('b')?.messages, ['x'.repeat(20)]);
});

const threadTools = [{ name: 'get_time', description: 'The time.', input_schema: { type: 'object', properties: { tz: { type: 'string' } } } }];
const turnOne = (extra: Record<string, unknown> = {}) => ({ ...claudeBody('claude-opus-5-5'), tools: threadTools, thread: { type: 'create' }, diagnostics: { previous_message_id: null }, data_flow: { x: 1 }, ...extra });
const messageIdOf = (r: Got): string => (r.json ? String(r.json.id) : (frames(r.text)[0][1] as { message: { id: string } }).message.id);
const CALL_ID = 'call_b51e9239ae4f409c9a6e083f2b27decb';
const turnTwo = (previous: string, extra: Record<string, unknown> = {}) => {
  const { tools: _t, messages: _m, system: _s, ...rest } = claudeBody('claude-opus-5-5');
  return {
    ...rest,
    system: [{ type: 'text', text: 'Turn two system.' }],
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: CALL_ID, content: '12:00 UTC' }] }],
    thread: { type: 'continue', previous_message_id: previous },
    ...extra,
  };
};
/** The upstream body of turn 2 holds the whole conversation, with the turn-1 tools and the turn-2 system */
function checkRebuilt(sent: any): void {
  const types = sent.input.map((i: { type: string; role?: string }) => i.type + (i.role ? `:${i.role}` : ''));
  assert.ok(types.includes('message:user'), 'the turn-1 user message');
  const call = sent.input.find((i: { type: string }) => i.type === 'function_call');
  const out = sent.input.find((i: { type: string }) => i.type === 'function_call_output');
  assert.equal(call?.call_id, CALL_ID);
  assert.equal(out?.call_id, CALL_ID, 'the output answers the same call');
  assert.ok(types.indexOf('function_call') < types.indexOf('function_call_output'));
  assert.equal(sent.input[0].content[0].text, 'hello', 'the history comes first');
  assert.deepEqual(sent.tools.map((t: { name: string }) => t.name), ['get_time'], 'the turn-1 tools');
  assert.equal(sent.instructions, 'Turn two system.');
  for (const k of ['thread', 'diagnostics', 'data_flow']) assert.ok(!(k in sent), `${k} stays here`);
}

test('threads: a continue turn gets the stored history, tools and the new system (stream)', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  upstream = () => sseResponse('stream-tool-captured.sse');
  const first = await call(turnOne());
  assert.equal(first.status, 200);
  const id = messageIdOf(first);
  assert.match(id, /^msg_/);
  const second = await call(turnTwo(id));
  assert.equal(second.status, 200);
  assert.equal(ups.length, 2);
  checkRebuilt(JSON.parse(ups[1].body.toString('utf8')));
  assert.ok(!('thread' in JSON.parse(ups[0].body.toString('utf8'))));
  // a third turn continues from the answer to the second
  const id2 = messageIdOf(second);
  assert.notEqual(id2, '');
  const third = await call(turnTwo(id2));
  assert.equal(third.status, 200);
  assert.ok(JSON.parse(ups[2].body.toString('utf8')).input.length > JSON.parse(ups[1].body.toString('utf8')).input.length);
});

test('threads: the same for a client that asked for no stream; the id is the one of the JSON Message', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  upstream = () => sseResponse('stream-tool-captured.sse');
  const first = await call(turnOne({ stream: false }));
  assert.equal(first.status, 200);
  assert.equal(first.json.type, 'message');
  const second = await call(turnTwo(first.json.id, { stream: false }));
  assert.equal(second.status, 200);
  checkRebuilt(JSON.parse(ups[1].body.toString('utf8')));
});

test('threads: continue with an unknown id is 400 and nothing goes upstream or into the usage log', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  const r = await call(turnTwo('msg_unknown'));
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { type: 'error', error: { type: 'invalid_request_error', message: 'thread not found: the proxy keeps GPT lane threads in memory only; start a new conversation' } });
  assert.equal(ups.length, 0);
  assert.equal(usage.length, 0);
  const noId = await call(turnTwo('x', { thread: { type: 'continue' } }));
  assert.equal(noId.status, 400);
  assert.equal(ups.length, 0);
});

test('threads: a failed or cut turn stores nothing, and a body without thread stores nothing', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  upstream = () => sseResponse('stream-failed.sse');
  const failed = await call(turnOne());
  const failedId = (failed.text.match(/"id":"(msg_[^"]*)"/) ?? [])[1];
  assert.equal((await call(turnTwo(failedId ?? 'msg_failed'))).status, 400, 'continue on a failed turn');
  upstream = () => sseResponse('stream-cut.sse');
  const cut = await call(turnOne());
  const cutId = (cut.text.match(/"id":"(msg_[^"]*)"/) ?? [])[1];
  assert.equal((await call(turnTwo(cutId ?? 'msg_cut'))).status, 400, 'continue on a cut turn');
  upstream = () => sseResponse('stream-tool-captured.sse');
  const plain = await call(claudeBody('claude-opus-5-5', { tools: threadTools }));
  assert.equal(plain.status, 200);
  assert.equal((await call(turnTwo(messageIdOf(plain)))).status, 400, 'a request without thread is not kept');
});

// ---- threads: one entry per conversation, sweep, clear, early store ----

test('ThreadStore: delete, sweep and clear', () => {
  let t = 0;
  const store = new ThreadStore({ ttlMs: 100, now: () => t });
  const entry = { system: null, tools: null, messages: ['m'], parent: null };
  store.put('a', entry);
  t = 60;
  store.put('b', entry);
  assert.equal(store.size, 2);
  store.delete('a');
  assert.equal(store.size, 1);
  assert.equal(store.get('a'), null);
  t = 120;
  store.put('c', entry);
  t = 170;
  store.sweep();
  assert.equal(store.size, 1, 'b is past its time, c is not');
  assert.ok(store.get('c'));
  store.clear();
  assert.equal(store.size, 0);
  assert.equal(store.get('c'), null);
});

const heldThreads = (): number => (proxy as unknown as { threads: { size: number } }).threads.size;

test('threads: a conversation is one entry however long; two sessions interleaved keep working; an id that moved on is 400', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  // every answer gets a Response id of its own, as the real service gives
  let n = 0;
  upstream = () => new Response(readFileSync(join(FIX, 'stream-tool-captured.sse'), 'utf8').replaceAll('resp_0d345680552ec14a016b0536b9087887d094f725f7e693b9d9', `resp_unique${n++}`), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const first = await call(turnOne({ stream: false }));
  let a = first.json.id as string;
  const old = a;
  for (let i = 0; i < 79; i++) {
    const r = await call(turnTwo(a, { stream: false }));
    assert.equal(r.status, 200, `turn ${i + 2}`);
    a = r.json.id;
  }
  assert.ok(heldThreads() <= 2, '80 turns, at most two entries');
  assert.equal((await call(turnTwo(old, { stream: false }))).status, 400, 'an id that moved on');
  // two sessions, interleaved
  let b = (await call(turnOne({ stream: false }))).json.id as string;
  assert.ok(heldThreads() <= 3);
  for (let i = 0; i < 50; i++) {
    const ra = await call(turnTwo(a, { stream: false }));
    const rb = await call(turnTwo(b, { stream: false }));
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    a = ra.json.id;
    b = rb.json.id;
  }
  assert.ok(heldThreads() <= 4, 'two conversations, at most two entries each');
});

test('threads: the thread is kept when the client has message_stop, not when the upstream body ends', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  const bytes = readFileSync(join(FIX, 'stream-tool-captured.sse'));
  let release: () => void = () => {};
  const open = new Promise<void>((resolve) => (release = resolve));
  // the upstream sends the whole answer and keeps the body open until the test is done
  upstream = () =>
    new Response(
      new ReadableStream({
        async start(c) {
          c.enqueue(new Uint8Array(bytes));
          await open;
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const body = JSON.stringify(turnOne());
  const stopped = await new Promise<string>((resolve, reject) => {
    const req = httpRequest({ host: PROXY_HOST, port: portOf(), path: '/v1/messages', method: 'POST', agent: false, headers: { authorization: `Bearer ${key}` } });
    let seen = '';
    req.on('response', (res) => {
      res.on('data', (d: Buffer) => {
        seen += d.toString();
        if (seen.includes('event: message_stop')) {
          resolve((frames(seen)[0][1] as { message: { id: string } }).message.id);
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  upstream = () => sseResponse('stream-tool-captured.sse');
  const second = await call(turnTwo(stopped));
  release();
  assert.equal(second.status, 200, 'a continue sent right after message_stop');
});

// ---- threads: the latest entry and the one before it ----

const withStore = (o: ConstructorParameters<typeof ThreadStore>[0]) => ((proxy as unknown as { threads: unknown }).threads = new ThreadStore(o));
let uniq = 0;
const uniqueUpstream = () => {
  upstream = () => new Response(readFileSync(join(FIX, 'stream-tool-captured.sse'), 'utf8').replaceAll('resp_0d345680552ec14a016b0536b9087887d094f725f7e693b9d9', `resp_e2_${uniq++}`), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

test('threads: a conversation that goes on does not push another one out; a retry on the same id works', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  uniqueUpstream();
  // room for one conversation of two entries and one more thread
  const store = withStore({ maxThreads: 3 });
  const a1 = (await call(turnOne({ stream: false }))).json.id as string;
  const b1 = (await call(turnOne({ stream: false }))).json.id as string;
  let a = a1;
  for (let i = 0; i < 5; i++) a = (await call(turnTwo(a, { stream: false }))).json.id;
  assert.ok(store.size <= 3);
  assert.equal((await call(turnTwo(b1, { stream: false }))).status, 200, 'B still continues');
  // the same continue twice on one id: both answer
  const x = (await call(turnTwo(a, { stream: false }))).json.id as string;
  assert.equal((await call(turnTwo(x, { stream: false }))).status, 200);
  assert.equal((await call(turnTwo(x, { stream: false }))).status, 200, 'a retry on the same id');
  void a1;
});

test('threads: with a byte budget, a conversation of two entries and another thread survive a turn', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  uniqueUpstream();
  const big = (text: string) => ({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
  const probe = withStore({});
  const first = await call(turnOne({ stream: false, ...big('p'.repeat(20_000)) }));
  const size = (): number => [...(probe as unknown as { map: Map<string, { bytes: number }> }).map.values()][0].bytes;
  const one = size();
  // room for three entries of about this size, with a little to grow
  withStore({ maxBytes: Math.ceil(one * 3.4) });
  const a1 = (await call(turnOne({ stream: false, ...big('a'.repeat(20_000)) }))).json.id as string;
  const b1 = (await call(turnOne({ stream: false, ...big('b'.repeat(20_000)) }))).json.id as string;
  const a2 = (await call(turnTwo(a1, { stream: false }))).json.id as string;
  const a3 = (await call(turnTwo(a2, { stream: false }))).json.id as string;
  assert.equal((await call(turnTwo(b1, { stream: false }))).status, 200, 'B survived two turns of A');
  assert.equal((await call(turnTwo(a3, { stream: false }))).status, 200);
  void first;
});

test('threads: an 80-turn conversation holds at most two entries', async () => {
  await codex(CX.A, ACCOUNT_ID.A);
  uniqueUpstream();
  let id = (await call(turnOne({ stream: false }))).json.id as string;
  for (let i = 0; i < 79; i++) id = (await call(turnTwo(id, { stream: false }))).json.id;
  assert.ok(heldThreads() <= 2);
  assert.equal((await call(turnTwo(id, { stream: false }))).status, 200);
});
