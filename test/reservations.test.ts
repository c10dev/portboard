import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReservations, normalizeOwner, release, reserve, reservedFor } from '../src/core/reservations.ts';
import { matchesOwner } from '../src/features/reservations.ts';

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
  const r = await release(4002, path);
  assert.equal(r.ok, true);
  assert.equal(r.released?.owner, 'b');
  assert.deepEqual((await loadReservations(path)).map((x) => x.port), [4001, 4003]);
  assert.deepEqual(await release(4002, path), { ok: false, released: null });
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
