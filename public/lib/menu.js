// @ts-check
// The ⋯ menu: a <details class="menu"> with a panel of buttons. Picking an item closes the menu first. Destructive
// items (danger) go last, after a separator, in red. A click outside an open menu closes it; openMenuAt() opens one
// from elsewhere (a right-click on its row, app.js). In dense rows the ⋯ only shows on hover or focus (shell.css).

import { button, el } from './dom.js';
import { t } from './i18n.js';

/** items in menu order: the rest as given, then the danger ones; a null where the separator goes (none without both) */
export function menuOrder(items) {
  const safe = items.filter((it) => !it.danger);
  const danger = items.filter((it) => it.danger);
  return safe.length && danger.length ? [...safe, null, ...danger] : [...safe, ...danger];
}

/**
 * items: [{ label, onClick, danger?, disabled?, title?, write? }]. open: start open (a re-render keeps it under the finger);
 * onToggle(open) hears every open/close, including the close an item click does.
 * @param {{ ariaLabel: string, items: Array<{ label: string, onClick: () => void, danger?: boolean, disabled?: boolean, title?: string, write?: boolean } | null>, open?: boolean, onToggle?: (open: boolean) => void }} opts
 */
export function moreMenu({ ariaLabel, items, open = false, onToggle = () => {} }) {
  const menu = el('details', 'menu');
  menu.open = open;
  menu.addEventListener('toggle', () => onToggle(menu.open));
  const summary = el('summary', null, '⋯');
  summary.title = t('menu.more');
  summary.setAttribute('aria-label', ariaLabel);
  const panel = el('div', 'menu-panel');
  for (const it of menuOrder(items)) {
    if (!it) {
      const sep = el('div', 'menu-sep');
      sep.setAttribute('role', 'separator');
      panel.append(sep);
      continue;
    }
    const b = button(it.label, () => { menu.open = false; onToggle(false); it.onClick(); }, { disabled: it.disabled, danger: it.danger, title: it.title, write: it.write });
    panel.append(b);
  }
  menu.append(summary, panel);
  watchOutside(menu.ownerDocument);
  return menu;
}

/** Open this ⋯ menu (closing any other) and put focus on it; false when there is none */
export function openMenuAt(menu) {
  if (!menu) return false;
  for (const m of menu.ownerDocument.querySelectorAll('details.menu[open]')) if (m !== menu) m.open = false;
  menu.open = true;
  menu.querySelector('summary')?.focus?.();
  return true;
}

/** One listener per document: a press outside an open ⋯ menu closes it */
const watched = new WeakSet();
function watchOutside(doc) {
  if (!doc || watched.has(doc)) return;
  watched.add(doc);
  doc.addEventListener('pointerdown', (e) => {
    for (const m of doc.querySelectorAll('details.menu[open]')) if (!m.contains(e.target)) m.open = false;
  });
}
