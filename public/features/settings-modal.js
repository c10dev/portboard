// 설정 (docs/settings/): every setting and setup step in a modal over the page, after the Claude app's settings screen.
// Only the hash changes (#settings/<section>, lib/settings-route.js) and the view behind stays as it was. A menu on the
// left (tabs under the title below 768 px), one section at a time on the right.
//
// Each section is still filled by its own feature script (the registry's `#settings` ui entries, src/features/
// settings.ts and the others; test/ui-settings.test.ts keeps SECTIONS equal to them). The modal builds the section
// containers (#startBody, #remoteBody, …) the first time it opens, then imports those scripts: a script already loaded
// by the page (port-rules.js through the inspector, digest.js for the 🔔 dialog) fills its section on `settings:mount`.
// Opening again sends `settings:refresh`, which every section listens for.
//
// History: opening and each section are pushState entries (no hashchange, so the page's own hash readers aren't
// woken), so back and forward move between sections; Esc, × and the backdrop go back to where the modal was opened
// from. A link to settings.html (the sidebar, the checklist chip, the inspector) opens the modal in place.

import { showAccess } from '../lib/access.js';
import { loadOwnerToken, saveOwnerToken } from '../lib/api.js';
import { row, segmented } from '../lib/controls.js';
import { h } from '../lib/dom.js';
import { loadLocalePref, saveLocalePref, t, tn } from '../lib/i18n.js';
import { on } from '../lib/keys.js';
import { applyListWidth, LIST_WIDTH_LABELS, LIST_WIDTHS, loadListWidth, saveListWidth } from '../lib/list-width.js';
import { createModal } from '../lib/modal.js';
import { isSettingsHash, linkSection, settingsHash, settingsSection, SETTINGS_IDS, SETTINGS_LABELS } from '../lib/settings-route.js';

/** The sections in menu order: the container its script fills, the script, and the lines above it */
export const SECTIONS = [
  { id: 'start', body: 'startBody', script: 'settings-start.js', lead: () => [t('settings.lead.start')] },
  {
    id: 'remote', sub: 'claude.ai · ChatGPT', write: true, body: 'remoteBody', script: 'remote-connector.js',
    lead: () => tn('settings.lead.remote'),
  },
  {
    id: 'write-devices', write: true, body: 'wdBody', script: 'write-devices.js',
    lead: () => [t('settings.lead.writeDevices')],
  },
  {
    id: 'port-rules', write: true, body: 'rulesBody', script: 'port-rules.js',
    lead: () => tn('settings.lead.portRules'),
  },
  { id: 'notify', write: true, body: 'notifyBody', script: 'digest.js', lead: () => [t('settings.lead.notify')] },
  { id: 'claude', write: true, body: 'claudeBody', script: 'claude-autostop.js', lead: () => [t('settings.lead.claude')] },
  { id: 'secrets', body: 'secretsBody', script: 'secrets.js', lead: () => [t('settings.lead.secrets')] },
  { id: 'display', body: 'displayBody', lead: () => [t('settings.lead.display')] },
  { id: 'about', body: 'aboutBody', script: 'about.js' },
];

for (const s of SECTIONS) s.label = SETTINGS_LABELS[s.id];

const CLOSE_ICON = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

let modal = null;
let current = null;
/** Where × goes back to when there is no entry of ours to go back over (opened from a typed hash or on load) */
let back = null;
let loaded = false;
let cssReady = null;

/** The stylesheet, once per page (pages don't link it: the modal is on every page) */
function loadCss(doc = document) {
  if (cssReady) return cssReady;
  const existing = doc.querySelector('link[href="settings.css"]');
  if (existing) return (cssReady = Promise.resolve());
  const link = h('link', { rel: 'stylesheet', href: 'settings.css' });
  cssReady = new Promise((done) => {
    link.addEventListener('load', done);
    link.addEventListener('error', done);
    // never wait long for it: an unstyled modal beats none
    setTimeout(done, 1500);
  });
  doc.head.append(link);
  return cssReady;
}

function sectionEl(s) {
  const head = `stsec-${s.id}-h`;
  return h('section', { id: `stsec-${s.id}`, class: 'st-sec', hidden: true, 'aria-labelledby': head, dataset: s.write ? { hasWrite: '1', section: s.id } : { section: s.id } },
    h('h3', { class: 'st-sec-title', id: head }, s.label, s.sub ? h('span', { class: 'set-sub' }, s.sub) : null),
    s.lead ? h('p', { class: 'set-lead' }, s.lead()) : null,
    h('div', { id: s.body, class: 'set-body' }));
}

