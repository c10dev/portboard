// The toast stack every page has (its #toast becomes the stack on first use), and copying text with it as feedback.
// Bottom right, 360 px; the newest toast is in front and the older ones are tucked behind it (only the front one shows
// its text). A toast stays at least 6 s; one with an action (되돌리기) stays until it is used or closed. The same message
// again while it is up merges into it as "(×3)". The stack is role=status, so screen readers announce toasts politely.

import { extLink } from './dom.js';
import { t } from './i18n.js';

/** No toast goes away sooner */
export const MIN_MS = 6000;
/** A repeat merges into a toast whose last showing is at most this old */
export const MERGE_MS = 30_000;
/** Toasts kept at once; the oldest goes first */
export const MAX_TOASTS = 5;

/** How long a toast stays in ms: 20 s with a link, 7 s for an error, else 6 s, never under 6 s; null (until closed) with an action */
export function lifetime({ error = false, link = null, ms, action = null } = {}) {
  if (action) return null;
  return Math.max(MIN_MS, ms ?? (link ? 20000 : error ? 7000 : MIN_MS));
}

/** Two toasts with the same key merge: the given key, else the text (and error); an action toast only with a key */
export function mergeKey(text, { error = false, action = null, key } = {}) {
  if (key != null) return String(key);
  return action ? null : `${error ? 'error' : 'info'}:${text}`;
}

/**
 * A stack drawn into root (the page's #toast). show(text, opts) → { close() }.
 * opts: { error, link (adds " 설정 열기"), ms, action: { label, onClick }, key }
 */
export function createToasts(root) {
  const doc = root.ownerDocument;
  root.className = 'toast-stack';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  // only the toast that comes in is read, not the whole stack again
  root.setAttribute('aria-atomic', 'false');
  root.setAttribute('aria-label', t('toast.label'));
  // never hidden: a live region that is hidden when a toast goes in may not announce it (the empty stack is 0 px tall)
  root.hidden = false;
  /** front first: { key, count, at, timer, node, text } */
  let items = [];

  function close(it) {
    if (!items.includes(it)) return;
    clearTimeout(it.timer);
    items = items.filter((x) => x !== it);
    it.node.remove();
    draw();
  }

  function fill(it, text, { error = false, link = null, action = null }) {
    const n = it.node;
    n.className = `toast${error ? ' error' : ''}`;
    const msg = doc.createElement('span');
    msg.className = 'toast-text';
    msg.append(it.count > 1 ? `${text} (×${it.count})` : text);
    if (link) msg.append(extLink(` ${t('toast.openSettings')}`, link));
    const parts = [msg];
    if (action) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.dataset.write = '1';
      b.textContent = action.label;
      b.addEventListener('click', () => { close(it); action.onClick(); });
      parts.push(b);
    }
    const x = doc.createElement('button');
    x.type = 'button';
    x.className = 'toast-close';
    x.title = t('common.close');
    x.setAttribute('aria-label', t('toast.close'));
    x.textContent = '×';
    x.addEventListener('click', () => close(it));
    parts.push(x);
    n.replaceChildren(...parts);
  }

  function arm(it, opts) {
    clearTimeout(it.timer);
    const ms = lifetime(opts);
    it.timer = ms == null ? null : setTimeout(() => close(it), ms);
  }

  /** Depth 0 is the front; the ones behind are inert (their text is hidden, shell.css) and as tall as the front */
  function draw() {
    items.forEach((it, i) => {
      it.node.dataset.depth = String(i);
      it.node.inert = i > 0;
    });
    const h = items[0]?.node.offsetHeight;
    if (h) root.style.setProperty?.('--toast-front-h', `${h}px`);
  }

  function show(text, opts = {}) {
    const key = mergeKey(text, opts);
    const now = Date.now();
    let it = key == null ? null : items.find((x) => x.key === key && now - x.at <= MERGE_MS);
    if (it) {
      it.count += 1;
      items = [it, ...items.filter((x) => x !== it)];
    } else {
      it = { key, count: 1, at: now, timer: null, node: doc.createElement('div') };
      items = [it, ...items];
      for (const old of items.slice(MAX_TOASTS)) close(old);
    }
    it.at = now;
    it.text = text;
    fill(it, text, opts);
    // a new toast goes in last, so moving the front never re-adds a node (and never re-announces it)
    if (!it.node.parentNode) root.append(it.node);
    arm(it, opts);
    draw();
    return { close: () => close(it) };
  }

  return {
    show,
    /** front first: { text, count, depth, timed } (for tests) */
    get items() { return items.map((it, i) => ({ text: it.text, count: it.count, depth: i, timed: it.timer != null, node: it.node })); },
    clear: () => { for (const it of [...items]) close(it); },
  };
}

/** One stack per page, made from its #toast on first use */
let stack = null;
let stackRoot = null;
function pageStack() {
  const root = document.getElementById('toast');
  if (!root) return null;
  if (stackRoot !== root) { stack = createToasts(root); stackRoot = root; }
  return stack;
}

/**
 * Show a toast. toast(text, error?, { link, ms, action, key }) or toast({ text, error, link, ms, action, key }).
 * ms: how long it stays (at least 6 s; by default 20 s with a link, 7 s for an error, else 6 s).
 * action: { label: '되돌리기', onClick } keeps it until it is used or closed. key: repeats with the same key merge as "(×N)".
 * Returns { close() }.
 */
export function toast(text, error = false, opts = {}) {
  if (text && typeof text === 'object') {
    const { text: t, error: e = false, ...rest } = text;
    return toast(t, e, rest);
  }
  const s = pageStack();
  if (!s) return { close() {} };
  return s.show(String(text), { ...opts, error });
}

/** Copy to the clipboard; on plain http (not a secure context) the browser refuses, so show a prompt to copy from */
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('toast.copied'));
  } catch {
    window.prompt(t('toast.copyPrompt'), text);
  }
}
