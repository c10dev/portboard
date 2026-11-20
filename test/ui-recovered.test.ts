// Row flash on recovery (public/features/alerts.js): which ports came back, and the one-shot take.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveredPorts, takeRecovered } from '../public/features/alerts.js';

const w = (key: string, down: boolean) => ({ key, down });

test('recoveredPorts: no previous status means nothing recovered', () => {
  assert.deepEqual(recoveredPorts(null, { watching: [w('port:3000', false)] }), []);
});

test('recoveredPorts: a port that was down and is up is listed, sorted', () => {
  const prev = { watching: [w('port:5173', true), w('port:3000', true), w('port:8080', true)] };
  const next = { watching: [w('port:3000', false), w('port:5173', false), w('port:8080', true)] };
  assert.deepEqual(recoveredPorts(prev, next), [3000, 5173]);
});

test('recoveredPorts: a watch that was removed is not a recovery', () => {
  assert.deepEqual(recoveredPorts({ watching: [w('port:3000', true)] }, { watching: [] }), []);
});

test('recoveredPorts: only port keys count', () => {
  assert.deepEqual(recoveredPorts({ watching: [w('device:abc', true)] }, { watching: [w('device:abc', false)] }), []);
});

test('recoveredPorts: up to up is not a recovery', () => {
  assert.deepEqual(recoveredPorts({ watching: [w('port:3000', false)] }, { watching: [w('port:3000', false)] }), []);
});

test('takeRecovered: false for a port that was never added', () => {
  assert.equal(takeRecovered(65001), false);
});