/** 화면: this browser's own settings (lib/list-width.js) */
function paintDisplay() {
  const body = document.getElementById('displayBody');
  if (!body) return;
  const width = segmented({
    id: 'listWidth', value: loadListWidth(),
    options: Object.entries(LIST_WIDTH_LABELS).map(([value, label]) => ({ value, label, title: t('settings.display.width.max', { px: LIST_WIDTHS[value][0] }) })),
    onChange: (v) => { saveListWidth(v); applyListWidth(v); },
  });
  const lang = segmented({
    id: 'uiLocale', value: loadLocalePref(),
    options: [
      { value: 'auto', label: t('settings.display.lang.auto') },
      { value: 'ko', label: t('settings.display.lang.ko') },
      { value: 'en', label: t('settings.display.lang.en') },
    ],
    // the page is built again in it (lib/shell-boot.js picks it before the first paint)
    onChange: (v) => { saveLocalePref(v); location.reload(); },
  });
  body.replaceChildren(h('div', { class: 'st-rows' },
    row({ label: t('settings.display.width'), desc: t('settings.display.width.desc'), control: width }),
    row({ label: t('settings.display.lang'), desc: t('settings.display.lang.desc'), control: lang })));
}

/**
 * 화면 › 소유자 토큰 (token mode, #12): the token `portboard token` printed, kept in this browser only (lib/api.js
 * sends it as a header). Shown when the server is in token mode, or while this browser still keeps one. Not a
 * data-write control: entering it is how a read-only browser becomes the owner. A change reloads the page, so every
 * part asks /api/whoami again.
 */
