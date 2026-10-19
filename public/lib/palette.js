// The command palette every page has: ⌘K / Ctrl+K, "/" (outside a text field) or the 🔍 button it adds to the header.
// Generic: the page's adapter (features/palette.js) gives it commands and a lazy load() of items; this file owns the
// dialog, matching (lib/fuzzy.js), the keyboard, and the recent list (localStorage pb.palette.recent). Its own keys
// (⌘K, /) are the 'palette' entry of lib/keys.js, the one shortcut registry.
//
//   item:  { id, kind, title, sub?, text?, weight?, keys?, actions: [{ key, label, run, danger?, names? }] }
//          keys: the item's shortcut as it reads (['⌘\\']), shown at the right of its row.
//          actions[0] is what Enter or a tap does; → / Tab (or the › button) lists all of them. weight: added to
//          the item's match score (shown ports before worktrees with the same name).
//   verbs: [{ key, names }]: "8790 로그" or "restart webapp" lists that action on the matching items directly.

import { modal } from './dialog.js';
import { $, el, h } from './dom.js';
import { rank, segments, words } from './fuzzy.js';
import { ariaKeys, isMacPlatform, keyLabel, keysOf, on, SHORTCUTS } from './keys.js';
import { t } from './i18n.js';

const RECENT_KEY = 'pb.palette.recent';
const MAX_RECENT = 8;
const SHOW_RECENT = 5;
/** rows per kind with an empty query, and rows in all with one */
const PER_KIND = 8;
const LIMIT = 40;
/** reuse loaded items this long before fetching again on open */
const STALE_MS = 15_000;

/**
 * A query word (2+ characters) that starts one of a verb's names → { verb, rest } (rest: the other words), else null.
 */
export function verbSplit(query, verbs) {
  const ws = words(query);
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w.length < 2) continue;
    const v = verbs.find((x) => x.names.some((n) => n.toLowerCase().startsWith(w)));
    if (v) return { verb: v.key, rest: ws.filter((_, j) => j !== i).join(' ') };
  }
  return null;
}

function readRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(key) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...readRecent().filter((k) => k !== key)].slice(0, MAX_RECENT))); } catch {}
}

const PALETTE_KEYS = SHORTCUTS.find((s) => s.id === 'palette');

const DIALOG = `
<dialog id="palette" class="palette" aria-label="${t('palette.name')}">
  <div class="pal-head">
    <button type="button" id="palBack" class="pal-back" aria-label="${t('palette.back')}" hidden>←</button>
    <input id="palQ" type="search" autocomplete="off" spellcheck="false" enterkeyhint="go" role="combobox" aria-expanded="true" aria-controls="palList" aria-autocomplete="list">
    <button type="button" id="palClose" class="pal-close">${t('common.close')}</button>
  </div>
  <div id="palCtx" class="pal-ctx" hidden></div>
  <ul id="palList" class="pal-list" role="listbox" aria-label="${t('palette.results')}"></ul>
  <p class="pal-foot">${t('palette.foot')}</p>
</dialog>`;

/**
 * Wire the palette on this page. commands(): items that need no fetch (tabs, 새로고침); load(): the fetched items;
 * kinds: { kind: label } in the order an empty query lists them; verbs: see the top.
 */
