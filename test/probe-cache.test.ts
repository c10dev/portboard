import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTTP_TTL, NON_HTTP_TTL, probe, probeKey, pruneProbes, resetProbes, type Probe } from '../src/core/probe.ts';

const HTTP: Probe = { http: true, status: 200, title: 'x' };
const NOT: Probe = { http: false, status: null, title: null };

function fakeFetcher(results: Probe[]) {
  const calls: string[] = [];
  let i = 0;
  const f = async (url: string) => {
    calls.push(url);
    return results[Math.min(i++, results.length - 1)];
  };
  return { f, calls };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a new listener waits for its probe; a known one answers from cache', async () => {
  resetProbes();
  const { f, calls } = fakeFetcher([HTTP]);
  assert.deepEqual(await probe('127.0.0.1', 3000, 1, 0, f), HTTP);
  assert.deepEqual(await probe('127.0.0.1', 3000, 1, 1000, f), HTTP);
  assert.equal(calls.length, 1);
});

test('an expired entry returns the old value at once and refreshes in the background (single-flight)', async () => {
  resetProbes();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    if (calls.length === 1) return HTTP;
    await gate;
    return { http: true, status: 503, title: 'down' } as Probe;
  };
  await probe('127.0.0.1', 3000, 1, 0, f);
  const t = HTTP_TTL + 1;
  assert.deepEqual(await probe('127.0.0.1', 3000, 1, t, f), HTTP); // stale, no wait
  assert.deepEqual(await probe('127.0.0.1', 3000, 1, t, f), HTTP); // refresh already in flight
  assert.equal(calls.length, 2);
  release();
  await tick();
  await tick();
  assert.equal((await probe('127.0.0.1', 3000, 1, t + 1, f))!.status, 503);
});

test('non-HTTP results are re-checked rarely; skipped ports are never probed', async () => {
  resetProbes();
  const { f, calls } = fakeFetcher([NOT, HTTP]);
  await probe('127.0.0.1', 7721, 9, 0, f);
  await probe('127.0.0.1', 7721, 9, HTTP_TTL + 1, f);
  assert.equal(calls.length, 1, 'still fresh for non-HTTP');
  await probe('127.0.0.1', 7721, 9, NON_HTTP_TTL + 1, f);
  assert.equal(calls.length, 2);
  assert.equal(await probe('127.0.0.1', 22, 1, 0, f), null);
  assert.equal(calls.length, 2);
});

test('a new pid on the same port is a new listener; prune drops gone listeners', async () => {
  resetProbes();
  const { f, calls } = fakeFetcher([HTTP]);
  await probe('127.0.0.1', 5173, 1, 0, f);
  await probe('127.0.0.1', 5173, 2, 0, f);
  assert.equal(calls.length, 2);
  assert.equal(pruneProbes(new Set([probeKey('127.0.0.1', 5173, 2)])), 1);
  await probe('127.0.0.1', 5173, 1, 0, f);
  assert.equal(calls.length, 3);
});

test('runShared shares one subprocess within the TTL and forgetShared drops it', async () => {
  const { runShared, forgetShared, runStats } = await import('../src/core/exec.ts');
  const before = runStats().byCommand.true ?? 0;
  await Promise.all([runShared('true', [], 5_000, 1), runShared('true', [], 5_000, 2)]);
  assert.equal((runStats().byCommand.true ?? 0) - before, 1);
  await runShared('true', [], 5_000, 10_000);
  assert.equal((runStats().byCommand.true ?? 0) - before, 2);
  forgetShared('true', []);
  await runShared('true', [], 5_000, 10_001);
  assert.equal((runStats().byCommand.true ?? 0) - before, 3);
});
