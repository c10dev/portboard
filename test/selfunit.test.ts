// Portboard's own units and processes (src/core/selfunit.ts): what stop refuses and the new-port and idle checks skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPortboardProcess, isPortboardUnit } from '../src/core/selfunit.ts';

test('isPortboardUnit: portboard.service and the units install-service writes, nothing else', () => {
  for (const u of ['portboard.service', 'portboard-remote.service', 'portboard-agent.service']) assert.equal(isPortboardUnit(u), true, u);
  for (const u of ['portboard-x.timer', 'pb-dev-shop-web.service', 'my-portboard.service', 'portboard.service.bak', '', null, undefined]) {
    assert.equal(isPortboardUnit(u), false, String(u));
  }
});

test('isPortboardProcess: this process or a Portboard unit; another pid without a Portboard unit is not', () => {
  assert.equal(isPortboardProcess([{ pid: 4242, unit: null }], 4242), true);
  assert.equal(isPortboardProcess([{ pid: 1, unit: 'portboard-remote.service' }], 4242), true);
  assert.equal(isPortboardProcess([{ pid: 1, unit: 'shop-web.service' }, { pid: 2, unit: null }], 4242), false);
  assert.equal(isPortboardProcess([], 4242), false);
});
