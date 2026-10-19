import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlFor, pickFreePorts } from '../src/core/control.ts';
import { kindOf } from '../src/core/index.ts';
import { applyPatch, checkPatch, loadPrefs, setPortPrefs } from '../src/core/prefs.ts';

test('kindOf: containers are apps, unowned is system, high unit-less ports are ephemeral', () => {
  const proc = (unit: string | null) => [{ unit }];
  assert.equal(kindOf({ port: 54321, owned: false, container: 'kong', processes: [] }), 'app');
  assert.equal(kindOf({ port: 22, owned: false, container: null, processes: [] }), 'system');
  assert.equal(kindOf({ port: 46389, owned: true, container: null, processes: proc(null) }), 'ephemeral');
  assert.equal(kindOf({ port: 46389, owned: true, container: null, processes: proc('x.service') }), 'app');
  assert.equal(kindOf({ port: 5281, owned: true, container: null, processes: proc(null) }), 'app');
});

test('controlFor prefers systemd, then docker, then the process', () => {
  assert.deepEqual(controlFor({ container: 'c', processes: [{ pid: 1, unit: 'a.service' }] }), { type: 'systemd', unit: 'a.service' });
  assert.deepEqual(controlFor({ container: 'c', processes: [] }), { type: 'docker', container: 'c' });
  assert.deepEqual(controlFor({ container: null, processes: [{ pid: 7, unit: null }] }), { type: 'process', pids: [7] });
  assert.equal(controlFor({ container: null, processes: [] }), null);
});

test('pickFreePorts skips taken and ephemeral ports and wraps to 3000', () => {
  assert.deepEqual(pickFreePorts(new Set([3000, 3001]), 2), [3002, 3003]);
  assert.deepEqual(pickFreePorts(new Set([8780]), 2, 8780), [8781, 8782]);
  assert.deepEqual(pickFreePorts(new Set(), 1, 9999), [9999]);
  assert.deepEqual(pickFreePorts(new Set([9999]), 1, 9999), [3000]);
  assert.deepEqual(pickFreePorts(new Set(), 1, 40000), [61000]);
});

test('prefs patches: validation, label trimming/clearing, false removes flags', () => {
  assert.equal(checkPatch({ label: 'x', pinned: true }), null);
  assert.match(checkPatch({ pinned: 'yes' }) ?? '', /boolean/);
  assert.match(checkPatch({ color: 'red' }) ?? '', /unknown field/);
  assert.match(checkPatch([]) ?? '', /object/);
  assert.deepEqual(applyPatch({}, { label: '  uploader ', pinned: true }), { label: 'uploader', pinned: true });
  assert.deepEqual(applyPatch({ label: 'a', pinned: true }, { label: '', pinned: false, hidden: true }), { hidden: true });
  assert.deepEqual(applyPatch({ label: 'a' }, { label: null }), {});
});

test('setPortPrefs writes atomically and drops empty entries', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'portboard-')), 'sub', 'prefs.json');
  await Promise.all([setPortPrefs(8780, { label: 'uploader' }, path), setPortPrefs(5281, { pinned: true }, path)]);
  assert.deepEqual((await loadPrefs(path)).ports, { 8780: { label: 'uploader' }, 5281: { pinned: true } });
  await setPortPrefs(5281, { pinned: false }, path);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).ports, { 8780: { label: 'uploader' } });
});
