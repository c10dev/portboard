// The dashboard's one shortcut registry (docs/research/rea-references.md #3, after claude.ai's command registry): every
// shortcut is defined here once — id, keys, label, group and scope — and the same entry drives the key handler, the
// command palette's 명령 rows (with their keys at the right) and the ⌘/ 키보드 단축키 dialog. A module registers the
// handler for an id with on(id, fn); one keydown listener per document dispatches to it.
//
//   keys   'Mod+K' is ⌘K on a Mac and Ctrl K elsewhere (either modifier works, as before); { mac, other } when the two
//          differ. Several keys are alternatives ('Mod+K', '/').
//   scope  'any': also while typing in a field or with a dialog open (⌘K, ⌘\, ⌘/, Esc);
//          'page': not while typing or with a dialog open ('/'); 'list': handled by the page itself (↑/↓ in the 서비스
//          list, public/app.js), listed here only; 'native': the browser's or the Mac app's own key (뒤로, 앞으로) —
//          never intercepted, but the palette can still run the handler (in the Mac app the 앱 section says them);
//          'hint': a row in the dialog with no key (끌어서 너비 조절).
//   app    false: the Mac app binds this key itself, so in the app the page leaves it alone and the dialog doesn't list
//          it (⌘, is the app's own settings window there; the 설정 modal is ⌘4).
//
// The Mac app's menu keys (mac-app/, PortboardApp.swift: ⌘1–4, ⌘[, ⌘R, ⇧⌘O) belong to the app: nothing here may use
// them (test/ui-keys.test.ts checks), and the dialog lists them when the page runs in the app ([data-app="mac"]).

import { t } from './i18n.js';

export const GROUPS = { general: t('keys.group.general'), list: t('keys.group.list'), panes: t('keys.group.panes'), app: t('keys.group.app') };

export const SHORTCUTS = [
  { id: 'palette', keys: ['Mod+K', '/'], label: t('keys.palette'), group: 'general', scope: 'any', text: t('keys.find.palette') },
  { id: 'shortcuts', keys: ['Mod+/'], label: t('keys.shortcuts'), group: 'general', scope: 'any', palette: true, text: t('keys.find.shortcuts') },
  { id: 'settings', keys: ['Mod+,'], label: t('shell.view.settings'), group: 'general', scope: 'any', app: false, text: t('keys.find.settings') },
  { id: 'back', keys: { mac: ['Mod+['], other: ['Alt+ArrowLeft'] }, label: t('keys.back'), group: 'general', scope: 'native', palette: true, text: t('keys.find.back') },
  { id: 'forward', keys: { mac: ['Mod+]'], other: ['Alt+ArrowRight'] }, label: t('keys.forward'), group: 'general', scope: 'native', palette: true, text: t('keys.find.forward') },
  { id: 'list.next', keys: ['ArrowDown'], label: t('keys.next'), group: 'list', scope: 'list' },
  { id: 'list.prev', keys: ['ArrowUp'], label: t('keys.prev'), group: 'list', scope: 'list' },
  { id: 'sidebar', keys: ['Mod+\\'], label: t('keys.sidebar'), group: 'panes', scope: 'any', palette: true, text: t('keys.find.sidebar') },
  { id: 'inspector', keys: [], label: t('keys.inspector'), group: 'panes', scope: 'any', palette: true, text: t('keys.find.inspector') },
  { id: 'close', keys: ['Escape'], label: t('keys.close'), group: 'panes', scope: 'any' },
  { id: 'resize', keys: [], hint: t('keys.resize.hint'), label: t('keys.resize'), group: 'panes', scope: 'hint' },
];

/** The Mac app's own menu keys (mac-app/Sources/Portboard/PortboardApp.swift), shown in the dialog in the app */
export const MAC_APP_KEYS = [
  { id: 'app.tabs', keys: ['Meta+1', 'Meta+2', 'Meta+3', 'Meta+4'], label: t('keys.app.tabs'), group: 'app' },
  { id: 'app.back', keys: ['Meta+['], label: t('keys.back'), group: 'app' },
  { id: 'app.reload', keys: ['Meta+R'], label: t('common.refresh'), group: 'app' },
  { id: 'app.browser', keys: ['Meta+Shift+O'], label: t('keys.app.browser'), group: 'app' },
  // SwiftUI's Settings scene (PortboardApp.swift): the app's own settings window
  { id: 'app.settings', keys: ['Meta+,'], label: t('keys.app.settings'), group: 'app' },
];

