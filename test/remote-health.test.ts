// 커넥터 상태 (rea-references top-10 #10): 정상 · 만료 임박 · 응답 없음 · 만료됨 per remote MCP authorization and client,
// the thresholds from remote.json, and the lines the setup checklist and the daily digest add. No secrets anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectorView } from '../src/remote/admin.ts';
import { clientHealth, DEFAULT_THRESHOLDS, grantHealth, parseThresholds } from '../src/remote/health.ts';
import { sha256, Store } from '../src/remote/store.ts';
import { assess, remoteFacts } from '../src/core/onboarding.ts';
import { buildDigest, type DigestInput } from '../src/core/digest.ts';
import { remoteAttention } from '../src/features/digest.ts';

const DAY = 86_400_000;
const NOW = 1_900_000_000_000;

test('grantHealth: the boundaries of 만료 임박 and 응답 없음', () => {
  const g = (o: { created?: number; used?: number | null; expires: number }) => grantHealth({ createdAt: o.created ?? NOW - DAY, lastUsedAt: o.used === undefined ? NOW - 60_000 : o.used, expiresAt: o.expires }, NOW);
  assert.equal(g({ expires: NOW + 30 * DAY }), 'ok');
  assert.equal(g({ expires: NOW + 7 * DAY + 1 }), 'ok', 'just over soonDays');
  assert.equal(g({ expires: NOW + 7 * DAY }), 'soon', 'at soonDays');
  assert.equal(g({ expires: NOW + 3600_000 }), 'soon', 'only an access token left: ends within the hour');
  assert.equal(g({ expires: NOW }), 'expired');
  assert.equal(g({ expires: NOW + 30 * DAY, used: NOW - 7 * DAY + 1 }), 'ok', 'just under idleDays');
  assert.equal(g({ expires: NOW + 30 * DAY, used: NOW - 7 * DAY }), 'idle', 'at idleDays');
  // never used: the approval itself is the reference (ChatGPT's access token expired unused-looking, refresh only)
  assert.equal(g({ expires: NOW + 30 * DAY, used: null, created: NOW - 0.44 * DAY }), 'ok');
  assert.equal(g({ expires: NOW + 30 * DAY, used: null, created: NOW - 8 * DAY }), 'idle');
  // expiry wins over idleness: a long-idle client whose refresh token is about to end
  assert.equal(g({ expires: NOW + 2 * DAY, used: NOW - 28 * DAY }), 'soon');
  // thresholds
  assert.equal(grantHealth({ createdAt: NOW - DAY, lastUsedAt: NOW - 2 * DAY, expiresAt: NOW + 30 * DAY }, NOW, { ...DEFAULT_THRESHOLDS, idleDays: 1 }), 'idle');
  assert.equal(grantHealth({ createdAt: NOW - DAY, lastUsedAt: NOW, expiresAt: NOW + 20 * DAY }, NOW, { ...DEFAULT_THRESHOLDS, soonDays: 21 }), 'soon');
});

test('clientHealth: the best authorization; 만료됨 only for a registered client that once had tokens', () => {
  assert.equal(clientHealth({ kind: 'hosted', createdAt: 1, lastUsedAt: 2 }, ['idle', 'ok']), 'ok', 'one working approval keeps it working');
  assert.equal(clientHealth({ kind: 'hosted', createdAt: 1, lastUsedAt: 2 }, ['soon', 'idle']), 'idle');
  assert.equal(clientHealth({ kind: 'registered', createdAt: 1, lastUsedAt: 5 }, []), 'expired');
  assert.equal(clientHealth({ kind: 'registered', createdAt: 1, lastUsedAt: 1 }, []), null, 'a stray registration that never got a token');
  assert.equal(clientHealth({ kind: 'hosted', createdAt: null, lastUsedAt: null }, []), null);
});

test('parseThresholds: remote.json "health", defaults for anything missing or out of range', () => {
  assert.deepEqual(parseThresholds(undefined), { soonDays: 7, idleDays: 7, hideDays: 7 });
  assert.deepEqual(parseThresholds({ soonDays: 3, idleDays: 14, hideDays: 1 }), { soonDays: 3, idleDays: 14, hideDays: 1 });
  assert.deepEqual(parseThresholds({ soonDays: 0, idleDays: -1, hideDays: 'x' }), DEFAULT_THRESHOLDS);
  assert.deepEqual(parseThresholds({ soonDays: 400, idleDays: Infinity }), DEFAULT_THRESHOLDS);
  assert.deepEqual(parseThresholds([3]), DEFAULT_THRESHOLDS);
});

const tok = (o: object) => ({ clientName: 'x', resource: 'https://box.example/mcp', scope: 'portboard:read', createdAt: NOW - 2 * DAY, ...o });

/** claude.ai in use, ChatGPT approved and idle since, a Claude Code registration whose tokens are gone, a stray one */
function state(over: object = {}) {
  return {
    publicUrl: 'https://box.example',
    clients: {
      pb_cc: { name: 'Claude Code', redirectUris: ['http://127.0.0.1:1/cb'], createdAt: NOW - 40 * DAY, lastUsedAt: NOW - 31 * DAY },
      pb_stray: { name: 'scanner', redirectUris: ['http://127.0.0.1:2/cb'], createdAt: NOW - DAY, lastUsedAt: NOW - DAY },
    },
    tokens: {
      ['a'.repeat(64)]: tok({ kind: 'access', clientId: 'https://claude.ai/oauth/claude', clientName: 'Claude', family: 'F1', expiresAt: NOW + 3600_000, lastUsedAt: NOW - 60_000 }),
      ['b'.repeat(64)]: tok({ kind: 'refresh', clientId: 'https://claude.ai/oauth/claude', clientName: 'Claude', family: 'F1', expiresAt: NOW + 30 * DAY }),
      ['c'.repeat(64)]: tok({ kind: 'refresh', clientId: 'https://chatgpt.com/oauth/x', clientName: 'ChatGPT', family: 'F2', createdAt: NOW - 10 * DAY, expiresAt: NOW + 20 * DAY }),
    },
    ...over,
  };
}

