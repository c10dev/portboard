// The dashboard's one shell (docs/layout/), shared by every page: a 48 px top bar (sidebar toggle, ← →, the view as the
// title, then ⌘K, the filter popover, 🔔, ↻ and the inspector toggle), a collapsible left sidebar (the views with
// counts, 고정, 기기, and a footer for the chips) and, on pages that have one, a right inspector.
//
// The markup is static: the server expands the <!--#shell:…--> markers in each page (src/core/shell.ts), and
// lib/shell-boot.js, inlined into <head>, has already applied the remembered toggles, app mode and the cached sidebar
// before the first paint. This module only wires that markup: the toggles, ⌘\, Escape, ← →, the filter popover, the
// pane resize handles, and the API the pages and features/nav.js use. Its keys are entries of lib/keys.js (the one
// shortcut registry, also behind the palette's 명령 rows and the ⌘/ dialog). The page's entry script imports it first, so it is wired before the page
// or a feature looks anything up. lib/macapp.js still reports header.top to the Mac app.
//
// Widths (after the Claude desktop app's measured layout, docs/layout/): ≥1200 the inspector is a column; under 1200 a
// right sheet; under 768 the column loses its padding (CSS only); under 704 the sidebar is a drawer; at 640 and below
// (phone) the bar wraps into the old mobile layout (tabs, the filters inline, 상세 inline in the rows).
//
// Resizable panes (docs/research/rea-references.md #6): the sidebar 200–420 px (288 by default), the inspector
// 280–480 px (300), remembered in pb.shell. The list keeps at least 324 px, so wider panes move the breakpoints up:
// the sidebar is a column from max(704, side + 8 + 324), the inspector from max(1200, side + 8 + 324 + inspector)
// (side: the open sidebar column, else 0). layoutFor() says which; <html data-side-mode / data-insp-mode> carry it to
// shell.css, which only follows the fixed media queries while the panes are at most their default widths.

import { t } from './i18n.js';
import { ariaKeys, keyLabel, on, showShortcuts, typingIn } from './keys.js';

export { typingIn };


export const VIEWS = [
  { id: 'services', label: t('shell.view.services'), href: './' },
  { id: 'devices', label: t('shell.view.devices'), href: 'devices.html' },
  { id: 'dev', label: t('shell.view.dev'), href: 'dev.html' },
  { id: 'settings', label: t('shell.view.settings'), href: 'settings.html' },
];

/** Breakpoints (CSS px) the stylesheet uses too (shell.css) */
export const WIDTH = { inspectorColumn: 1200, compact: 768, sidebarColumn: 704, phone: 640 };

/** Pane widths (CSS px): their range and default, the list's minimum, the main area's left gap, the drag threshold */
export const PANE = { side: { min: 200, max: 420, def: 288 }, insp: { min: 280, max: 480, def: 300 }, list: 324, gap: 8, drag: 3 };

/** A remembered or dragged width → a whole number in the pane's range; anything else is the default */
export function clampWidth(pane, w) {
  const p = PANE[pane];
  const n = Number(w);
  if (w == null || w === '' || !Number.isFinite(n)) return p.def;
  return Math.round(Math.max(p.min, Math.min(p.max, n)));
}

/**
 * The widest a pane can be dragged at this viewport: its max, less what the list (324) and the other pane need.
 * other: the other pane's width in the layout now (0 when it is closed or an overlay). Never under the pane's min.
 */
export function maxWidth(pane, viewport, other = 0) {
  const p = PANE[pane];
  return Math.max(p.min, Math.min(p.max, Math.floor(viewport - PANE.gap - PANE.list - other)));
}

const KEY = 'pb.shell';

/** The view a page belongs to: <body data-view>, else from its file name (service.html is part of 서비스) */
export function viewOf(path, dataView) {
  if (dataView && VIEWS.some((v) => v.id === dataView)) return dataView;
  const file = String(path ?? '').split('/').pop() || 'index.html';
  if (file.startsWith('devices')) return 'devices';
  if (file.startsWith('dev')) return 'dev';
  if (file.startsWith('settings')) return 'settings';
  return 'services';
}

