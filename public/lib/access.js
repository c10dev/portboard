// 읽기 전용 표시 (#29): writes are the owner's only — this machine, or the owner's Tailscale login through
// tailscale serve. GET /api/whoami says whether this browser may write; when it may not, the page gets
// <html data-readonly>, every control marked data-write looks disabled (style.css), and a line in the shell's sidebar
// footer (lib/shell.js #shellFoot; under the header without the shell) says why. The answer is kept for the tab
// (sessionStorage pb.ro), so lib/shell-boot.js greys the next page before it paints; a changed answer corrects it. post() (api.js) answers with the same reason instead of sending. Shared by every page.

import { noteAccess, tryJSON } from './api.js';
import { t } from './i18n.js';
// Inside the Mac app the header is the window's title bar (macapp.js sets <html data-app="mac"> on every page)
import './macapp.js';

/** Returns what /api/whoami said (null when it failed), for a page that says more about it. */
export async function showAccess() {
  const w = await tryJSON('/api/whoami');
  noteAccess(w);
  if (w) {
    try { sessionStorage.setItem('pb.ro', JSON.stringify({ readonly: !w.canWrite, reason: w.reason ?? null })); } catch {}
  }
  if (!w || w.canWrite) {
    // painted read-only from the last page's answer, and this one may write after all
    if (w) {
      delete document.documentElement.dataset.readonly;
      document.querySelector('.readonly-note')?.remove();
    }
    return w;
  }
  document.documentElement.dataset.readonly = '1';
  const old = document.querySelector('.readonly-note');
  if (old) {
    old.textContent = t('access.note', { reason: w.reason ?? t('common.readonlyReason') });
    return w;
  }
  const note = document.createElement('p');
  note.className = 'readonly-note';
  note.setAttribute('role', 'note');
  note.textContent = t('access.note', { reason: w.reason ?? t('common.readonlyReason') });
  const foot = document.getElementById('shellFoot');
  const header = document.querySelector('header.top');
  if (foot) foot.append(note);
  else if (header) header.after(note);
  else document.body.prepend(note);
  return w;
}