export function initPalette({ commands = () => [], load = async () => [], kinds = {}, verbs = [], placeholder = t('palette.placeholder') }) {
  const link = el('link');
  link.rel = 'stylesheet';
  link.href = new URL('../palette.css', import.meta.url).href;
  document.head.append(link);

  const dialog = modal('palette', DIALOG, 'palClose');
  const input = $('palQ');
  const list = $('palList');
  input.placeholder = placeholder;

  let loaded = [];
  let loadedAt = 0;
  let loading = null;
  /** the item whose actions are listed (→), or null for the main list */
  let focus = null;
  let rows = [];
  let sel = 0;

  const items = () => [...commands(), ...loaded];

  function fetchItems(force = false) {
    if (loading || (!force && loadedAt && Date.now() - loadedAt < STALE_MS)) return;
    loading = load()
      .then((next) => { loaded = next; loadedAt = Date.now(); })
      .catch(() => {})
      .finally(() => { loading = null; if (dialog.open) paint(); });
  }

  function open(query = '') {
    focus = null;
    input.value = query;
    if (!dialog.open) dialog.showModal();
    fetchItems();
    paint();
    input.focus();
    input.select();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  /** Entries for the current query: { item, action?, hits, group? } */
  function entries() {
    const q = input.value;
    if (focus) {
      return rank(q, focus.actions.map((a) => ({ title: a.label, text: (a.names ?? []).join(' '), a })))
        .map((r) => ({ item: focus, action: r.item.a, hits: r.hits, actionHits: true }));
    }
    const all = items();
    const recent = readRecent();
    if (!words(q).length) return emptyList(all, recent);
    const boost = (id) => {
      const i = recent.indexOf(id);
      return i < 0 ? 0 : 60 - i * 5;
    };
    const out = [];
    const verb = verbs.length ? verbSplit(q, verbs) : null;
    if (verb) {
      const withVerb = all.filter((it) => it.actions.some((a) => a.key === verb.verb));
      for (const r of rank(verb.rest, withVerb.map((it) => ({ title: it.title, text: it.text, boost: boost(`${it.id}::${verb.verb}`) + (it.weight ?? 0), it })), { limit: 12 })) {
        out.push({ item: r.item.it, action: r.item.it.actions.find((a) => a.key === verb.verb), hits: r.hits });
      }
    }
    for (const r of rank(q, all.map((it) => ({ title: it.title, text: it.text, boost: boost(it.id) + (it.weight ?? 0), it })), { limit: LIMIT })) {
      out.push({ item: r.item.it, hits: r.hits });
    }
    return out.slice(0, LIMIT);
  }

  function emptyList(all, recent) {
    const byId = new Map(all.map((it) => [it.id, it]));
    const out = [];
    for (const key of recent) {
      const [id, actionKey] = key.split('::');
      const item = byId.get(id);
      const action = actionKey ? item?.actions.find((a) => a.key === actionKey) : null;
      if (!item || (actionKey && !action)) continue;
      out.push({ item, action, hits: [], group: t('palette.recent') });
      if (out.length >= SHOW_RECENT) break;
    }
    for (const [kind, label] of Object.entries(kinds)) {
      const of = all.filter((it) => it.kind === kind);
      const shown = kind === 'cmd' ? of : of.slice(0, PER_KIND);
      out.push(...shown.map((item) => ({ item, hits: [], group: label })));
      if (of.length > shown.length) out.push({ more: t('palette.more', { kind: label, n: of.length - shown.length }), group: label });
    }
    return out;
  }

  function title(text, hits) {
    return segments(text, hits).map((s) => (s.hit ? el('mark', null, s.text) : s.text));
  }

  function paint() {
    const ctx = $('palCtx');
    $('palBack').hidden = ctx.hidden = !focus;
    if (focus) ctx.replaceChildren(el('span', 'pal-kind', kinds[focus.kind] ?? ''), el('strong', null, focus.title));
    input.placeholder = focus ? t('palette.searchActions') : placeholder;

    const es = entries();
    rows = es.filter((e) => e.item);
    sel = Math.min(sel, Math.max(0, rows.length - 1));
    const nodes = [];
    let group = null;
    let n = 0;
    for (const e of es) {
      if (e.group && e.group !== group) {
        group = e.group;
        nodes.push(el('li', 'pal-group', group));
      }
      if (e.more) { nodes.push(el('li', 'pal-more', e.more)); continue; }
      nodes.push(row(e, n++));
    }
    if (!rows.length) nodes.push(emptyRow());
    if (loading && !loadedAt) nodes.push(el('li', 'pal-more', t('palette.loading')));
    list.replaceChildren(...nodes);
    mark();
  }

  function emptyRow() {
    const li = el('li', 'pal-empty');
    li.append(el('strong', null, focus ? t('palette.none.actions', { q: input.value.trim() }) : t('palette.none.items', { q: input.value.trim() })));
    if (!focus) li.append(el('span', null, t('palette.none.help')));
    return li;
  }

  function row(e, i) {
    const { item, action } = e;
    const li = h('li', { class: `pal-row${action?.danger ? ' danger' : ''}`, id: `pal-${i}`, role: 'option', dataset: { i: String(i) } });
    const main = el('div', 'pal-main');
    const line = el('div', 'pal-title');
    if (e.actionHits) line.append(...title(action.label, e.hits));
    else line.append(...title(item.title, e.hits));
    main.append(line);
    const sub = e.actionHits ? null : item.sub;
    if (sub) main.append(el('div', 'pal-sub', sub));
    // an item's own action list says the item once, above the list
    if (!e.actionHits) li.append(el('span', `pal-kind k-${item.kind}`, kinds[item.kind] ?? item.kind));
    li.append(main);
    if (!e.actionHits && item.keys?.length) li.append(h('span', { class: 'pal-keys' }, item.keys.map((k) => el('kbd', null, k))));
    if (action && !e.actionHits) li.append(el('span', 'pal-verb', action.label));
    else if (!focus && item.actions.length > 1) {
      li.append(h('button', {
        type: 'button', class: 'pal-drill', title: t('palette.drill'), 'aria-label': t('palette.drill.aria', { title: item.title }), tabindex: '-1',
        onclick: (ev) => { ev.stopPropagation(); drill(item); },
      }, '›'));
    } else if (!focus && item.actions[0] && !item.keys?.length) {
      li.append(el('span', 'pal-hint', item.actions[0].label));
    }
    li.addEventListener('click', () => run(rows[i]));
    li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; mark(); } });
    return li;
  }

  function mark() {
    for (const n of list.querySelectorAll('.pal-row')) {
      const on = Number(n.dataset.i) === sel;
      n.classList.toggle('sel', on);
      n.setAttribute('aria-selected', String(on));
      if (on) n.scrollIntoView({ block: 'nearest' });
    }
    if (rows.length) input.setAttribute('aria-activedescendant', `pal-${sel}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function drill(item) {
    focus = item;
    input.value = '';
    sel = 0;
    paint();
    input.focus();
  }

  function back() {
    focus = null;
    input.value = '';
    sel = 0;
    paint();
    input.focus();
  }

  async function run(e) {
    if (!e) return;
    const action = e.action ?? e.item.actions[0];
    if (!action) return;
    pushRecent(e.action && e.action !== e.item.actions[0] ? `${e.item.id}::${action.key}` : e.item.id);
    close();
    // after the dialog is gone, so a confirm() or a navigation isn't under it
    await action.run();
    // the action may have changed what the items say (★, 🔔)
    loadedAt = 0;
  }

  input.addEventListener('input', () => { sel = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    // Enter or an arrow that commits a Hangul syllable belongs to the IME
    if (e.isComposing || e.keyCode === 229) return;
    const cur = rows[sel];
    const atEnd = input.selectionStart === input.value.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(cur);
    } else if ((e.key === 'ArrowRight' && atEnd) || (e.key === 'Tab' && !e.shiftKey)) {
      if (!focus && cur && !cur.action && cur.item.actions.length > 1) {
        e.preventDefault();
        drill(cur.item);
      }
    } else if (focus && ((e.key === 'ArrowLeft' && input.selectionStart === 0) || (e.key === 'Backspace' && !input.value))) {
      e.preventDefault();
      back();
    }
  });
  // Esc closes the palette only: the 기기 tab's detail sheet listens for Escape on document too
  dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.addEventListener('close', () => { focus = null; });
  $('palBack').addEventListener('click', back);

  // ⌘K toggles the palette (also from inside it); "/" opens it outside a field (lib/keys.js checks that)
  on('palette', () => {
    if (dialog.open) close();
    else open();
  });

  // The shell's pages carry the button (src/core/shell.ts): wire it, and say the platform's key (Ctrl K off a Mac)
  const mac = isMacPlatform();
  const [main, ...alts] = keysOf(PALETTE_KEYS, mac).map((k) => keyLabel(k, mac));
  const keyTitle = t('palette.btn.title', { keys: [main, ...alts].join(` ${t('keys.or')} `) });
  const existing = $('paletteBtn');
  if (existing) {
    existing.addEventListener('click', () => open());
    existing.querySelector('kbd')?.replaceChildren(main);
    existing.title = keyTitle;
    existing.setAttribute('aria-keyshortcuts', ariaKeys(PALETTE_KEYS, mac));
  }
  const controls = document.querySelector('.top .controls');
  if (controls && !existing) {
    controls.prepend(h('button', {
      type: 'button', id: 'paletteBtn', class: 'palette-btn', title: keyTitle, 'aria-label': t('palette.name'),
      'aria-keyshortcuts': ariaKeys(PALETTE_KEYS, mac), onclick: () => open(),
    }, el('span', 'pb-ico', '🔍'), el('kbd', null, main)));
  }

  return { open, close, invalidate: () => (loadedAt = 0) };
}
