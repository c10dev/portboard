// Settings controls (docs/settings/, after the Claude app's settings screen), shared by every 설정 section:
//   toggle()      a 36 × 20 switch: a real <input type=checkbox role=switch>, so a section that reads .checked and
//                 .value, or queries input[type=checkbox], works as it did with a plain checkbox
//   segmented()   32 px segments, only the picked one raised: radios in a radiogroup (arrow keys move the pick)
//   menuSelect()  a borderless text button with a chevron that opens a list (each option may have a line under it)
//   row()         a settings row: label and an optional description on the left, the control on the right
// segmented() and menuSelect() return a root with .value (get/set), .disabled (get/set) and a bubbling `change` event,
// like a <select>, so a section that did $('x').value = … or listened for change keeps its logic. data-write (the
// write greying, style.css) goes on the root. Look: public/settings.css (.ctl-*). Nothing has a fixed width: a
// control is at most its row, and the row wraps it under the label when they don't fit side by side.

import { h } from './dom.js';

const CHEVRON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let seq = 0;
const uid = (p) => `${p}${++seq}`;

/** fire `change` the way an <input> does (bubbles), with the new value */
function changed(root, value, onChange) {
  root.dispatchEvent?.(new Event('change', { bubbles: true }));
  onChange?.(value);
}

/** Define value / disabled on a root the way a form control has them */
function controlProps(root, { get, set, getDisabled, setDisabled }) {
  Object.defineProperty(root, 'value', { configurable: true, get, set });
  Object.defineProperty(root, 'disabled', { configurable: true, get: getDisabled, set: setDisabled });
}

/** toggle({ checked, label, value, id, disabled, write, onChange(checked) }) → <label class="ctl-toggle"> with .input */
export function toggle({ checked = false, label, value, id, disabled = false, write = false, onChange } = {}) {
  const input = h('input', {
    type: 'checkbox', role: 'switch', class: 'ctl-toggle-input', id, value, checked: !!checked, disabled: !!disabled,
    'aria-label': label, dataset: write ? { write: '1' } : null,
    onchange: () => onChange?.(input.checked),
  });
  // properties too (a browser reflects the attributes; this keeps it exact)
  input.checked = !!checked;
  if (value != null) input.value = String(value);
  const wrap = h('label', { class: 'ctl-toggle', dataset: write ? { write: '1' } : null }, input, h('span', { class: 'ctl-toggle-track', 'aria-hidden': 'true' }));
  wrap.input = input;
  return wrap;
}

/**
 * segmented({ options: [{ value, label, title }], value, label, id, name, write, onChange(value) })
 * → <div class="ctl-seg" role="radiogroup"> with .value and .disabled
 */
export function segmented({ options, value, label, id, name = uid('seg'), write = false, onChange } = {}) {
  const radios = [];
  const root = h('div', { class: 'ctl-seg', role: 'radiogroup', id, 'aria-label': label, dataset: write ? { write: '1' } : null },
    options.map((o) => {
      const r = h('input', { type: 'radio', class: 'ctl-seg-input', name, value: String(o.value), checked: String(o.value) === String(value) });
      r.checked = String(o.value) === String(value);
      r.value = String(o.value);
      r.addEventListener('change', () => { if (r.checked) onChange?.(String(o.value)); });
      radios.push(r);
      return h('label', { class: 'ctl-seg-opt', title: o.title }, r, h('span', null, o.label));
    }));
  let off = false;
  controlProps(root, {
    get: () => radios.find((r) => r.checked)?.value ?? '',
    set: (v) => { for (const r of radios) r.checked = r.value === String(v); },
    getDisabled: () => off,
    setDisabled: (v) => { off = !!v; for (const r of radios) r.disabled = off; root.classList.toggle('disabled', off); },
  });
  return root;
}

/**
 * menuSelect({ options: [{ value, label, desc }], value, label, id, write, onChange(value) })
 * → <div class="ctl-menu"> with .value and .disabled; the list opens under the button (above it near the bottom)
 */
