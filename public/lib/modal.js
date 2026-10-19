// @ts-check
// A modal over the page (docs/settings/, after the Claude app's settings modal): a <dialog> shown with showModal(), so
// the page behind is inert and stays as it was. One copy for every modal the dashboard has:
//   - Esc, the close button and a click on the backdrop ask to close (onRequestClose decides: the 설정 modal goes back
//     to the previous hash first); an Esc a control inside already handled (an open menu) is left to it
//   - focus: the first field or [autofocus] on open, Tab wraps inside, and the element that had focus gets it back
//   - the page's toast stack (#toast) moves into the dialog while it is open, or the top layer would hide it
//   - <html data-modal> says one is open: lib/macapp.js reports the dialog to the Mac app as no-drag space
// Look: public/settings.css (.pb-modal). The caller fills .el.

const FOCUSABLE = 'a, button, input, select, textarea, summary, [tabindex]';

/** Elements Tab can reach inside root, in document order (disabled, hidden and tabindex=-1 left out) */
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((e) => {
    if (e.tagName === 'A' && !e.hasAttribute('href')) return false;
    if (e.disabled || e.getAttribute('tabindex') === '-1' || e.hidden || e.closest?.('[hidden]')) return false;
    // no layout in tests: everything counts
    return typeof e.getClientRects !== 'function' || e.getClientRects().length > 0;
  });
}

/** Where Tab goes from the active element: the other end at the edges (null: the browser moves it) */
export function wrapTarget(list, active, back) {
  if (!list.length) return null;
  const i = list.indexOf(active);
  if (i < 0) return back ? list[list.length - 1] : list[0];
  if (back && i === 0) return list[list.length - 1];
  if (!back && i === list.length - 1) return list[0];
  return null;
}

/**
 * createModal({ id, className, label | labelledBy, onRequestClose, doc })
 * → { el, open(), close(), requestClose(), isOpen }
 * @param {{ id?: string, className?: string, label?: string, labelledBy?: string, onRequestClose?: (modal: any) => void, doc?: Document }} [opts]
 */
export function createModal({ id, className = '', label, labelledBy, onRequestClose, doc = globalThis.document } = {}) {
  const d = doc.createElement('dialog');
  if (id) d.id = id;
  d.className = `pb-modal ${className}`.trim();
  d.setAttribute('aria-modal', 'true');
  if (labelledBy) d.setAttribute('aria-labelledby', labelledBy);
  else if (label) d.setAttribute('aria-label', label);
  doc.body.append(d);

  let opener = null;
  let carried = null;
  let downOnBackdrop = false;

  const m = {
    el: d,
    get isOpen() { return !!d.open; },
    open() {
      if (d.open) return m;
      opener = doc.activeElement ?? null;
      if (typeof d.showModal === 'function') d.showModal();
      else d.open = true;
      // the stack is position: fixed, so it stays where it was, now above the backdrop
      const t = doc.getElementById('toast');
      if (t && !d.contains(t)) {
        carried = { node: t, parent: t.parentNode, next: t.nextSibling };
        d.append(t);
      }
      doc.documentElement.dataset.modal = id || 'open';
      const first = d.querySelector('[autofocus]') ?? focusables(d)[0];
      first?.focus?.();
      return m;
    },
    close() {
      if (!d.open && !doc.documentElement.dataset.modal) return m;
      if (d.open) {
        if (typeof d.close === 'function') d.close();
        else d.open = false;
      }
      cleanup();
      return m;
    },
    requestClose() {
      if (onRequestClose) onRequestClose(m);
      else m.close();
    },
  };

  function cleanup() {
    if (carried) {
      const { node, parent, next } = carried;
      carried = null;
      if (parent) parent.insertBefore(node, next && next.parentNode === parent ? next : null);
    }
    delete doc.documentElement.dataset.modal;
    const back = opener;
    opener = null;
    if (back && back !== doc.body && doc.documentElement.contains(back)) back.focus?.();
  }

  d.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // the shell's Esc (sidebar, filter, sheet) listens on document: this one is the modal's
      e.stopPropagation?.();
      if (e.defaultPrevented) return;
      e.preventDefault();
      m.requestClose();
      return;
    }
    if (e.key === 'Tab') {
      const to = wrapTarget(focusables(d), doc.activeElement, !!e.shiftKey);
      if (!to) return;
      e.preventDefault();
      to.focus?.();
    }
  });
  // Esc without a keydown (a phone's back gesture) and a form method=dialog
  d.addEventListener('cancel', (e) => { e.preventDefault(); m.requestClose(); });
  d.addEventListener('close', () => { if (doc.documentElement.dataset.modal) cleanup(); });
  // the backdrop is the dialog itself (its box is the panel's children): a press that starts and ends there closes
  d.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === d; });
  d.addEventListener('click', (e) => {
    if (e.target === d && downOnBackdrop) m.requestClose();
    downOnBackdrop = false;
  });
  return m;
}
