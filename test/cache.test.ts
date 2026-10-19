import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyedCache, TtlMap, ttlCache } from '../src/core/cache.ts';
import { readCwd, readProcText, scanProcs } from '../src/core/proc.ts';
import { Scheduler } from '../src/features/jobs.ts';
import type { ServerContext } from '../src/features/context.ts';

/** A promise the test resolves or rejects by hand */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setImmediate(r));

// ---- ttlCache ----

test('ttlCache: a result is reused for ttlMs, then computed again', async () => {
  let t = 0;
  let n = 0;
  const c = ttlCache(async () => ++n, { ttlMs: 1_000, now: () => t });
  assert.equal(await c(), 1);
  t = 999;
  assert.equal(await c(), 1);
  t = 1_000;
  assert.equal(await c(), 2);
  c.clear();
  assert.equal(await c(), 3);
});

test('ttlCache: callers while it is computing share one run; arguments go to load on a miss only', async () => {
  const d = deferred<string>();
  const seen: string[] = [];
  const c = ttlCache((path: string) => (seen.push(path), d.promise), { ttlMs: 1_000, now: () => 0 });
  const a = c('a');
  const b = c('b');
  assert.equal(a, b);
  d.resolve('x');
  assert.deepEqual(await Promise.all([a, b]), ['x', 'x']);
  assert.deepEqual(seen, ['a']);
});

test('ttlCache: an error is not cached, unless cacheErrors', async () => {
  let n = 0;
  const failing = ttlCache(async () => {
    n++;
    throw new Error('boom');
  }, { ttlMs: 60_000, now: () => 0 });
  await assert.rejects(failing(), /boom/);
  await assert.rejects(failing(), /boom/);
  assert.equal(n, 2);

  let m = 0;
  const kept = ttlCache(async () => {
    m++;
    throw new Error('boom');
  }, { ttlMs: 60_000, cacheErrors: true, now: () => 0 });
  await assert.rejects(kept(), /boom/);
  await assert.rejects(kept(), /boom/);
  assert.equal(m, 1);
});

// ---- keyedCache ----

test('keyedCache: per key TTL and in-flight sharing', async () => {
  let t = 0;
  const d = deferred<number>();
  const calls: string[] = [];
  const c = keyedCache((k: string) => (calls.push(k), k === 'slow' ? d.promise : Promise.resolve(k.length)), { ttlMs: 100, now: () => t });
  const a = c('slow');
  assert.equal(c('slow'), a);
  d.resolve(4);
  assert.equal(await a, 4);
  assert.equal(await c('ab'), 2);
  t = 99;
  await c('ab');
  t = 100;
  await c('ab');
  assert.deepEqual(calls, ['slow', 'ab', 'ab']);
});

test('keyedCache: maxEntries drops expired keys first, then the oldest', async () => {
  let t = 0;
  let n = 0;
  const c = keyedCache(async (k: string) => `${k}${++n}`, { ttlMs: 100, maxEntries: 2, now: () => t });
  await c('a');
  t = 50;
  await c('b');
  t = 120; // a has expired, b hasn't
  await c('c'); // drops a (expired), keeps b
  assert.equal(c.size, 2);
  assert.equal(await c('b'), 'b2');
  await c('d'); // full and nothing expired: the oldest (b) goes
  assert.equal(c.size, 2);
  assert.equal(await c('c'), 'c3');
  assert.equal(await c('b'), 'b5');
});

test('keyedCache: a rejected key is dropped; shortMs shortens a result’s life from when it resolved', async () => {
  let t = 0;
  let n = 0;
  const c = keyedCache(
    async (k: string) => {
      n++;
      if (k === 'bad') throw new Error('no');
      return k === 'miss' ? null : k;
    },
    { ttlMs: 1_000, shortMs: (v) => (v === null ? 10 : null), now: () => t },
  );
  await assert.rejects(c('bad'), /no/);
  await flush();
  await assert.rejects(c('bad'), /no/);
  assert.equal(n, 2);
  await c('miss');
  await flush();
  t = 9;
  await c('miss');
  assert.equal(n, 3);
  t = 10;
  await c('miss');
  assert.equal(n, 4);
  await c('hit');
  t = 999;
  await c('hit');
  assert.equal(n, 5);
});

// ---- TtlMap ----

test('TtlMap: get/has only while fresh, peek however old, per-entry ttl, bounded', () => {
  let t = 0;
  const m = new TtlMap<string, string | null>({ ttlMs: 100, maxEntries: 2, now: () => t });
  m.set('a', null);
  assert.equal(m.has('a'), true);
  assert.equal(m.get('a'), null);
  m.set('b', 'short', 10);
  t = 10;
  assert.equal(m.has('b'), false);
  assert.equal(m.get('b'), undefined);
  assert.equal(m.peek('b'), 'short');
  m.set('c', 'x'); // full: the expired b goes, a stays
  assert.equal(m.size, 2);
  assert.equal(m.has('a'), true);
  assert.equal(m.peek('b'), undefined);
});

// ---- the shared /proc reader ----

test('scanProcs / readProcText / readCwd: numeric entries only, unreadable ones left out, " (deleted)" reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-proc-'));
  for (const pid of ['1', '42', '7']) mkdirSync(join(root, pid));
  mkdirSync(join(root, 'self'));
  writeFileSync(join(root, '1', 'stat'), 'one');
  writeFileSync(join(root, '42', 'stat'), 'forty-two');
  symlinkSync('/srv/app', join(root, '1', 'cwd'));
  symlinkSync('/srv/old (deleted)', join(root, '42', 'cwd'));
  const stats = await scanProcs(async (pid) => {
    const s = await readProcText(pid, 'stat', root);
    return s === null ? null : `${pid}:${s}`;
  }, root);
  assert.deepEqual(stats.sort(), ['1:one', '42:forty-two']);
  assert.deepEqual(await readCwd(1, root), { path: '/srv/app', deleted: false });
  assert.deepEqual(await readCwd(42, root), { path: '/srv/old', deleted: true });
  assert.equal(await readCwd(7, root), null);
});

// ---- the scheduler runs the alert checker and the self-watch ----

test('scheduler: firstAfterMs sets the first run (the self-watch looks 20 s after start), then every interval', async () => {
  let t = 0;
  const runs: number[] = [];
  const s = new Scheduler({ now: () => t, random: () => 0 });
  s.add({ name: 'selfwatch', everyMs: 60_000, firstAfterMs: 20_000, run: () => void runs.push(t) }, {} as ServerContext);
  assert.deepEqual(s.tick(), []);
  t = 19_999;
  assert.deepEqual(s.tick(), []);
  t = 20_000;
  assert.deepEqual(s.tick(), ['selfwatch']);
  await flush();
  t = 79_999;
  assert.deepEqual(s.tick(), []);
  t = 80_000;
  assert.deepEqual(s.tick(), ['selfwatch']);
  await flush();
  assert.deepEqual(runs, [20_000, 80_000]);
});