export function menuSelect({ options, value, label, id, write = false, onChange, doc = globalThis.document } = {}) {
  const listId = uid('menu');
  const text = h('span', { class: 'ctl-menu-text' });
  const btn = h('button', { type: 'button', class: 'ctl-menu-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-label': label }, text);
  btn.insertAdjacentHTML?.('beforeend', CHEVRON);
  const items = options.map((o) =>
    h('li', { role: 'option', class: 'ctl-menu-opt', tabindex: '-1', dataset: { value: String(o.value) }, 'aria-selected': 'false' },
      h('span', { class: 'ctl-menu-label' }, o.label), o.desc ? h('span', { class: 'ctl-menu-desc' }, o.desc) : null));
  const list = h('ul', { class: 'ctl-menu-list', role: 'listbox', id: listId, hidden: true, 'aria-label': label }, items);
  const root = h('div', { class: 'ctl-menu', id, dataset: write ? { write: '1' } : null }, btn, list);
  let current = String(value ?? options[0]?.value ?? '');

  const paint = () => {
    const o = options.find((x) => String(x.value) === current);
    text.textContent = o ? o.label : '';
    btn.title = o?.desc ?? o?.label ?? '';
    for (const li of items) li.setAttribute('aria-selected', String(li.dataset.value === current));
  };
  const isOpen = () => !list.hidden;
  const place = () => {
    const win = doc.defaultView;
    if (!win || typeof btn.getBoundingClientRect !== 'function') return;
    // fixed, so the modal's scrolling content doesn't clip it; flipped up when there's no room below
    const r = btn.getBoundingClientRect();
    list.style.minWidth = `${Math.round(r.width)}px`;
    list.style.right = `${Math.max(8, Math.round(win.innerWidth - r.right))}px`;
    list.style.left = 'auto';
    const below = win.innerHeight - r.bottom;
    const tall = list.offsetHeight || 0;
    if (tall > below - 8 && r.top > below) {
      list.style.top = 'auto';
      list.style.bottom = `${Math.round(win.innerHeight - r.top + 4)}px`;
    } else {
      list.style.bottom = 'auto';
      list.style.top = `${Math.round(r.bottom + 4)}px`;
    }
  };
  const open = (focusIdx) => {
    if (root.disabled) return;
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    place();
    const i = focusIdx ?? Math.max(0, items.findIndex((li) => li.dataset.value === current));
    items[i]?.focus?.();
  };
  const close = (refocus = true) => {
    if (!isOpen()) return;
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus?.();
  };
  const pick = (v) => {
    close();
    if (v === current) return;
    current = v;
    paint();
    changed(root, v, onChange);
  };

  btn.addEventListener('click', () => (isOpen() ? close() : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest?.('li[role="option"]');
    if (li) pick(li.dataset.value);
  });
  list.addEventListener('keydown', (e) => {
    const i = items.indexOf(doc.activeElement);
    const to = (n) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus?.(); };
    if (e.key === 'ArrowDown') to(i + 1);
    else if (e.key === 'ArrowUp') to(i - 1);
    else if (e.key === 'Home') to(0);
    else if (e.key === 'End') to(items.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (i >= 0) pick(items[i].dataset.value);
    } else if (e.key === 'Escape') {
      // this Esc is the menu's: the modal around it stays open (lib/modal.js skips a handled Esc)
      e.preventDefault();
      e.stopPropagation?.();
      close();
    } else if (e.key === 'Tab') close(false);
  });
  doc.addEventListener('pointerdown', (e) => { if (isOpen() && !root.contains(e.target)) close(false); });
  // the list is fixed: when what is under it moves, it closes rather than float away
  doc.defaultView?.addEventListener?.('resize', () => close(false));
  doc.addEventListener('scroll', (e) => { if (isOpen() && !list.contains(e.target)) close(false); }, true);

  let off = false;
  controlProps(root, {
    get: () => current,
    set: (v) => { current = String(v); paint(); },
    getDisabled: () => off,
    setDisabled: (v) => { off = !!v; btn.disabled = off; if (off) close(false); },
  });
  root.open = open;
  root.close = close;
  paint();
  return root;
}

/** row({ label, desc, control, id, cls }) → <div class="st-row"> (69 px with a description, 57 px without) */
export function row({ label, desc, control, id, cls } = {}) {
  return h('div', { class: `st-row${desc ? ' has-desc' : ''}${cls ? ` ${cls}` : ''}`, id },
    h('div', { class: 'st-row-text' }, h('div', { class: 'st-row-label' }, label), desc ? h('div', { class: 'st-row-desc' }, desc) : null),
    control ? h('div', { class: 'st-row-ctl' }, control) : null);
}
