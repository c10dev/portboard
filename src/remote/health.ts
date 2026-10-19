// 커넥터 상태 (connector health, docs/research/rea-references.md top-10 #10): whether each remote MCP authorization and
// client still works, from remote.json alone (no network). Pure; admin.ts's connectorView() attaches it, and the 설정
// tab, the setup checklist and the daily digest all read it from there.
//
//   ok       정상       live tokens, used (or approved) within idleDays
//   soon     만료 임박   the authorization ends within soonDays unless the client refreshes: its refresh token (or,
//                       with none left, its access token) expires. Access tokens alone last an hour by design, so only
//                       the end of the whole authorization counts
//   idle     응답 없음   still holds live tokens but hasn't called /mcp or refreshed for idleDays
//   expired  만료됨     a registered client whose tokens are all gone (it had some). Expired tokens are dropped from
//                       remote.json on the next write, so an authorization never shows as 만료됨 itself, and a hosted
//                       client (claude.ai, ChatGPT) whose last authorization ended simply leaves the list
//
// A client is as healthy as its best authorization: one working approval keeps it working. A registered client that
// never got a token (a stray registration: anyone may register) has no health and is never counted.
//
// Thresholds: remote.json "health": {"soonDays": 7, "idleDays": 7, "hideDays": 7}; anything missing or out of range
// is the default. soonDays matches the 비밀값 expiry warning (selfwatch.ts EXPIRY_WARN_MS); hideDays is how long the
// 설정 tab's "n일 동안 숨기기" hides the banner.

import { t } from '../core/i18n.ts';

const DAY = 86_400_000;

export type Health = 'ok' | 'soon' | 'idle' | 'expired';

export const HEALTH_LABEL: Record<Health, string> = {
  get ok() {
    return t('remoteHealth.ok');
  },
  get soon() {
    return t('remoteHealth.soon');
  },
  get idle() {
    return t('remoteHealth.idle');
  },
  get expired() {
    return t('remoteHealth.expired');
  },
};

/** Lower is better: a client takes its best authorization's */
const RANK: Record<Health, number> = { ok: 0, idle: 1, soon: 2, expired: 3 };

export interface HealthThresholds {
  soonDays: number;
  idleDays: number;
  hideDays: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = { soonDays: 7, idleDays: 7, hideDays: 7 };

/** remote.json "health" → thresholds; each must be a number of days in (0, 365], else its default. */
export function parseThresholds(raw: unknown): HealthThresholds {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const days = (k: keyof HealthThresholds) => {
    const v = r[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 365 ? v : DEFAULT_THRESHOLDS[k];
  };
  return { soonDays: days('soonDays'), idleDays: days('idleDays'), hideDays: days('hideDays') };
}

/** One authorization: expiresAt is when it ends unless refreshed, lastUsedAt null when never used. */
export function grantHealth(g: { createdAt: number; lastUsedAt: number | null; expiresAt: number }, now: number, th: HealthThresholds = DEFAULT_THRESHOLDS): Health {
  if (g.expiresAt <= now) return 'expired';
  if (g.expiresAt - now <= th.soonDays * DAY) return 'soon';
  if (now - (g.lastUsedAt ?? g.createdAt) >= th.idleDays * DAY) return 'idle';
  return 'ok';
}

/**
 * A client from its authorizations' health. With none: a registered client that once got tokens (its lastUsedAt
 * moved past its registration) is 만료됨; one that never did, or a hosted one, has no health (null).
 */
export function clientHealth(c: { kind: 'registered' | 'hosted'; createdAt: number | null; lastUsedAt: number | null }, grants: Health[]): Health | null {
  if (grants.length) return grants.reduce((best, h) => (RANK[h] < RANK[best] ? h : best));
  if (c.kind === 'registered' && c.createdAt !== null && c.lastUsedAt !== null && c.lastUsedAt > c.createdAt) return 'expired';
  return null;
}

/** Needs a look: anything but 정상 (and but no health) */
export const needsAttention = (h: Health | null | undefined): h is Exclude<Health, 'ok'> => !!h && h !== 'ok';
