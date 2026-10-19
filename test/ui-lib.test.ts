// The front end's pure helpers (public/lib/), run in node: relative times and durations, sizes, HTML escaping and the
// fetch wrappers (with a fake fetch). The DOM components are covered by the screenshot harness (docs/frontend-modules/).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { agoDays, agoMonths, ago, checkedAgo, hoursMinutes, lasting, span, usageMinutes } from '../public/lib/time.js';
import { bytes, gib, kib, pct } from '../public/lib/format.js';
import { escapeHtml } from '../public/lib/dom.js';
import { errorText, getJSON, post, postOrThrow, readJSON, tryJSON, writeInit } from '../public/lib/api.js';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const before = (ms: number) => new Date(NOW - ms).toISOString();
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

function atNow(fn: () => void) {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  try { fn(); } finally { mock.timers.reset(); }
}

test('ago: rounded minutes/hours/days, suffix after everything but 방금, floor for self-watch', () => atNow(() => {
  assert.equal(ago(before(20 * SEC)), '방금');
  assert.equal(ago(before(20 * SEC), { suffix: true }), '방금');
  assert.equal(ago(before(-5 * MIN)), '방금', 'a time in the future is 방금');
  assert.equal(ago(before(5 * MIN)), '5분');
  assert.equal(ago(before(5 * MIN), { suffix: true }), '5분 전');
  assert.equal(ago(before(90 * MIN)), '2시간');
  assert.equal(ago(before(90 * MIN), { suffix: true, floor: true }), '1시간 전');
  assert.equal(ago(before(47 * HOUR)), '47시간');
  assert.equal(ago(before(49 * HOUR)), '2일');
  assert.equal(ago(before(84 * HOUR), { floor: true }), '3일');
  assert.equal(ago(before(84 * HOUR)), '4일');
}));

test('agoMonths: floored, 전 always, hours under a day, days under 60, then months; null for no time', () => atNow(() => {
  assert.equal(agoMonths(null), null);
  assert.equal(agoMonths(before(59 * SEC)), '방금');
  assert.equal(agoMonths(before(61 * SEC)), '1분 전');
  assert.equal(agoMonths(before(23 * HOUR + 59 * MIN)), '23시간 전');
  assert.equal(agoMonths(before(25 * HOUR)), '1일 전');
  assert.equal(agoMonths(before(59 * DAY)), '59일 전');
  assert.equal(agoMonths(before(90 * DAY)), '3개월 전');
}));

test('agoDays: 오늘, N일 전, N개월 전; empty for no time', () => atNow(() => {
  assert.equal(agoDays(null), '');
  assert.equal(agoDays(before(5 * HOUR)), '오늘');
  assert.equal(agoDays(before(3 * DAY)), '3일 전');
  assert.equal(agoDays(before(29 * DAY)), '29일 전');
  assert.equal(agoDays(before(75 * DAY)), '3개월 전');
}));

test('lasting: N분째 / H시간 M분째, under a minute is the given word', () => atNow(() => {
  assert.equal(lasting(before(10 * SEC)), '방금');
  assert.equal(lasting(before(10 * SEC), '방금부터'), '방금부터');
  assert.equal(lasting(before(5 * MIN)), '5분째');
  assert.equal(lasting(before(2 * HOUR + 3 * MIN)), '2시간 3분째');
}));

test('checkedAgo: for a time in ms', () => atNow(() => {
  assert.equal(checkedAgo(NOW - 30 * SEC), '방금 확인');
  assert.equal(checkedAgo(NOW - 3 * MIN), '3분 전에 확인');
  assert.equal(checkedAgo(NOW - 5 * HOUR), '5시간 전에 확인');
}));

test('span, usageMinutes, hoursMinutes: the three duration wordings', () => {
  assert.equal(span(10 * SEC), '1분');
  assert.equal(span(59 * MIN), '59분');
  assert.equal(span(90 * MIN), '2시간');
  assert.equal(span(3 * DAY), '3일');

  assert.equal(usageMinutes(0.5), '1분 미만');
  assert.equal(usageMinutes(20.4), '20분');
  assert.equal(usageMinutes(90), '1.5시간');
  assert.equal(usageMinutes(120), '2시간');
  assert.equal(usageMinutes(660), '11시간');

  assert.equal(hoursMinutes(0), '—');
  assert.equal(hoursMinutes(0.3), '1분');
  assert.equal(hoursMinutes(180), '3시간');
  assert.equal(hoursMinutes(200), '3시간 20분');
  assert.equal(hoursMinutes(48 * 60), '2일');
});

test('format: bytes, gib, kib, pct', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(3482), '3.4 KB');
  assert.equal(bytes(12 * 1024 ** 2), '12 MB');
  assert.equal(gib(null), null);
  assert.equal(gib(512 * 1024 ** 2), '512 MB');
  assert.equal(gib(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(gib(12 * 1024 ** 3), '12 GB');
  assert.equal(kib(null), '');
  assert.equal(kib(300 * 1024), '300MB');
  assert.equal(kib(1.25 * 1024 * 1024), '1.3GB');
  assert.equal(pct(1, 4), '25%');
  assert.equal(pct(null, 4), null);
  assert.equal(pct(1, 0), null);
});

test('escapeHtml: text and quoted attributes stay text', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(8790), '8790');
});

/** Swap globalThis.fetch for one call sequence; returns what was requested */
function fakeFetch(answers: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a!;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('writeInit: every write carries X-Portboard; a JSON body only when there is one', () => {
  assert.deepEqual(writeInit(undefined), { method: 'POST', headers: { 'X-Portboard': '1' } });
  assert.deepEqual(writeInit({ a: 1 }), { method: 'POST', headers: { 'X-Portboard': '1', 'content-type': 'application/json' }, body: '{"a":1}' });
});

test('post: { ok, status, body }, body {} when the answer is not JSON; errorText prefers the server error', async () => {
  const f = fakeFetch([json({ message: 'ok' }), new Response('oops', { status: 502 }), json({ error: 'bad port' }, 400)]);
  try {
    assert.deepEqual(await post('/api/ports/1/expose'), { ok: true, status: 200, body: { message: 'ok' } });
    const r = await post('/api/x', { a: 1 });
    assert.deepEqual(r, { ok: false, status: 502, body: {} });
    assert.equal(errorText(r), 'HTTP 502');
    await assert.rejects(postOrThrow('/api/y', {}), /bad port/);
    assert.equal(f.calls[0].url, '/api/ports/1/expose');
    assert.equal((f.calls[0].init!.headers as Record<string, string>)['X-Portboard'], '1');
    assert.equal(f.calls[1].init!.body, '{"a":1}');
  } finally {
    f.restore();
  }
});

test('getJSON throws on a non-2xx; readJSON reads it anyway; tryJSON gives null on failure', async () => {
  const f = fakeFetch([json({ error: 'x' }, 500), json({ message: '로그가 없어요' }, 404), json({}, 503), new Error('offline'), json({ ok: 1 })]);
  try {
    await assert.rejects(getJSON('/api/ports'), /HTTP 500/);
    assert.deepEqual(await readJSON('/api/ports/1/logs'), { message: '로그가 없어요' });
    assert.equal(await tryJSON('/api/devices'), null);
    assert.equal(await tryJSON('/api/devices'), null);
    assert.deepEqual(await tryJSON('/api/devices'), { ok: 1 });
  } finally {
    f.restore();
  }
});
