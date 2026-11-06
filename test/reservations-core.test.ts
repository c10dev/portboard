// The reservations feature's real Core methods (mcpCore), over a temp reservations.json: release_port passes the
// owner to release(), so one MCP agent cannot remove another owner's reservation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = await mkdtemp(join(tmpdir(), 'pb-resv-core-'));
process.env.HOME = DIR;
for (const k of Object.keys(process.env)) if (k.startsWith('PORTBOARD_') && k !== 'PORTBOARD_LOCALE') delete process.env[k];
process.env.PORTBOARD_RESERVATIONS = join(DIR, 'reservations.json');

const { reservationsFeature } = await import('../src/features/reservations.ts');
const { loadReservations } = await import('../src/core/reservations.ts');
const { callTool } = await import('../src/mcp/tools.ts');

test('release_port over the real core: another owner\'s reservation stays; the owner\'s own goes', async () => {
  const core = reservationsFeature.mcpCore!() as any;
  // an explicit port: no free-port scan
  const r = await core.reservePort('shop-web@feat', 4201, 'vite');
  assert.equal(r.ok, true);
  const other = await callTool('release_port', { port: 4201, owner: 'billing@main' }, core);
  assert.equal(other.isError, true);
  assert.equal(other.content[0].text, '4201 is reserved for shop-web@feat, not billing@main');
  assert.deepEqual((await loadReservations()).map((x) => [x.port, x.owner]), [[4201, 'shop-web@feat']]);
  const mine = await callTool('release_port', { port: 4201, owner: 'shop-web@feat' }, core);
  assert.equal(mine.isError, undefined);
  assert.deepEqual(await loadReservations(), []);
});