/** Remembered { side, insp } (true = shown) and widths { sideW, inspW }; defaults when storage is empty, broken or throws */
export function loadState(storage) {
  let s = {};
  try { s = JSON.parse(storage?.getItem(KEY) ?? '{}') ?? {}; } catch { s = {}; }
  if (typeof s !== 'object') s = {};
  return { side: s.side !== false, insp: s.insp !== false, sideW: clampWidth('side', s.sideW), inspW: clampWidth('insp', s.inspW) };
}

export function saveState(storage, state) {
  const out = { side: !!state.side, insp: !!state.insp, sideW: clampWidth('side', state.sideW), inspW: clampWidth('insp', state.inspW) };
  try { storage?.setItem(KEY, JSON.stringify(out)); } catch {}
}

/**
 * How the sidebar and the inspector show at this width: 'column' (in the layout) or 'overlay' (over the page).
 * panes: { sideW, inspW, side } — the widths and whether the sidebar is open (its column narrows the inspector's room).
 * shell-boot.js repeats this arithmetic before the first paint; test/ui-shell.test.ts keeps the two the same.
 */
export function layoutFor(width, { sideW = PANE.side.def, inspW = PANE.insp.def, side = true } = {}) {
  const sw = clampWidth('side', sideW);
  const iw = clampWidth('insp', inspW);
  const sideMode = width < Math.max(WIDTH.sidebarColumn, sw + PANE.gap + PANE.list) ? 'overlay' : 'column';
  const shownSide = side && sideMode === 'column' ? sw : 0;
  return {
    side: sideMode,
    insp: width < Math.max(WIDTH.inspectorColumn, shownSide + PANE.gap + PANE.list + iw) ? 'overlay' : 'column',
    phone: width <= WIDTH.phone,
  };
}

/** ↑/↓ in a list of keys: the next one from current (wrapping is off); the first (or last) when nothing is selected */
export function stepSelection(keys, current, dir) {
  if (!keys.length) return null;
  const i = keys.indexOf(current);
  if (i < 0) return dir > 0 ? keys[0] : keys[keys.length - 1];
  return keys[Math.max(0, Math.min(keys.length - 1, i + dir))];
}



let api = null;
/** One shell per document (a test mounts several) */
const mounted = new WeakMap();

// What a page already fetched, for the sidebar (features/nav.js) to reuse instead of fetching it again
const shared = new Map();
const listeners = new Map();

/** share('ports', doc): the latest answer of a GET the page made; listeners hear it at once */
export function share(key, value) {
  shared.set(key, { value, at: Date.now() });
  for (const fn of listeners.get(key) ?? []) fn(value);
}

/** onShared('ports', fn): fn(value) now if the page shared one already, and on every share after */
export function onShared(key, fn) {
  listeners.set(key, [...(listeners.get(key) ?? []), fn]);
  const cur = shared.get(key);
  if (cur) fn(cur.value);
}

/** When the page last shared key (ms), 0 if never */
export const sharedAt = (key) => shared.get(key)?.at ?? 0;

/**
 * The main content waits (hidden, shell.css [data-wait]) until each named part has rendered once: done('page') from
 * the page, done('owners') / done('alerts') from those features. A CSS timeout shows it anyway after a few seconds.
 */
export function done(token, doc = globalThis.document) {
  for (const n of doc?.querySelectorAll?.('[data-wait]') ?? []) {
    const left = n.dataset.wait.split(/\s+/).filter((t) => t && t !== token);
    if (left.length) n.dataset.wait = left.join(' ');
    else delete n.dataset.wait;
  }
}

/** The shell of this page (mounted on import in a browser); see the top of this file */
export function shell() {
  return api;
}

