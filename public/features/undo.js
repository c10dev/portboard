// Undo instead of a confirm for reversible changes: unpin, hide, a label cleared (or changed) and a 🔔 down alert turned
// off apply at once, and a 되돌리기 toast (lib/toast.js) re-posts the previous prefs exactly. Stop, restart, worktree
// removal and tailnet 공개 keep their confirm. Used by the 서비스 tab's savePrefs (app.js) and by features/alerts.js.

import { toast } from '../lib/toast.js';

/**
 * The undo for a prefs patch on a port (POST /api/ports/:port/prefs) whose state before was `before` (the port from
 * /api/ports: label, pinned, hidden, alert): { text, prev }, where prev is every field the patch sets, as it was. null
 * when the patch takes nothing away (pin, show again, alert on, a first label) or nothing would change.
 */
export function prefsUndo(before, patch) {
  if (!before || !patch) return null;
  const said = [];
  if (patch.pinned === false && before.pinned) said.push('고정을 풀었어요');
  if (patch.hidden === true && !before.hidden) said.push('숨겼어요');
  if (patch.alert === false && before.alert) said.push('다운 알림을 껐어요');
  if (patch.label !== undefined && before.label) {
    const next = typeof patch.label === 'string' ? patch.label.trim() : '';
    if (!next) said.push(`이름 "${before.label}"을(를) 지웠어요`);
    else if (next !== before.label) said.push(`이름을 "${next}"(으)로 바꿨어요`);
  }
  if (!said.length) return null;
  const prev = {};
  for (const k of Object.keys(patch)) prev[k] = k === 'label' ? before.label ?? null : !!before[k];
  return { text: `${before.port} ${said.join(' · ')}`, prev };
}

/**
 * Show u ({ text, prev }, e.g. from prefsUndo) as a toast with 되돌리기; using it calls repost(u.prev) once (it says its
 * own errors and returns false on one), then says 되돌렸어요. Repeats for the same key merge into one toast. null u: nothing.
 */
export function offerUndo(key, u, repost, show = toast) {
  if (!u) return null;
  return show(u.text, false, {
    key: `undo:${key}:${Object.keys(u.prev).sort().join(',')}`,
    action: {
      label: '되돌리기',
      onClick: async () => {
        if ((await repost(u.prev)) !== false) show('되돌렸어요');
      },
    },
  });
}
