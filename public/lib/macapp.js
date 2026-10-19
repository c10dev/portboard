// @ts-check
// The Mac app (mac-app/, docs/mac-app/): its window has no title bar, so the page header is the window's one bar.
// The web view's User-Agent carries portboard-mac/<version>; then the page gets <html data-app="mac"> and shell.css
// keeps 78 px clear for the traffic lights. The shell's ← → (lib/shell.js) are the app's back and forward; a page
// without the shell gets an app-only back button instead.
//
// WKWebView ignores CSS app-region, and a script message sent on mousedown reaches the app too late to start a window
// drag. So the page only says where things are: the header's rect and the rects of its controls (CSS px, relative to
// the viewport), posted to the app's `portboard` handler on load and whenever they move. The app hit-tests each
// mouse-down against the last report and drags (or, on a double-click, zooms as the system setting says) on empty bar
// space; clicks on controls reach the page as usual. An open <dialog> (the 설정 modal, ⌘K, ⌘/) is no-drag space too:
// where it covers the bar, a press is the dialog's. The backdrop around it stays bar. The app sets data-can-go-back and
// data-fullscreen.

import { t } from './i18n.js';

export const inMacApp = typeof navigator !== 'undefined' && /\bportboard-mac\//.test(navigator.userAgent);

/** Parts of the header that keep their clicks (everything else in it moves the window) */
export const NO_DRAG = 'a, button, input, select, textarea, label, summary, details, nav, [role="button"], [contenteditable], [tabindex]';

const round = (n) => Math.round(n * 100) / 100;
const box = (r) => ({ x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) });

/** The message for the app: {type: 'bar', bar, noDrag[]}; hidden controls (no size) are left out, open dialogs added */
export function barReport(header, doc = header.ownerDocument) {
  const dialogs = doc ? [...doc.querySelectorAll('dialog[open]')] : [];
  const noDrag = [...header.querySelectorAll(NO_DRAG), ...dialogs]
    .map((e) => box(e.getBoundingClientRect()))
    .filter((r) => r.width > 0 && r.height > 0);
  return { type: 'bar', bar: box(header.getBoundingClientRect()), noDrag };
}

/**
 * @param {Document} doc
 * @param {any} win the window; WKWebView adds webkit.messageHandlers.portboard in the Mac app
 */
export function setupMacApp(doc = document, win = window) {
  doc.documentElement.dataset.app = 'mac';
  const header = doc.querySelector('header.top');
  if (!header) return;
  const brand = header.querySelector('.brand');
  if (brand && !doc.getElementById('appBack') && !doc.getElementById('navBack')) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.id = 'appBack';
    b.className = 'app-back';
    b.title = t('macapp.back.title');
    b.setAttribute('aria-label', t('macapp.back'));
    b.textContent = '‹';
    b.addEventListener('click', () => win.history.back());
    brand.prepend(b);
  }

  const bridge = win.webkit?.messageHandlers?.portboard;
  if (!bridge) return;
  let last = '';
  let queued = false;
  const send = () => {
    queued = false;
    const msg = barReport(header);
    const key = JSON.stringify(msg);
    if (key === last) return;
    last = key;
    bridge.postMessage(msg);
  };
  // At most one report per frame, and only when something moved
  const schedule = () => {
    if (queued) return;
    queued = true;
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(send);
    else win.setTimeout(send, 16);
  };
  schedule();
  win.addEventListener('resize', schedule);
  win.addEventListener('load', schedule);
  // back/forward cache: the app forgot the layout when the navigation started, so say it again
  win.addEventListener('pageshow', () => { last = ''; schedule(); });
  doc.fonts?.ready?.then(schedule);
  if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(schedule).observe(header);
  if (typeof win.MutationObserver === 'function') {
    // chips that change text, controls added later (⌘K, 설정 n/m, 수집 정상), the back button showing
    const mo = new win.MutationObserver(schedule);
    mo.observe(header, { subtree: true, childList: true, attributes: true, characterData: true });
    mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-can-go-back', 'data-fullscreen', 'data-readonly', 'data-modal'] });
    // a dialog opening or closing (its open attribute) moves the no-drag space; its size follows the window (resize)
    if (doc.body) mo.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  }
}

if (inMacApp) setupMacApp();