export function mountShell(doc = document, win = window) {
  if (mounted.has(doc)) return mounted.get(doc);
  const root = doc.documentElement;
  const body = doc.body;
  const $ = (id) => doc.getElementById(id);
  const header = doc.querySelector('header.top');
  const side = $('shellSide');
  // a page served without the shell markers (a plain static server): nothing to wire
  if (!header || !body || !side) return null;
  const boot = win.PortboardBoot ?? null;
  const view = viewOf(win.location?.pathname, body.dataset.view);
  const insp = $('inspector');
  const hasInspector = !!insp;
  const storage = (() => { try { return win.localStorage; } catch { return null; } })();
  const state = loadState(storage);
  const media = (q) => (typeof win.matchMedia === 'function' ? win.matchMedia(q) : { matches: false, addEventListener() {} });
  const phone = media(`(max-width: ${WIDTH.phone}px)`);
  const viewport = () => win.innerWidth || root.clientWidth || WIDTH.inspectorColumn;
  // 'column' or 'overlay' for each pane at this width and these pane widths (layoutFor, top of this file)
  let modes = layoutFor(viewport(), state);
  const narrowSide = { get matches() { return modes.side === 'overlay'; } };
  const narrowInsp = { get matches() { return modes.insp === 'overlay'; } };
  const sideBtn = $('sideToggle');
  const back = $('navBack');
  const fwd = $('navFwd');
  const inspBtn = $('inspToggle');
  const ctxBox = $('shellCtx');
  const sideHandle = $('sideHandle');
  const inspHandle = $('inspHandle');

  /** The pane widths and modes on <html> (shell-boot.js set them first, from the same state) */
  const paintWidths = () => {
    root.style?.setProperty?.('--side-open', `${state.sideW}px`);
    root.style?.setProperty?.('--insp-open', `${state.inspW}px`);
    root.dataset.sideMode = modes.side;
    root.dataset.inspMode = modes.insp;
    sideHandle?.setAttribute('aria-valuenow', String(state.sideW));
    if (sideHandle) {
      if (state.side) sideHandle.removeAttribute('aria-valuetext');
      else sideHandle.setAttribute('aria-valuetext', t('nav.side.closed'));
    }
    inspHandle?.setAttribute('aria-valuenow', String(state.inspW));
  };
  /** A new viewport or pane width: the modes again; leaving an overlay mode drops its overlay */
  const relayout = () => {
    const next = layoutFor(viewport(), state);
    if (next.side !== modes.side) delete root.dataset.sideOverlay;
    if (next.insp !== modes.insp) delete root.dataset.inspOverlay;
    const changed = next.side !== modes.side || next.insp !== modes.insp;
    modes = next;
    return changed;
  };

  const paint = () => {
    root.dataset.shell = '1';
    root.dataset.side = state.side ? 'open' : 'closed';
    root.dataset.insp = hasInspector && state.insp ? 'open' : 'closed';
    paintWidths();
    sideBtn?.setAttribute('aria-expanded', String(narrowSide.matches ? 'sideOverlay' in root.dataset : state.side));
    inspBtn?.setAttribute('aria-pressed', String(narrowInsp.matches ? 'inspOverlay' in root.dataset : state.insp));
    // the page repaints its inspector when it comes into view (shell:layout)
    if (mounted.has(doc)) doc.dispatchEvent(new win.CustomEvent('shell:layout'));
  };

  // ---- the filter popover: a button and a panel (on a phone the panel is inline and always shown, by CSS) ----
  const pop = $('filterPop');
  const filterBtn = $('filterBtn');
  if (pop && filterBtn) {
    const panel = $('filterPanel');
    const setOpen = (open) => {
      pop.classList.toggle('open', open);
      filterBtn.setAttribute('aria-expanded', String(open));
      if (open) panel?.querySelector('input')?.focus?.();
    };
    filterBtn.addEventListener('click', () => setOpen(!pop.classList.contains('open')));
    const mark = () => {
      const active = [...(panel?.querySelectorAll('input') ?? [])].some((i) => (i.type === 'checkbox' ? i.checked && !i.disabled : i.value.trim() !== ''));
      pop.classList.toggle('active', active);
    };
    panel?.addEventListener('input', mark);
    panel?.addEventListener('change', mark);
    win.setTimeout?.(mark, 0);
    doc.addEventListener('click', (e) => { if (pop.classList.contains('open') && !pop.contains(e.target)) setOpen(false); });
    pop.closeFilters = () => setOpen(false);
  }

  sideBtn?.addEventListener('click', () => toggleSide());
  back?.addEventListener('click', () => win.history.back());
  fwd?.addEventListener('click', () => win.history.forward());
  inspBtn?.addEventListener('click', () => toggleInspector());
  $('inspClose')?.addEventListener('click', () => closeInspector());
  $('shellScrim')?.addEventListener('click', () => closeOverlays());
  side.addEventListener('click', (e) => { if (e.target.closest?.('a') && 'sideOverlay' in root.dataset) closeOverlays(); });

  // ---- toggles ----
  function setSide(open) {
    state.side = open;
    saveState(storage, state);
    // the open sidebar's column takes room from the inspector's
    relayout();
  }
  function toggleSide() {
    if (narrowSide.matches) {
      if ('sideOverlay' in root.dataset) delete root.dataset.sideOverlay;
      else { root.dataset.sideOverlay = ''; delete root.dataset.inspOverlay; }
    } else setSide(!state.side);
    paint();
  }
  function openInspector() {
    if (!hasInspector) return;
    if (narrowInsp.matches) { root.dataset.inspOverlay = ''; delete root.dataset.sideOverlay; }
    else if (!state.insp) { state.insp = true; saveState(storage, state); }
    paint();
  }
  function closeInspector() {
    if (narrowInsp.matches) delete root.dataset.inspOverlay;
    else { state.insp = false; saveState(storage, state); }
    paint();
  }
  function toggleInspector() {
    const shown = narrowInsp.matches ? 'inspOverlay' in root.dataset : state.insp;
    if (shown) closeInspector();
    else openInspector();
  }
  function closeOverlays() {
    delete root.dataset.sideOverlay;
    delete root.dataset.inspOverlay;
    paint();
  }
  // a new window width can move either pane between column and overlay (the overlays drop then)
  win.addEventListener?.('resize', () => { if (relayout()) paint(); else paintWidths(); });
  phone.addEventListener('change', () => paint());

  // ---- resize handles: drag (3 px before it counts), a plain click, or ← → / Home / End on the focused handle ----
  /** The other pane's width in the layout now, for maxWidth() */
  const otherOf = (pane) => (pane === 'side'
    ? (hasInspector && state.insp && modes.insp === 'column' ? state.inspW : 0)
    : (state.side && modes.side === 'column' ? state.sideW : 0));
  /** A width for a pane from a drag or a key; the sidebar collapses under half its minimum */
  function setWidth(pane, raw, { collapse = false } = {}) {
    if (pane === 'side' && collapse && raw < PANE.side.min / 2) {
      if (state.side) { state.side = false; relayout(); paint(); }
      return;
    }
    const w = Math.min(clampWidth(pane, raw), maxWidth(pane, viewport(), otherOf(pane)));
    const reopen = pane === 'side' && !state.side;
    if (reopen) state.side = true;
    if (pane === 'side') state.sideW = w;
    else state.inspW = w;
    // the drag keeps the list's 324 px, so only reopening the sidebar can change a mode
    if (relayout() || reopen) paint();
    else paintWidths();
  }
  function wireHandle(handle, pane) {
    if (!handle) return;
    const dir = pane === 'side' ? 1 : -1; // the inspector's handle is its left edge: dragging left widens it
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture?.(e.pointerId);
      const start = pane === 'side' ? (state.side ? state.sideW : 0) : state.inspW;
      drag = { x: e.clientX, start, moved: false };
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = (e.clientX - drag.x) * dir;
      if (!drag.moved && Math.abs(dx) < PANE.drag) return;
      if (!drag.moved) { drag.moved = true; root.dataset.resizing = pane; }
      setWidth(pane, drag.start + dx, { collapse: true });
    });
    const end = () => {
      if (!drag) return;
      const { moved } = drag;
      drag = null;
      delete root.dataset.resizing;
      if (!moved) { if (pane === 'side') toggleSide(); return; }
      saveState(storage, state);
      paint();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 32 : 8;
      const cur = pane === 'side' ? state.sideW : state.inspW;
      let next = null;
      if (e.key === 'ArrowRight') next = cur + step * dir;
      else if (e.key === 'ArrowLeft') next = cur - step * dir;
      else if (e.key === 'Home') next = PANE[pane].min;
      else if (e.key === 'End') next = PANE[pane].max;
      else if ((e.key === 'Enter' || e.key === ' ') && pane === 'side') { e.preventDefault(); toggleSide(); return; }
      if (next == null) return;
      e.preventDefault();
      // the arrows never collapse: closing is Enter, the toggle or ⌘\
      setWidth(pane, next);
      saveState(storage, state);
    });
    // the drag hint says the platform's key for the toggle
    if (pane === 'side') handle.title = t('nav.side.handle', { key: keyLabel('Mod+\\') });
  }
  wireHandle(sideHandle, 'side');
  if (hasInspector) wireHandle(inspHandle, 'insp');

  // ---- keys: entries of lib/keys.js (⌘K is lib/palette.js's) ----
  on('sidebar', () => toggleSide(), doc);
  if (hasInspector) on('inspector', () => toggleInspector(), doc);
  on('shortcuts', () => { showShortcuts(doc); }, doc);
  on('back', () => win.history.back(), doc);
  on('forward', () => win.history.forward(), doc);
  on('close', () => {
    if (doc.querySelector('dialog[open]')) return false;
    if (pop?.classList.contains('open') && !phone.matches) pop.closeFilters();
    else if ('sideOverlay' in root.dataset || 'inspOverlay' in root.dataset) closeOverlays();
    // never preventDefault: the pages' own sheets (기기) hear Escape too
    return false;
  }, doc);
  // the toggle's tooltip and aria-keyshortcuts in the platform's words
  if (sideBtn) {
    const k = keyLabel('Mod+\\');
    sideBtn.title = t('nav.side.toggle', { key: k });
    sideBtn.setAttribute('aria-label', t('nav.side.toggle', { key: k }));
    sideBtn.setAttribute('aria-keyshortcuts', ariaKeys({ keys: ['Mod+\\'] }));
  }

  // ← → follow the history when the browser can tell (Navigation API; the Mac app sets data-can-go-back)
  const nav = win.navigation;
  const syncHistory = () => {
    if (!back || !fwd) return;
    if (root.dataset.app === 'mac') back.disabled = !('canGoBack' in root.dataset);
    else if (nav && 'canGoBack' in nav) back.disabled = !nav.canGoBack;
    if (nav && 'canGoForward' in nav) fwd.disabled = !nav.canGoForward;
  };
  nav?.addEventListener?.('currententrychange', syncHistory);
  if (typeof win.MutationObserver === 'function') new win.MutationObserver(syncHistory).observe(root, { attributes: true, attributeFilter: ['data-can-go-back', 'data-app'] });
  win.addEventListener?.('pageshow', syncHistory);
  syncHistory();

  paint();

  const self = {
    view,
    /** The title's part after "서비스 ·" (service.html: the port and name) */
    setContext(...nodes) { ctxBox?.replaceChildren(...nodes); },
    /** Sidebar data (features/nav.js): counts { services, devices, dev, settings }, pinned and devices [{ text, sub, tone, href, title, key }] */
    setCounts(counts) { boot?.counts(counts); },
    setPinned(items) { boot?.fill('sidePinned', items); },
    setDevices(items) { boot?.fill('sideDevices', items); },
    inspector: hasInspector ? {
      body: $('inspBody'),
      setTitle(text) { $('inspTitle').textContent = text; },
      open: openInspector,
      close: closeInspector,
      /** Shown in the layout now (a column, or the sheet on a narrow window) */
      get shown() { return narrowInsp.matches ? 'inspOverlay' in root.dataset : state.insp; },
      /** a row click: open it where the inspector is a sheet only when asked; never on a phone (상세 is inline there) */
      get usable() { return !phone.matches; },
    } : null,
  };
  api = self;
  mounted.set(doc, self);
  return self;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') mountShell();
