// isPortboardCheckout (src/core/checkout.ts): a folder is Portboard when its package.json says so, ~/ included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPortboardCheckout } from '../src/core/checkout.ts';

test('isPortboardCheckout: package.json named portboard or @c10dev/portboard; anything else or none is not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pb-checkout-'));
  const pkg = async (dir: string, body: string) => (await mkdir(join(home, dir), { recursive: true }), writeFile(join(home, dir, 'package.json'), body));
  await pkg('portboard', JSON.stringify({ name: 'portboard' }));
  await pkg('wt/feat-x', JSON.stringify({ name: '@c10dev/portboard' }));
  await pkg('portboard-landing', JSON.stringify({ name: 'portboard-landing' }));
  await pkg('broken', '{ not json');
  await mkdir(join(home, 'empty'));
  assert.equal(isPortboardCheckout(join(home, 'portboard'), home), true);
  assert.equal(isPortboardCheckout(join(home, 'wt/feat-x'), home), true, 'a worktree under any folder name');
  assert.equal(isPortboardCheckout('~/portboard', home), true, 'shortPath() form');
  assert.equal(isPortboardCheckout(join(home, 'portboard-landing'), home), false);
  assert.equal(isPortboardCheckout(join(home, 'broken'), home), false);
  assert.equal(isPortboardCheckout(join(home, 'empty'), home), false);
  assert.equal(isPortboardCheckout(join(home, 'missing'), home), false);
  // a no is not cached: the folder is read again
  await pkg('missing', JSON.stringify({ name: '@c10dev/portboard' }));
  assert.equal(isPortboardCheckout(join(home, 'missing'), home), true);
});