function paintOwnerToken(w) {
  const rows = document.getElementById('displayBody')?.querySelector('.st-rows');
  if (!rows) return;
  document.getElementById('ownerTokenRow')?.remove();
  const kept = loadOwnerToken();
  if (w?.mode !== 'token' && !kept) return;
  const input = h('input', { type: 'password', id: 'ownerToken', class: 'ctl-text', autocomplete: 'off', spellcheck: 'false', placeholder: kept ? t('settings.token.kept') : 'pbt_…', 'aria-label': t('settings.token.label') });
  const save = () => {
    if (!input.value.trim()) return;
    if (!saveOwnerToken(input.value)) {
      input.setCustomValidity?.(t('settings.token.invalid'));
      input.reportValidity?.();
      return;
    }
    location.reload();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  input.addEventListener('input', () => input.setCustomValidity?.(''));
  const state = !kept ? t('settings.token.none') : w?.source === 'token' && w.canWrite ? t('settings.token.ok') : t('settings.token.refused');
  rows.append(row({
    id: 'ownerTokenRow',
    label: t('settings.token.label'),
    desc: `${t('settings.token.desc')} ${state}`,
    control: h('div', { class: 'ctl-group' },
      input,
      h('button', { type: 'button', class: 'btn primary', onclick: save }, t('settings.token.save')),
      kept ? h('button', { type: 'button', class: 'btn', onclick: () => { saveOwnerToken(''); location.reload(); } }, t('settings.token.forget')) : null),
  }));
}

/**
 * Sections with write controls get one line saying why they are greyed out, for a viewer who may not write. Also what
 * depends on how the server decides that (#12): the owner token row, and 쓰기 허용 기기 (a list of tailnet devices)
 * left out of the menu when Tailscale isn't running there.
 */
async function readOnlyNotes() {
  const w = await showAccess();
  paintOwnerToken(w);
  const wd = modal.el.querySelector('.st-tab[data-section="write-devices"]');
  if (wd) wd.hidden = w?.tailscale === false;
  for (const p of modal.el.querySelectorAll('.set-ro.st-ro')) p.remove();
  if (!w || w.canWrite) return;
  for (const sec of modal.el.querySelectorAll('.st-sec[data-has-write]')) {
    const p = h('p', { class: 'set-ro st-ro' }, t('settings.readonly', { reason: w.reason ?? t('common.readonlyReason') }));
    (sec.querySelector('.set-lead') ?? sec.querySelector('.st-sec-title')).after(p);
  }
}

function build() {
  modal = createModal({ id: 'settingsModal', className: 'st-modal', labelledBy: 'stTitle', onRequestClose: leave });
  const close = h('button', { type: 'button', class: 'icon-btn st-close', 'aria-label': t('settings.close'), title: t('settings.close.title'), onclick: leave });
  close.insertAdjacentHTML('beforeend', CLOSE_ICON);
  const tabs = h('nav', { class: 'st-nav', 'aria-label': t('settings.menu') },
    SECTIONS.map((s) => h('a', { class: 'st-tab', href: settingsHash(s.id), dataset: { section: s.id } }, s.label)));
  modal.el.append(h('div', { class: 'st' },
    h('div', { class: 'st-side' }, h('h2', { class: 'st-title', id: 'stTitle' }, t('settings.title')), tabs),
    // focus lands here on open (no ring): ↑↓ scroll at once, Tab goes to the menu
    h('div', { class: 'st-content', id: 'stContent', tabindex: '-1', autofocus: '' }, SECTIONS.map(sectionEl)),
    close));
  paintDisplay();
}

/** Show one section: the menu's current item, the content scrolled to its top */
function show(id) {
  current = id;
  for (const sec of modal.el.querySelectorAll('.st-sec')) sec.hidden = sec.dataset.section !== id;
  for (const a of modal.el.querySelectorAll('.st-tab')) {
    const on = a.dataset.section === id;
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const content = document.getElementById('stContent');
  if (content) content.scrollTop = 0;
  // the menu is a row of tabs on a phone: keep the current one in view
  modal.el.querySelector('.st-tab[aria-current]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

/** The section scripts, first open only; then `settings:mount` for the ones the page had loaded already */
async function loadSections() {
  if (loaded) {
    document.dispatchEvent(new Event('settings:refresh'));
    readOnlyNotes();
    return;
  }
  loaded = true;
  readOnlyNotes();
  await Promise.all(SECTIONS.filter((s) => s.script).map((s) => import(`./${s.script}`).catch(() => {
    document.getElementById(s.body)?.replaceChildren(h('p', { class: 'set-note' }, t('settings.loadFailed', { name: s.label })));
  })));
  document.dispatchEvent(new Event('settings:mount'));
}

const here = () => location.pathname + location.search;
const depth = () => (history.state && history.state.pbSettings ? Number(history.state.depth) || 0 : 0);

/**
 * Open at a section (or move to it when open). push: a history entry for it (a click); not when the URL already says
 * it (load, back/forward, a typed hash). from: where × goes back to, when the URL before isn't ours to go back to.
 */
export async function openSettings(id = 'start', { push = true, from } = {}) {
  if (!SETTINGS_IDS.includes(id)) id = 'start';
  // built before the wait, so a popstate and a hashchange for the same step don't build it twice
  if (!modal) build();
  await loadCss();
  if (modal.isOpen) {
    if (id === current) return;
    show(id);
    if (push) history.pushState({ pbSettings: true, depth: depth() + 1 }, '', settingsHash(id));
    return;
  }
  back = from ?? (isSettingsHash(location.hash) ? here() : here() + location.hash);
  show(id);
  modal.open();
  if (push) history.pushState({ pbSettings: true, depth: 1 }, '', settingsHash(id));
  loadSections();
}

/** ×, Esc, the backdrop: back over our entries to the page as it was, or to the URL it was opened from */
function leave() {
  const n = depth();
  const to = back ?? here();
  back = null;
  modal.close();
  if (n > 0) history.go(-n);
  else history.replaceState(null, '', to);
}

/** The URL changed under us (back, forward, a typed hash): open, move or close to match */
function sync(e) {
  const id = settingsSection(location.hash);
  if (id) {
    let from;
    try {
      if (e?.oldURL && !isSettingsHash(new URL(e.oldURL).hash)) { const o = new URL(e.oldURL); from = o.pathname + o.search + o.hash; }
    } catch {}
    openSettings(id, { push: false, from });
  } else if (modal?.isOpen) {
    back = null;
    modal.close();
  }
}

function onClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('a[href]');
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
  const id = linkSection(a.getAttribute('href'), location.href);
  if (!id) return;
  e.preventDefault();
  // a link in another dialog (the 🔔 dialog's 설정 › 알림): that one closes first
  const other = a.closest('dialog');
  if (other && other !== modal?.el && other.open) other.close();
  openSettings(id);
}

export function initSettings() {
  applyListWidth(loadListWidth());
  // the stylesheet early, so the first open is styled at once
  loadCss();
  document.addEventListener('click', onClick);
  // ⌘, (lib/keys.js; in the Mac app ⌘, is the app's own settings, and ⌘4 opens this)
  on('settings', () => { if (!modal?.isOpen) openSettings(current ?? 'start'); });
  window.addEventListener('popstate', sync);
  window.addEventListener('hashchange', sync);
  if (isSettingsHash(location.hash)) sync();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && !globalThis.__PB_NO_AUTO__) initSettings();
