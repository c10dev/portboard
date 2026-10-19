// DOM helpers shared by every page. el() is the workhorse; h() builds a small tree in one call; escapeHtml() is for
// the few places that write an HTML string (insertAdjacentHTML), so data never becomes markup.

export const $ = (id) => document.getElementById(id);

/** <tag class="cls">text</tag>; cls and text are skipped when empty/null */
export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

/**
 * h('a', { class: 'x', href, title, onclick: fn }, 'text', child, [more]) → element.
 * Props: class, text, dataset, on<event> handlers, booleans as properties (hidden, disabled, open), the rest as attributes.
 * Children: strings, nodes, arrays; null/undefined/false are skipped.
 */
export function h(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean') n[k] = v;
    else n.setAttribute(k, String(v));
  }
  n.append(...flat(children));
  return n;
}

function flat(children) {
  return children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map((c) => (typeof c === 'number' ? String(c) : c));
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text → safe inside HTML text or a quoted attribute */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** A link that opens in a new tab (target=_blank rel=noopener) */
export function extLink(text, href, cls) {
  const a = el('a', cls, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

/** <button type="button">: opts { disabled, danger, title, write } (write: it changes something; read-only callers see it disabled) */
export function button(label, onClick, opts = {}) {
  const b = el('button', opts.danger ? 'danger' : '', label);
  b.type = 'button';
  b.disabled = !!opts.disabled;
  if (opts.title) b.title = opts.title;
  if (opts.write) b.dataset.write = '1';
  b.addEventListener('click', onClick);
  return b;
}

/** <dl> from [label, value] rows; empty values (null, undefined, '') are left out */
export function dl(rows) {
  const list = el('dl');
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    list.append(el('dt', null, k), el('dd', null, String(v)));
  }
  return list;
}
