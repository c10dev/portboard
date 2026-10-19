// @ts-check
// fetch helpers for /api. Every write carries X-Portboard: 1 (the router refuses writes without it, docs/security.md).
// Writes are the owner's only (#29): once the page knows this browser may not write (lib/access.js), post() answers
// 403 with the reason instead of sending.
//
// Token mode (#12): the owner token entered in 설정 › 화면 is kept in this browser (localStorage pb.ownerToken) and
// sent as `Authorization: Bearer …` on every /api request (whoami and the audit log need it too, not only writes).
// Only in a header: never in a URL, so it can't end up in history, logs or a Referer.

import { t } from './i18n.js';

export const OWNER_TOKEN_KEY = 'pb.ownerToken';
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{1,256}$/;

const store = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** The owner token this browser keeps, or null (none, an odd value, storage blocked) */
export function loadOwnerToken(storage = store()) {
  try {
    const v = storage?.getItem(OWNER_TOKEN_KEY);
    return v && TOKEN_SHAPE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Keep `token` in this browser; empty forgets it. False when it isn't a token's shape or storage refused it. */
export function saveOwnerToken(token, storage = store()) {
  const v = String(token ?? '').trim();
  try {
    if (!v) {
      storage?.removeItem(OWNER_TOKEN_KEY);
      return true;
    }
    if (!TOKEN_SHAPE.test(v) || !storage) return false;
    storage.setItem(OWNER_TOKEN_KEY, v);
    return true;
  } catch {
    return false;
  }
}

/** {Authorization} when this browser keeps an owner token, else {} */
export function authHeaders(storage = store()) {
  const tok = loadOwnerToken(storage);
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

/** fetch for a read: with the owner token when there is one, exactly fetch(path) when not */
export function getInit() {
  const headers = authHeaders();
  return Object.keys(headers).length ? { headers } : undefined;
}

/** GET → JSON; throws "HTTP n" when the answer isn't 2xx */
export async function getJSON(path) {
  const res = await fetch(path, getInit());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** GET → JSON whatever the status (the body explains itself, e.g. logs and worktrees) */
export async function readJSON(path) {
  const res = await fetch(path, getInit());
  return res.json();
}

/** GET → JSON, or null when it fails: for the parts of a page that work without it */
export async function tryJSON(path) {
  try {
    const res = await fetch(path, getInit());
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The fetch options of a write: X-Portboard always, the owner token when kept, a JSON body only when there is one */
export function writeInit(body, storage = store()) {
  const auth = authHeaders(storage);
  if (body === undefined) return { method: 'POST', headers: { 'X-Portboard': '1', ...auth } };
  return { method: 'POST', headers: { 'X-Portboard': '1', 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) };
}

let access = null;

/** What GET /api/whoami said ({canWrite, reason, …}); lib/access.js tells us once the page has asked */
export function noteAccess(w) {
  access = w;
}

/** POST → { ok, status, body } (body {} when the answer isn't JSON); network errors throw */
export async function post(path, body) {
  if (access && !access.canWrite) return { ok: false, status: 403, body: { error: t('api.readonly', { reason: access.reason ?? t('common.readonlyReason') }) } };
  const res = await fetch(path, writeInit(body));
  const out = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: out };
}

/** "error" from the answer, else "HTTP n" */
export const errorText = (r) => (r.body.error === 'owner only' && r.body.reason ? t('api.readonly', { reason: r.body.reason }) : r.body.error ?? `HTTP ${r.status}`);

/** POST → the answer's body; throws with its error when it isn't 2xx */
export async function postOrThrow(path, body) {
  const r = await post(path, body);
  if (!r.ok) throw new Error(errorText(r));
  return r.body;
}
