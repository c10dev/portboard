// src/mcp/kit.ts: what every MCP tool shares — result shapes, the protocol error, the port schema and the argument
// parsers. mcp.test.ts drives them through tools; this pins the edges (strings with spaces, the error text the model
// reads, isError only when set).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOptionalInt, parsePort, PORT_ARG, READ_ONLY_ANNOTATIONS, RpcError, text } from '../src/mcp/kit.ts';

test('text: strings as they are, everything else as JSON; isError only when true', () => {
  assert.deepEqual(text('hello'), { content: [{ type: 'text', text: 'hello' }] });
  assert.deepEqual(text({ a: 1, b: [2] }), { content: [{ type: 'text', text: '{"a":1,"b":[2]}' }] });
  assert.deepEqual(text(null), { content: [{ type: 'text', text: 'null' }] });
  assert.deepEqual(text('', true), { content: [{ type: 'text', text: '' }], isError: true });
  assert.ok(!('isError' in text('x', false)), 'no isError: false key');
});

test('RpcError: an Error with a JSON-RPC code', () => {
  const e = new RpcError(-32601, 'unknown tool: nope');
  assert.ok(e instanceof Error);
  assert.deepEqual([e.code, e.message], [-32601, 'unknown tool: nope']);
});

test('PORT_ARG and READ_ONLY_ANNOTATIONS: the schema clients validate against, and what remote tools are listed with', () => {
  assert.deepEqual(PORT_ARG.required, ['port']);
  assert.equal(PORT_ARG.additionalProperties, false);
  assert.deepEqual([PORT_ARG.properties.port.minimum, PORT_ARG.properties.port.maximum, PORT_ARG.properties.port.type], [1, 65535, 'integer']);
  assert.deepEqual(READ_ONLY_ANNOTATIONS, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test('parsePort: bounds inclusive, digit strings with spaces trimmed; the error names what it got', () => {
  assert.deepEqual(parsePort({ port: 1 }), { ok: true, value: 1 });
  assert.deepEqual(parsePort({ port: 65535 }), { ok: true, value: 65535 });
  assert.deepEqual(parsePort({ port: ' 8080 ' }), { ok: true, value: 8080 });
  assert.deepEqual(parsePort({ port: '00080' }), { ok: true, value: 80 });
  for (const port of ['123456', '-1', '+80', '8e3', '0x50', 8e3 + 0.1, true, [80], { port: 80 }, Infinity, NaN]) {
    assert.equal(parsePort({ port }).ok, false, JSON.stringify(port));
  }
  assert.deepEqual(parsePort({ port: 'abc' }), { ok: false, error: 'port must be an integer between 1 and 65535 (got "abc")' });
  assert.deepEqual(parsePort({}), { ok: false, error: 'port must be an integer between 1 and 65535 (got null)' });
  assert.deepEqual(parsePort(undefined), { ok: false, error: 'port must be an integer between 1 and 65535 (got null)' });
});

test('parseOptionalInt: absent or null is undefined; digit strings count; the error names the key and its bounds', () => {
  assert.deepEqual(parseOptionalInt({}, 'lines', 1, 1000), { ok: true, value: undefined });
  assert.deepEqual(parseOptionalInt({ lines: null }, 'lines', 1, 1000), { ok: true, value: undefined });
  assert.deepEqual(parseOptionalInt(null, 'lines', 1, 1000), { ok: true, value: undefined });
  assert.deepEqual(parseOptionalInt({ lines: ' 20 ' }, 'lines', 1, 1000), { ok: true, value: 20 });
  assert.deepEqual(parseOptionalInt({ lines: 1000 }, 'lines', 1, 1000), { ok: true, value: 1000 });
  assert.deepEqual(parseOptionalInt({ count: 0 }, 'count', 1, 20), { ok: false, error: 'count must be an integer between 1 and 20 (got 0)' });
  assert.deepEqual(parseOptionalInt({ count: '-3' }, 'count', 1, 20), { ok: false, error: 'count must be an integer between 1 and 20 (got "-3")' });
  for (const v of [1.5, '', 'ten', false, [3]]) assert.equal(parseOptionalInt({ n: v }, 'n', 0, 10).ok, false, JSON.stringify(v));
  assert.deepEqual(parseOptionalInt({ n: 0 }, 'n', 0, 10), { ok: true, value: 0 }, 'a zero minimum is allowed');
});