test('connectorView: health on every client and authorization, attention and thresholds, no secrets', () => {
  const v = connectorView(state() as any, NOW);
  assert.deepEqual(v.clients.map((c) => [c.name, c.health]), [['Claude', 'ok'], ['ChatGPT', 'idle'], ['scanner', null], ['Claude Code', 'expired']]);
  assert.deepEqual(v.grants.map((g) => [g.clientName, g.health]), [['Claude', 'ok'], ['ChatGPT', 'idle']]);
  assert.equal(v.attention, 2);
  assert.deepEqual(v.thresholds, DEFAULT_THRESHOLDS);
  const text = JSON.stringify(v);
  for (const leak of ['aaaa', 'bbbb', 'cccc', 'F1', 'F2', 'pb_cc', 'pb_stray', 'claude.ai/oauth']) assert.ok(!text.includes(leak), leak);

  const loose = connectorView(state({ health: { idleDays: 30 } }) as any, NOW);
  assert.deepEqual(loose.clients.map((c) => c.health), ['ok', 'ok', null, 'expired'], 'remote.json idleDays');
  assert.equal(loose.thresholds.idleDays, 30);
});

test('last used survives the access token: the refresh token of the same authorization carries it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-health-'));
  try {
    let now = NOW;
    const p = join(dir, 'remote.json');
    const s = new Store(p, () => now);
    const t = await s.issueTokens({ id: 'https://chatgpt.com/oauth/x', name: 'ChatGPT' }, 'https://box.example/mcp', 'portboard:read');
    assert.ok(await s.verifyAccessToken(t.access));
    const raw = JSON.parse(await readFile(p, 'utf8'));
    assert.equal(raw.tokens[sha256(t.refresh)].lastUsedAt, NOW);
    // the access token expires and is dropped on the next write; the authorization still shows when it was used
    now += 2 * 3600_000;
    await s.update(() => {});
    const after = JSON.parse(await readFile(p, 'utf8'));
    assert.equal(after.tokens[sha256(t.access)], undefined);
    const v = connectorView(after, now);
    assert.equal(v.grants[0].lastUsedAt, NOW);
    assert.equal(v.clients[0].lastUsedAt, NOW);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('setup checklist: the claude.ai 커넥터 item warns while a connection needs a look', () => {
  const facts = remoteFacts({ value: state() }, NOW);
  assert.equal(facts.attention, 2);
  const base: any = {
    alertChannel: [], proxmox: { configured: false, error: null, looseMode: false, collector: null, expiry: null }, pvePorts: null, winPorts: null, macAgent: null, menubarSeenAt: null,
    claudeCode: null, usage: { pinned: 0, labels: 0, alerts: 0, deviceAlerts: 0, names: 0 }, writeDevices: { list: null, error: null, path: '~/x', ownerDevices: null },
  };
  const item = (remote: any) => assess({ ...base, remote }, NOW).items.find((i) => i.key === 'remote')!;
  const warn = item(facts);
  assert.equal(warn.status, 'warn');
  assert.match(warn.detail, /연결 2개가 확인이 필요해요/);
  assert.equal((warn.action as any).href, 'settings.html#remote');
  assert.equal(item(remoteFacts({ value: state({ clients: {}, tokens: { b: (state().tokens as any)['b'.repeat(64)] } }) }, NOW)).status, 'ok', 'all 정상');
  assert.equal(item({ clients: 1, liveTokens: 2, publicUrl: true, unreadable: false }).status, 'ok', 'facts without attention (older callers)');
});

test('digest: one 🔌 line only when a connector needs a look, read from remote.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-health-'));
  try {
    const p = join(dir, 'remote.json');
    await writeFile(p, JSON.stringify(state()));
    const remote = await remoteAttention(p, NOW);
    assert.deepEqual(remote, [{ name: 'ChatGPT', health: '응답 없음' }, { name: 'Claude Code', health: '만료됨' }]);
    const input: DigestInput = { watching: null, uptime: null, known: null, cleanup: null, worktrees: null, selfwatch: null, history: null };
    const d = buildDigest({ ...input, remote }, 'daily', { from: NOW - DAY, to: NOW }, NOW);
    assert.equal(d.empty, false);
    assert.deepEqual(d.lines.map((l) => l.text), ['🔌 원격 커넥터 확인 필요 2개: ChatGPT 응답 없음, Claude Code 만료됨']);
    assert.equal(buildDigest({ ...input, remote: [] }, 'daily', { from: NOW - DAY, to: NOW }, NOW).body, '이상 없음');
    assert.equal(buildDigest(input, 'daily', { from: NOW - DAY, to: NOW }, NOW).body, '이상 없음', 'no source');
    assert.deepEqual(await remoteAttention(join(dir, 'missing.json'), NOW), [], 'no remote.json: nothing to say');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
