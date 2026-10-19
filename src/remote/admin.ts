// 원격 커넥터 관리 (#31): the dashboard's view of the remote MCP's OAuth state, and the revokes it may do. The
// dashboard and the remote server share remote.json (store.ts); the remote server re-reads it on every request, so a
// revoke here answers the very next /mcp call with 401.
//
//   connectorView(state)   clients and authorizations, with derived ids only: never a token, a token hash, a
//                          family, a raw client_id or the approval hash
//   revokeClient(ref)      every token of that client (and its registration, for a registered one)
//   revokeGrant(ref)       one authorization: its access token(s) and refresh token(s), rotated ones included
//
// A client is a registered (DCR, pb_…) client or a hosted one (CIMD: claude.ai, chatgpt.com) that is only known
// through the tokens it holds. A "grant" is one approval: every token refreshes mint carries the same family.

import { createHash } from 'node:crypto';
import { clientHealth, grantHealth, needsAttention, parseThresholds, type Health, type HealthThresholds } from './health.ts';
import type { RemoteState, Store, TokenRecord } from './store.ts';

const short = (kind: string, s: string) => createHash('sha256').update(`${kind}:${s}`).digest('hex').slice(0, 16);
/** The id the dashboard uses for a client: c- + 16 hex of sha256("client:" + client_id) */
export const clientRef = (clientId: string) => `c-${short('client', clientId)}`;
/** The id of one authorization: g- + 16 hex of its family (or, for tokens from before families, of the token hash) */
export const grantRef = (t: TokenRecord, hash: string) => `g-${t.family ? short('family', t.family) : short('token', hash)}`;

export interface GrantView {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  /** host of the resource the tokens are for (the public /mcp URL) */
  resourceHost: string | null;
  createdAt: number;
  /** last /mcp call or refresh, null when never used */
  lastUsedAt: number | null;
  /** the newest live access token's expiry, null when only the refresh token is left */
  accessExpiresAt: number | null;
  /** when the authorization ends unless refreshed: the live refresh token's expiry */
  expiresAt: number;
  /** 정상 · 만료 임박 · 응답 없음 (health.ts) */
  health: Health;
}

export interface ClientView {
  id: string;
  name: string;
  kind: 'registered' | 'hosted';
  redirectHosts: string[];
  createdAt: number | null;
  lastUsedAt: number | null;
  grants: number;
  /** its best authorization's health; 만료됨 for a registered client whose tokens are gone; null: never authorized */
  health: Health | null;
}

export interface ConnectorView {
  publicUrl: boolean;
  pendingApproval: boolean;
  /** when the pending approval code expires (ms), null when none is pending. Never the code or its hash. */
  approvalExpiresAt: number | null;
  clients: ClientView[];
  grants: GrantView[];
  /** clients whose health isn't 정상: the 설정 tab's "연결 n개가 확인이 필요해요" */
  attention: number;
  /** remote.json "health", defaults filled in */
  thresholds: HealthThresholds;
}

