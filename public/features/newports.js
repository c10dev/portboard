// New dev-server notices (src/features/newports.ts, docs/api.md#new-ports): every page asks GET /api/new-ports for
// events after the last one it saw and shows each as a toast — "새 서버 :5173 Vite (myapp)" with 열기 and, for a
// loopback-only port that tailscale serve can publish, tailnet 공개. The server decides which ports get one (the
// port rules' onNew: notify and openBrowserOnce); the first ask only learns where to start, so a page opened later
// never replays old events. Tabs share the last id they toasted (localStorage), so two open tabs toast once.

import { tryJSON } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import { toast } from '../lib/toast.js';
import { portAction } from './control.js';

const POLL_MS = 10_000;
const SEEN_KEY = 'pb.newports.seen';
const SHOW_MS = 15_000;

/** The toast's text for one event */
export function noticeText(e) {
  return t('newports.notice', { port: e.port, name: e.name, project: e.project ? ` (${e.project})` : '' });
}

/** The toast's actions for one event: 열기 (the tailnet URL, else the 서비스 row), tailnet 공개 when it can be published */
export function noticeActions(e) {
  const out = [{ label: t('newports.open'), run: () => (e.open ? window.open(e.open, '_blank', 'noopener') : location.assign(`./#${e.port}`)) }];
  if (e.action === 'notify' && !e.open && e.canExpose) out.push({ label: t('control.expose'), run: () => portAction(e.port, 'expose', () => false) });
  return out;
}

/**
 * Show one notice. Adaptation point for the toast stack (REA #4, lib/toast.js is being rewritten with actions):
 * toast() is called with the same text plus `actions`, and when the toast it drew has no buttons (today's #toast line)
 * the buttons are added here. Once toast() draws actions itself, drop the fallback.
 */
function showNotice(e) {
  const actions = noticeActions(e);
  toast(noticeText(e), false, { ms: SHOW_MS, actions });
  const box = document.getElementById('toast');
  if (!box || box.hidden || box.querySelector('button')) return;
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = a.label;
    b.style.marginLeft = '8px';
    b.addEventListener('click', () => {
      box.hidden = true;
      a.run();
    });
    box.append(b);
  }
}

function readSeen() {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeSeen(id) {
  try {
    if (id > readSeen()) localStorage.setItem(SEEN_KEY, String(id));
  } catch {
    // private mode: each tab keeps its own cursor
  }
}

let cursor = null;

async function poll() {
  if (cursor === null) {
    const first = await tryJSON('/api/new-ports');
    if (first) cursor = first.latest;
    return;
  }
  const feed = await tryJSON(`/api/new-ports?since=${cursor}`);
  if (!feed) return;
  // a restarted server starts its ids at its start time, which is past any id from before
  cursor = Math.max(cursor, feed.latest);
  for (const e of feed.events) {
    if (e.id <= readSeen()) continue;
    writeSeen(e.id);
    showNotice(e);
  }
}

if (typeof document !== 'undefined' && document.getElementById('toast')) {
  poll();
  setInterval(() => {
    if (!document.hidden) poll();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
}
