import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReservations, normalizeOwner, release, reserve, reservedFor } from '../src/core/reservations.ts';
import { matchesOwner } from '../src/features/reservations.ts';
import { callTool } from '../src/mcp/tools.ts';

const tmp = async () => join(await mkdtemp(join(tmpdir(), 'pb-resv-')), 'reservations.json');

test('reserve: explicit port, existing reservation reused, conflicts refused, free pick when no port', async () => {
  const path = await tmp();
  let picks = 0;
  const pick = async () => (picks++, 4100);
  const a = await reserve('shop-web', 5281, 'vite', pick, path);
  assert.equal(a.ok && a.reservation.port, 5281);
  const again = await reserve('shop-web', undefined, undefined, pick, path);
  assert.ok(again.ok && again.existing && again.reservation.port === 5281, 'owner without port gets its existing port');
  const clash = await reserve('uploader', 5281, undefined, pick, path);
  assert.deepEqual(clash, { ok: false, error: '5281 is reserved for shop-web' });
  const fresh = await reserve('uploader', undefined, undefined, pick, path);
  assert.ok(fresh.ok && fresh.reservation.port === 4100 && !fresh.existing);
  assert.equal(picks, 1);
  assert.deepEqual((await loadReservations(path)).map((r) => [r.port, r.owner]), [[4100, 'uploader'], [5281, 'shop-web']]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1);
});

test('release and concurrent writes', async () => {
  const path = await tmp();
  const pick = async () => undefined;
  await Promise.all([reserve('a', 4001, undefined, pick, path), reserve('b', 4002, undefined, pick, path), reserve('c', 4003, undefined, pick, path)]);
  assert.equal((await loadReservations(path)).length, 3);
  const r = await release(4002, null, path);
  assert.equal(r.ok, true);
  assert.equal(r.released?.owner, 'b');
  assert.deepEqual((await loadReservations(path)).map((x) => x.port), [4001, 4003]);
  assert.deepEqual(await release(4002, null, path), { ok: false, released: null });
});

test('release with an owner: only that owner\'s reservation goes; another owner\'s stays and comes back as heldBy', async () => {
  const path = await tmp();
  const pick = async () => undefined;
  await reserve('shop-web@feat', 4201, undefined, pick, path);
  assert.deepEqual(await release(4201, 'billing@main', path), { ok: false, released: null, heldBy: 'shop-web@feat' });
  assert.deepEqual((await loadReservations(path)).map((r) => [r.port, r.owner]), [[4201, 'shop-web@feat']]);
  const mine = await release(4201, 'shop-web@feat', path);
  assert.equal(mine.ok, true);
  assert.equal(mine.released?.owner, 'shop-web@feat');
  assert.deepEqual(await loadReservations(path), []);
  assert.deepEqual(await release(4201, 'shop-web@feat', path), { ok: false, released: null }, 'nothing reserved: not an owner mismatch');
});

test('release_port: owner is required, and another owner\'s reservation is refused with who holds it', async () => {
  const calls: unknown[][] = [];
  const core = {
    releasePort: async (port: number, owner: string) => (
      calls.push([port, owner]),
      owner === 'shop-web@feat' ? { ok: true, released: { port, owner, createdAt: '' } } : { ok: false, released: null, heldBy: 'shop-web@feat' }
    ),
  } as any;
  const missing = await callTool('release_port', { port: 4201 }, core);
  assert.equal(missing.isError, true);
  assert.deepEqual(calls, [], 'nothing is released without an owner');
  const other = await callTool('release_port', { port: 4201, owner: 'billing@main' }, core);
  assert.equal(other.isError, true);
  assert.equal(other.content[0].text, '4201 is reserved for shop-web@feat, not billing@main');
  const mine = await callTool('release_port', { port: 4201, owner: ' shop-web@feat ' }, core);
  assert.equal(mine.isError, undefined);
  assert.deepEqual(calls, [[4201, 'billing@main'], [4201, 'shop-web@feat']], 'the owner is normalized as reserve_port does');
});

test('reservedFor blocks other owners and lists the owner\'s own first', () => {
  const list = [{ port: 5281, owner: 'shop-web', createdAt: '' }, { port: 8780, owner: 'uploader', createdAt: '' }, { port: 5282, owner: 'shop-web', createdAt: '' }];
  assert.deepEqual(reservedFor(list, 'shop-web'), { blocked: new Set([8780]), own: [5281, 5282] });
  assert.deepEqual(reservedFor(list, null), { blocked: new Set([5281, 8780, 5282]), own: [] });
});

test('normalizeOwner and matchesOwner', () => {
  assert.equal(normalizeOwner('  shop-web @ main '), 'shop-web @ main');
  assert.equal(normalizeOwner(''), null);
  assert.equal(normalizeOwner('x'.repeat(121)), null);
  assert.equal(matchesOwner('shop-web', 'worktrees/shop-web-1786/3d-redesign'), true);
  assert.equal(matchesOwner('uploader', 'webapp'), false);
  assert.equal(matchesOwner('uploader', null), null);
});

test('loadReservations: a missing file is an empty list; a broken file throws and reserve leaves it as it is', async () => {
  const path = await tmp();
  assert.deepEqual(await loadReservations(path), []);
  const broken = '{"version":1,"reservations":[{"port":3001,"owner":"shop-web","createdAt":""},{"port":3002,"owner":"api","createdAt":""},]}\n';
  await writeFile(path, broken);
  await assert.rejects(loadReservations(path), /cannot parse reservations\.json/);
  await assert.rejects(reserve('blog', 3001, undefined, async () => undefined, path), /cannot parse reservations\.json/);
  await assert.rejects(release(3002, null, path), /cannot parse reservations\.json/);
  assert.equal(await readFile(path, 'utf8'), broken, 'the file is not replaced');
  await writeFile(path, '{"version":1}\n');
  await assert.rejects(loadReservations(path), /no reservations list/);
  // the queue still runs after a failed job
  await writeFile(path, '{"version":1,"reservations":[]}\n');
  const ok = await reserve('blog', 3001, undefined, async () => undefined, path);
  assert.equal(ok.ok, true);
});

test('reserve without a port at the same time: each owner gets its own free port', async () => {
  const path = await tmp();
  // as freePorts does: the first port that the file does not hold
  const pick = async () => {
    const held = new Set((await loadReservations(path)).map((r) => r.port));
    return [4000, 4001, 4002].find((p) => !held.has(p));
  };
  const [a, b] = await Promise.all([reserve('a', undefined, undefined, pick, path), reserve('b', undefined, undefined, pick, path)]);
  assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
  assert.deepEqual([a.reservation.port, b.reservation.port], [4000, 4001]);
  assert.deepEqual((await loadReservations(path)).map((r) => [r.port, r.owner]), [[4000, 'a'], [4001, 'b']]);
  assert.deepEqual(await reserve('c', undefined, undefined, async () => undefined, path), { ok: false, error: 'no free port found' });
});
