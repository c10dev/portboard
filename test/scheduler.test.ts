import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/features/jobs.ts';
import type { ServerContext } from '../src/features/context.ts';

const ctx = {} as ServerContext;
const flush = () => new Promise((r) => setImmediate(r));

test('runAtStart jobs run on the first tick; others wait an interval (+ jitter)', async () => {
  let t = 0;
  const s = new Scheduler({ now: () => t, random: () => 0.5, jitter: 0.2 });
  s.add({ name: 'a', everyMs: 10_000, runAtStart: true, run() {} }, ctx);
  s.add({ name: 'b', everyMs: 10_000, run() {} }, ctx);
  assert.deepEqual(s.tick(), ['a']);
  await flush();
  t = 10_999;
  assert.deepEqual(s.tick(), []);
  t = 11_000; // 10 s + 0.5 × min(2 s, 5 s)
  assert.deepEqual(s.tick(), ['a', 'b']);
});

test('a job never overlaps itself; errors are isolated and logged once per distinct message', async () => {
  let t = 0;
  const logs: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const s = new Scheduler({ now: () => t, random: () => 0, log: (l) => logs.push(l) });
  s.add({ name: 'slow', everyMs: 1_000, runAtStart: true, run: () => slow }, ctx);
  s.add({ name: 'bad', everyMs: 1_000, runAtStart: true, run() { throw new Error('boom'); } }, ctx);
  assert.deepEqual(s.tick(), ['slow', 'bad']);
  await flush();
  t = 1_000;
  assert.deepEqual(s.tick(), ['bad'], 'slow is still running');
  await flush();
  release();
  await flush();
  t = 2_000;
  assert.deepEqual(s.tick(), ['slow', 'bad']);
  await flush();
  const bad = s.states().find((x) => x.name === 'bad')!;
  assert.equal(bad.errors, 3);
  assert.equal(bad.lastError, 'boom');
  assert.equal(logs.length, 1);
});

test('heavy jobs take turns: a due one waits for the running one, then starts on the next tick', async () => {
  let t = 0;
  let release!: () => void;
  const scan = new Promise<void>((r) => (release = r));
  const s = new Scheduler({ now: () => t, random: () => 0 });
  s.add({ name: 'worktrees', everyMs: 60_000, runAtStart: true, heavy: true, run: () => scan }, ctx);
  s.add({ name: 'adoption', everyMs: 60_000, runAtStart: true, heavy: true, run() {} }, ctx);
  s.add({ name: 'light', everyMs: 1_000, runAtStart: true, run() {} }, ctx);
  assert.deepEqual(s.tick(), ['worktrees', 'light']);
  await flush();
  t = 1_000;
  assert.deepEqual(s.tick(), ['light'], 'adoption is due but worktrees is still running');
  release();
  await flush();
  t = 2_000;
  assert.deepEqual(s.tick(), ['adoption', 'light']);
  assert.equal(s.states().find((x) => x.name === 'adoption')!.nextAt, 62_000, 'its interval counts from when it started');
});
