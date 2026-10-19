// fetch helpers for /api. Every write carries X-Portboard: 1 (the router refuses writes without it, docs/security.md).
// Writes are the owner's only (#29): once the page knows this browser may not write (lib/access.js), post() answers
// 403 with the reason in Korean instead of sending.

/** GET → JSON; throws "HTTP n" when the answer isn't 2xx */
export async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** GET → JSON whatever the status (the body explains itself, e.g. logs and worktrees) */
export async function readJSON(path) {
  const res = await fetch(path);
  return res.json();
}

/** GET → JSON, or null when it fails: for the parts of a page that work without it */
export async function tryJSON(path) {
  try {
    const res = await fetch(path);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The fetch options of a write: X-Portboard always, a JSON body only when there is one */
export function writeInit(body) {
  if (body === undefined) return { method: 'POST', headers: { 'X-Portboard': '1' } };
  return { method: 'POST', headers: { 'X-Portboard': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

let access = null;

/** What GET /api/whoami said ({canWrite, reason, …}); lib/access.js tells us once the page has asked */
export function noteAccess(w) {
  access = w;
}

/** POST → { ok, status, body } (body {} when the answer isn't JSON); network errors throw */
export async function post(path, body) {
  if (access && !access.canWrite) return { ok: false, status: 403, body: { error: `읽기 전용: ${access.reason ?? '이 접속으로는 바꿀 수 없어요.'}` } };
  const res = await fetch(path, writeInit(body));
  const out = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: out };
}

/** "error" from the answer, else "HTTP n" */
export const errorText = (r) => (r.body.error === 'owner only' && r.body.reason ? `읽기 전용: ${r.body.reason}` : r.body.error ?? `HTTP ${r.status}`);

/** POST → the answer's body; throws with its error when it isn't 2xx */
export async function postOrThrow(path, body) {
  const r = await post(path, body);
  if (!r.ok) throw new Error(errorText(r));
  return r.body;
}
