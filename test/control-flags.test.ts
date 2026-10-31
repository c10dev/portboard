// controlFlags and stop() (src/core/index.ts): a Portboard process is never stoppable, with or without a unit.
// The snapshot sets canStop from controlFlags; stop() and cleanup (features/owners.ts eligible) trust canStop for a
// process owner, because stopTarget only knows Portboard's unit names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = await mkdtemp(join(tmpdir(), 'pb-flags-'));
process.env.HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith('PORTBOARD_') && k !== 'PORTBOARD_LOCALE') delete process.env[k];

const { controlFlags, stop } = await import('../src/core/index.ts');
const { eligible } = await import('../src/features/owners.ts');

const CHECKOUT = join(HOME, 'wt', 'preview');
await mkdir(CHECKOUT, { recursive: true });
await writeFile(join(CHECKOUT, 'package.json'), JSON.stringify({ name: '@c10dev/portboard' }));
const OTHER = join(HOME, 'shop-web');
await mkdir(OTHER, { recursive: true });
await writeFile(join(OTHER, 'package.json'), JSON.stringify({ name: 'shop-web' }));

const PID = 2 ** 22 + 7;
const proc = (cmdline: string, cwd: string, unit: string | null = null) => ({ pid: PID, cmdline, cwd, project: null, unit, unitDescription: null });
const OPTS = { readOnly: false, unitsManaged: true, selfPid: 1 };

test('controlFlags: a Portboard process without a unit (a preview, node src/server.ts in a checkout) cannot be stopped', () => {
  const control = { type: 'process' as const, pids: [PID] };
  // the default isCheckout reads package.json
  const preview = controlFlags([proc('node src/server.ts', CHECKOUT)], control, OPTS);
  assert.deepEqual(preview, { canRestart: false, canStop: false, isPortboard: true });
  const other = controlFlags([proc('node src/server.ts', OTHER)], control, OPTS);
  assert.deepEqual(other, { canRestart: false, canStop: true, isPortboard: false }, 'another project with the same entry point');
  assert.equal(controlFlags([proc('node server.js', OTHER)], { type: 'process', pids: [PID] }, { ...OPTS, selfPid: PID }).canStop, false, 'this process');
  assert.equal(controlFlags([proc('node server.js', OTHER)], control, { ...OPTS, readOnly: true }).canStop, false, 'read-only');
  assert.equal(controlFlags([proc('node server.js', OTHER)], null, OPTS).canStop, false, 'no owner');
});

test('controlFlags: units and containers', () => {
  const unit = { type: 'systemd' as const, unit: 'shop.service' };
  assert.deepEqual(controlFlags([proc('node server.js', OTHER, 'shop.service')], unit, OPTS), { canRestart: true, canStop: true, isPortboard: false });
  assert.deepEqual(controlFlags([proc('node server.js', OTHER, 'shop.service')], unit, { ...OPTS, unitsManaged: false }), { canRestart: false, canStop: false, isPortboard: false });
  const self = { type: 'systemd' as const, unit: 'portboard.service' };
  assert.deepEqual(controlFlags([proc('node bin/portboard', OTHER, 'portboard.service')], self, OPTS), { canRestart: true, canStop: false, isPortboard: true });
  assert.deepEqual(controlFlags([], { type: 'docker', container: 'db' }, OPTS), { canRestart: true, canStop: true, isPortboard: false });
});

test('stop() refuses an owner with canStop false before it sends anything; cleanup does not take it', async () => {
  const entry = { port: 3999, listening: true, owned: true, container: null, processes: [proc('node src/server.ts', CHECKOUT)], control: { type: 'process', pids: [PID] }, canStop: false };
  const snap = async () => ({ ports: [entry] }) as any;
  assert.deepEqual(await stop(3999, snap), { ok: false, message: 'refusing to stop portboard itself' });
  assert.deepEqual(await stop(3998, snap), { ok: false, message: 'nothing is listening on 3998' });
  assert.equal(eligible(entry as any), false);
});