const hostOf = (u: string): string | null => {
  try {
    return new URL(u).host || null;
  } catch {
    return null;
  }
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const max = (...xs: (number | null | undefined)[]) => xs.reduce<number | null>((m, x) => (typeof x === 'number' && (m === null || x > m) ? x : m), null);

export function connectorView(s: RemoteState, now = Date.now()): ConnectorView {
  const grants = new Map<string, GrantView & { live: boolean }>();
  for (const [h, t] of Object.entries(s.tokens)) {
    if (!t || typeof t !== 'object' || typeof t.clientId !== 'string' || num(t.expiresAt) === null || t.expiresAt <= now) continue;
    const id = grantRef(t, h);
    const g =
      grants.get(id) ??
      ({
        id,
        clientId: clientRef(t.clientId),
        clientName: typeof t.clientName === 'string' ? t.clientName : '',
        scopes: typeof t.scope === 'string' ? t.scope.split(/\s+/).filter(Boolean) : [],
        resourceHost: typeof t.resource === 'string' ? hostOf(t.resource) : null,
        createdAt: num(t.createdAt) ?? 0,
        lastUsedAt: null,
        accessExpiresAt: null,
        expiresAt: 0,
        health: 'ok',
        live: false,
      } as GrantView & { live: boolean });
    const created = num(t.createdAt);
    if (created !== null && (g.createdAt === 0 || created < g.createdAt)) g.createdAt = created; // the oldest token left
    if (t.kind === 'access') {
      g.live = true;
      g.accessExpiresAt = max(g.accessExpiresAt, t.expiresAt);
      g.lastUsedAt = max(g.lastUsedAt, num(t.lastUsedAt));
      g.expiresAt = max(g.expiresAt, t.expiresAt)!;
    } else if (t.kind === 'refresh') {
      g.live = true;
      g.expiresAt = max(g.expiresAt, t.expiresAt)!;
      g.lastUsedAt = max(g.lastUsedAt, num(t.lastUsedAt)); // outlives the hour-long access token it was stamped with
    } else if (t.kind === 'used') {
      g.lastUsedAt = max(g.lastUsedAt, num(t.usedAt)); // a refresh is a use
    }
    grants.set(id, g);
  }
  // A family holding only rotated refresh tokens is dead (kept for reuse detection): not shown.
  const thresholds = parseThresholds((s as { health?: unknown }).health);
  const live = [...grants.values()].filter((g) => g.live).map(({ live: _, ...g }) => ({ ...g, health: grantHealth(g, now, thresholds) }));
  live.sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));

  const clients = new Map<string, ClientView>();
  for (const [cid, c] of Object.entries(s.clients)) {
    clients.set(clientRef(cid), {
      id: clientRef(cid),
      name: typeof c?.name === 'string' ? c.name : '',
      kind: 'registered',
      redirectHosts: [...new Set((Array.isArray(c?.redirectUris) ? c.redirectUris : []).map((u) => (typeof u === 'string' ? hostOf(u) : null)).filter((x): x is string => !!x))],
      createdAt: num(c?.createdAt),
      lastUsedAt: num(c?.lastUsedAt),
      grants: 0,
      health: null,
    });
  }
  for (const t of Object.values(s.tokens)) {
    if (!t || typeof t.clientId !== 'string' || clients.has(clientRef(t.clientId))) continue;
    // Hosted (CIMD) clients are never registered here; their client_id is their https metadata URL.
    const host = hostOf(t.clientId);
    clients.set(clientRef(t.clientId), { id: clientRef(t.clientId), name: typeof t.clientName === 'string' ? t.clientName : '', kind: 'hosted', redirectHosts: host ? [host] : [], createdAt: null, lastUsedAt: null, grants: 0, health: null });
  }
  for (const g of live) {
    const c = clients.get(g.clientId);
    if (!c) continue;
    c.grants++;
    c.createdAt = c.kind === 'hosted' ? Math.min(c.createdAt ?? Infinity, g.createdAt) : c.createdAt;
    c.lastUsedAt = max(c.lastUsedAt, g.lastUsedAt);
  }
  for (const c of clients.values()) c.health = clientHealth(c, live.filter((g) => g.clientId === c.id).map((g) => g.health));
  // A hosted client whose every grant expired has nothing left to show or revoke.
  const list = [...clients.values()].filter((c) => c.kind === 'registered' || c.grants > 0);
  list.sort((a, b) => b.grants - a.grants || (b.lastUsedAt ?? b.createdAt ?? 0) - (a.lastUsedAt ?? a.createdAt ?? 0));

  return {
    publicUrl: typeof s.publicUrl === 'string' && !!s.publicUrl,
    pendingApproval: !!s.approval && num(s.approval.expiresAt) !== null && s.approval.expiresAt > now,
    approvalExpiresAt: s.approval && num(s.approval.expiresAt) !== null && s.approval.expiresAt > now ? s.approval.expiresAt : null,
    clients: list,
    grants: live,
    attention: list.filter((c) => needsAttention(c.health)).length,
    thresholds,
  };
}

/** null when no client has this id (nothing was changed) */
export async function revokeClient(store: Store, ref: string): Promise<{ tokens: number; registration: boolean } | null> {
  const s = await store.read();
  const cid = [...Object.keys(s.clients), ...Object.values(s.tokens).map((t) => t?.clientId)].find((c) => typeof c === 'string' && clientRef(c) === ref);
  if (!cid) return null;
  const registration = Object.hasOwn(s.clients, cid);
  const tokens = await store.revokeMatching((t) => t.clientId === cid, cid);
  return { tokens, registration };
}

/** null when no authorization has this id */
export async function revokeGrant(store: Store, ref: string): Promise<{ tokens: number } | null> {
  const s = await store.read();
  if (!Object.entries(s.tokens).some(([h, t]) => t && grantRef(t, h) === ref)) return null;
  return { tokens: await store.revokeMatching((t, h) => grantRef(t, h) === ref) };
}