/** A Mac (or the Mac app, whose User-Agent says portboard-mac/): ⌘ glyphs instead of Ctrl words */
export const isMacPlatform = (nav = globalThis.navigator) =>
  /Mac|iPhone|iPad/.test(nav?.platform || nav?.userAgent || '') || /\bportboard-mac\//.test(nav?.userAgent ?? '');

/** 'Mod+Shift+K' → { mod, ctrl, meta, alt, shift, key } */
export function parseKey(combo) {
  const parts = String(combo).split('+');
  // 'Mod++' would be a plus key; none of ours is
  const key = parts.pop();
  const has = (m) => parts.includes(m);
  return { mod: has('Mod'), ctrl: has('Control'), meta: has('Meta'), alt: has('Alt'), shift: has('Shift'), key };
}

/** The keys of an entry on this platform */
export function keysOf(entry, mac = isMacPlatform()) {
  const k = entry.keys ?? [];
  return Array.isArray(k) ? k : (mac ? k.mac : k.other) ?? [];
}

/** Whether a keydown is this combo. Mod is ⌘ or Ctrl on any platform (as ⌘K and ⌘\ always were). */
export function matchKey(e, combo) {
  const c = typeof combo === 'string' ? parseKey(combo) : combo;
  if (String(e.key ?? '').toLowerCase() !== c.key.toLowerCase()) return false;
  const meta = !!e.metaKey;
  const ctrl = !!e.ctrlKey;
  if (c.mod) { if (!(meta || ctrl) || (meta && ctrl)) return false; }
  else if (meta !== c.meta || ctrl !== c.ctrl) return false;
  if (!!e.altKey !== c.alt) return false;
  // a punctuation key alone ('/') may need Shift on some layouts; everything else says its Shift
  const loose = !c.mod && !c.meta && !c.ctrl && !c.alt && !c.shift && c.key.length === 1 && !/[a-z0-9]/i.test(c.key);
  return loose || !!e.shiftKey === c.shift;
}

