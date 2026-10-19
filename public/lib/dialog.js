// @ts-check
// Dialogs and sheets. modal(): a <dialog> made from a fixed HTML template the first time it's needed, with a close
// button. sheet(): a panel shown beside the page (the 기기 tab's detail) that keeps its scroll on a re-render.

import { $ } from './dom.js';

/** Insert the template once (it must contain <dialog id=id>), wire closeId to close it; returns the dialog */
export function modal(id, html, closeId) {
  if (!$(id)) document.body.insertAdjacentHTML('beforeend', html);
  const d = /** @type {HTMLDialogElement} */ ($(id));
  if (closeId) $(closeId)?.addEventListener('click', () => d.close());
  return d;
}

/** A panel (hidden attribute) with a close button; Escape closes it too. onClose runs on every close. */
export function sheet(panel, closeBtn, onClose = () => {}) {
  const hide = () => { onClose(); panel.hidden = true; };
  closeBtn?.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  return {
    get open() { return !panel.hidden; },
    hide,
    /** paint() fills the panel, then it shows; keepScroll: it was already showing the same thing */
    show(paint, keepScroll) {
      const scroll = panel.scrollTop;
      paint();
      panel.hidden = false;
      if (keepScroll) panel.scrollTop = scroll;
    },
  };
}