const GLYPH = { Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', ' ': 'Space' };

/** How a combo reads: ⌘K, ⇧⌘O on a Mac (glyphs in the order ⌃ ⌥ ⇧ ⌘); Ctrl K, Alt ←, Ctrl Shift O elsewhere */
export function keyLabel(combo, mac = isMacPlatform()) {
  const c = typeof combo === 'string' ? parseKey(combo) : combo;
  const key = GLYPH[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  if (mac) return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod || c.meta ? '⌘' : ''}${key}`;
  return [c.ctrl || c.mod ? 'Ctrl' : null, c.meta ? 'Win' : null, c.alt ? 'Alt' : null, c.shift ? 'Shift' : null, key].filter(Boolean).join(' ');
}

/** aria-keyshortcuts: Meta+K on a Mac, Control+K elsewhere; alternatives space-separated */
export function ariaKeys(entry, mac = isMacPlatform()) {
  return keysOf(entry, mac).map((k) => k.replace(/^Mod\+/, mac ? 'Meta+' : 'Control+')).join(' ');
}

/** A keydown in a text field, a select, editable text, or with a dialog open: 'page' shortcuts leave it alone */
export function typingIn(target, doc) {
  if (doc?.querySelector?.('dialog[open]')) return true;
  return !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? ''));
}

/** One registry per document (a test mounts several): handlers by id and the one keydown listener */
const registries = new WeakMap();

function registryOf(doc) {
  let r = registries.get(doc);
  if (r) return r;
  r = { handlers: new Map() };
  registries.set(doc, r);
  doc.addEventListener('keydown', (e) => {
    // Enter or an arrow that commits a Hangul syllable belongs to the IME
    if (e.isComposing || e.keyCode === 229) return;
    const handled = dispatch(doc, e);
    if (handled) e.preventDefault();
  });
  return r;
}

/** The entry this keydown runs here (a handler is registered, the scope allows it), or null */
export function shortcutFor(e, doc = globalThis.document, mac = isMacPlatform()) {
  const r = registries.get(doc);
  for (const s of SHORTCUTS) {
    if (s.scope !== 'any' && s.scope !== 'page') continue;
    if (!r?.handlers.has(s.id)) continue;
    if (s.app === false && doc?.documentElement?.dataset?.app === 'mac') continue;
    if (!keysOf(s, mac).some((k) => matchKey(e, k))) continue;
    if (s.scope === 'page' || (s.id === 'palette' && e.key === '/')) {
      // "/" opens the palette only outside a field and with no dialog open
      if (typingIn(e.target, doc)) continue;
    }
    return s;
  }
  return null;
}

function dispatch(doc, e) {
  const s = shortcutFor(e, doc);
  if (!s) return false;
  // a handler returns false when it had nothing to do (Esc with nothing open): the key goes on as usual
  return registryOf(doc).handlers.get(s.id)(e) !== false;
}

/** on('sidebar', fn): fn(event) runs on the entry's keys (and from the palette); returns an off() */
export function on(id, fn, doc = globalThis.document) {
  if (!SHORTCUTS.some((s) => s.id === id)) throw new Error(`keys.js: no shortcut ${id}`);
  const r = registryOf(doc);
  r.handlers.set(id, fn);
  return () => { if (r.handlers.get(id) === fn) r.handlers.delete(id); };
}

/** Run an entry's handler as the palette does (no event) */
export function run(id, doc = globalThis.document) {
  const fn = registries.get(doc)?.handlers.get(id);
  if (fn) fn(null);
  return !!fn;
}

/** The palette's 명령 rows: entries marked palette with a handler on this page, their keys shown at the right */
export function paletteEntries(doc = globalThis.document, mac = isMacPlatform()) {
  const r = registries.get(doc);
  return SHORTCUTS.filter((s) => s.palette && r?.handlers.has(s.id)).map((s) => ({
    id: `cmd:key:${s.id}`, kind: 'cmd', weight: 10, title: s.label, text: s.text ?? '',
    keys: keysOf(s, mac).map((k) => keyLabel(k, mac)),
    actions: [{ key: 'go', label: t('palette.act.run'), run: () => run(s.id, doc) }],
  }));
}

/** The dialog's sections: [{ group, label, rows: [{ label, keys: ['⌘K', '/'] }] }]; Mac 앱 only in the app */
export function shortcutSections({ mac = isMacPlatform(), app = false } = {}) {
  // in the app its own menu keys replace the browser's 뒤로 / 앞으로
  const all = [...SHORTCUTS.filter((s) => !(app && (s.scope === 'native' || s.app === false))), ...(app ? MAC_APP_KEYS : [])];
  return Object.entries(GROUPS)
    .map(([group, label]) => ({
      group, label,
      rows: all.filter((s) => s.group === group).map((s) => ({
        label: s.label,
        // the app's menu keys are a Mac's whatever the page thinks
        keys: s.hint ? [s.hint] : keysOf(s, mac).map((k) => keyLabel(k, mac || s.group === 'app')),
      })).filter((r) => r.keys.length),
    }))
    .filter((sec) => sec.rows.length);
}

const DIALOG_ID = 'keysDialog';

/** The ⌘/ 키보드 단축키 dialog (made on first use; shell.css has its look) */
export function showShortcuts(doc = globalThis.document) {
  const mac = isMacPlatform();
  let d = doc.getElementById(DIALOG_ID);
  if (!d) {
    d = doc.createElement('dialog');
    d.id = DIALOG_ID;
    d.className = 'keys-dialog';
    d.setAttribute('aria-labelledby', 'keysTitle');
    doc.body.append(d);
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    // Esc closes this dialog only (the shell's Esc and the 기기 sheet listen on document too)
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
  }
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const head = el('div', 'keys-head');
  const h = el('h2', null, t('keys.shortcuts'));
  h.id = 'keysTitle';
  const close = el('button', 'icon-btn', '×');
  close.type = 'button';
  close.setAttribute('aria-label', t('common.close'));
  close.addEventListener('click', () => d.close());
  head.append(h, close);
  const body = el('div', 'keys-body');
  for (const sec of shortcutSections({ mac, app: doc.documentElement?.dataset?.app === 'mac' })) {
    const s = el('section', 'keys-sec');
    s.append(el('h3', null, sec.label));
    const dl = el('dl');
    for (const r of sec.rows) {
      const dd = el('dd');
      r.keys.forEach((k, i) => {
        if (i) dd.append(el('span', 'keys-or', t('keys.or')));
        dd.append(el('kbd', null, k));
      });
      dl.append(el('dt', null, r.label), dd);
    }
    s.append(dl);
    body.append(s);
  }
  d.replaceChildren(head, body);
  if (!d.open) d.showModal?.();
  return d;
}
