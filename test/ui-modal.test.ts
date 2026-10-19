// The dashboard's modal (public/lib/modal.js): open and close, Esc and the backdrop through onRequestClose, focus moved
// in, wrapped on Tab and given back, the toast stack carried above the backdrop, <html data-modal> for the Mac app.
// On the fake DOM (no showModal there: the module falls back to the open property).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument, make } from './fixtures/fake-dom.ts';
import { createModal, focusables, wrapTarget } from '../public/lib/modal.js';

function page() {
  const doc = new FakeDocument();
  const opener = make(doc, 'button', { id: 'opener' });
  const toast = make(doc, 'div', { id: 'toast' });
  const after = make(doc, 'div', { id: 'after' });
  doc.body.append(opener, toast, after);
  return { doc, opener, toast };
}

function fill(doc: FakeDocument, el: any) {
  const a = make(doc, 'a', { href: '#settings/start', id: 'first' });
  const noHref = make(doc, 'a', { id: 'plain' });
  const off = make(doc, 'button', { id: 'off' });
  off.disabled = true;
  const neg = make(doc, 'li', { tabindex: '-1' });
  const hid = make(doc, 'div', { hidden: '' }, make(doc, 'button', { id: 'inHidden' }));
  const last = make(doc, 'button', { id: 'last' });
  el.append(a, noHref, off, neg, hid, last);
}

const key = (el: any, k: string, extra: Record<string, unknown> = {}) => {
  const e: any = { key: k, defaultPrevented: false, stopped: false, prevented: false, ...extra };
  e.preventDefault = () => { e.prevented = true; };
  e.stopPropagation = () => { e.stopped = true; };
  el.dispatch('keydown', e);
  return e;
};

test('focusables: links with href, enabled controls, not tabindex=-1 or inside [hidden]; wrapTarget wraps at the ends', () => {
  const { doc } = page();
  const box = make(doc, 'div');
  fill(doc, box);
  assert.deepEqual(focusables(box).map((e: any) => e.id), ['first', 'last']);
  const [a, b] = ['a', 'b'];
  assert.equal(wrapTarget([a, b], b, false), a, 'Tab on the last → the first');
  assert.equal(wrapTarget([a, b], a, true), b, 'Shift-Tab on the first → the last');
  assert.equal(wrapTarget([a, b], a, false), null, 'in the middle the browser moves it');
  assert.equal(wrapTarget([a, b], 'outside', false), a, 'focus outside → back in');
  assert.equal(wrapTarget([], a, false), null);
});

test('open: a dialog in <body>, aria-modal, labelled; focus on [autofocus] or the first field; data-modal; the toasts come along', () => {
  const { doc, opener, toast } = page();
  opener.focus();
  const m = createModal({ id: 'm', className: 'st-modal', labelledBy: 'title', doc: doc as any });
  fill(doc, m.el);
  assert.equal(m.el.tagName, 'DIALOG');
  assert.equal(m.el.className, 'pb-modal st-modal');
  assert.equal(m.el.getAttribute('aria-modal'), 'true');
  assert.equal(m.el.getAttribute('aria-labelledby'), 'title');
  assert.equal(m.isOpen, false);
  m.open();
  assert.equal(m.isOpen, true);
  assert.equal(doc.documentElement.dataset.modal, 'm');
  assert.equal((doc.activeElement as any).id, 'first');
  assert.equal(toast.parentNode, m.el, 'the stack is above the backdrop while open');
  m.close();
  assert.equal(m.isOpen, false);
  assert.equal(doc.documentElement.dataset.modal, undefined);
  assert.equal(toast.parentNode, doc.body, 'back where it was');
  assert.equal(doc.body.children.map((c: any) => c.id).slice(0, 3).join(), 'opener,toast,after', 'in the same place');
  assert.equal(doc.activeElement, opener, 'focus goes back to what had it');

  const m2 = createModal({ label: '설정', doc: doc as any });
  fill(doc, m2.el);
  m2.el.querySelector('#last')!.setAttribute('autofocus', '');
  m2.open();
  assert.equal(m2.el.getAttribute('aria-label'), '설정');
  assert.equal((doc.activeElement as any).id, 'last', '[autofocus] wins');
  assert.equal(doc.documentElement.dataset.modal, 'open');
});

test('Esc asks to close (and goes no further); an Esc a control already handled is left alone; the backdrop closes', () => {
  const { doc } = page();
  let asked = 0;
  const m = createModal({ doc: doc as any, onRequestClose: () => { asked++; } });
  fill(doc, m.el);
  m.open();
  const e = key(m.el, 'Escape');
  assert.equal(asked, 1);
  assert.ok(e.prevented && e.stopped, 'the shell\'s Esc on document does not also run');
  const handled = key(m.el, 'Escape', { defaultPrevented: true });
  assert.equal(asked, 1, 'an open menu inside took it');
  assert.ok(handled.stopped);
  // a press that starts and ends on the backdrop (the dialog itself)
  m.el.dispatch('pointerdown', { target: m.el });
  m.el.dispatch('click', { target: m.el });
  assert.equal(asked, 2);
  // a drag from inside the panel that ends on the backdrop is not a click on it
  m.el.dispatch('pointerdown', { target: m.el.querySelector('#first') });
  m.el.dispatch('click', { target: m.el });
  assert.equal(asked, 2);
  m.el.dispatch('cancel', { target: m.el });
  assert.equal(asked, 3, 'cancel (a back gesture) too');
  // without onRequestClose it just closes
  const plain = createModal({ doc: doc as any });
  plain.open();
  key(plain.el, 'Escape');
  assert.equal(plain.isOpen, false);
});

test('Tab wraps inside the modal both ways', () => {
  const { doc } = page();
  const m = createModal({ doc: doc as any });
  fill(doc, m.el);
  m.open();
  m.el.querySelector('#last')!.focus();
  const e = key(m.el, 'Tab');
  assert.ok(e.prevented);
  assert.equal((doc.activeElement as any).id, 'first');
  key(m.el, 'Tab', { shiftKey: true });
  assert.equal((doc.activeElement as any).id, 'last');
  m.el.querySelector('#first')!.focus();
  const mid = key(m.el, 'Tab');
  assert.equal(mid.prevented, false, 'not at an end: the browser moves it');
});

test('a native close (form method=dialog) cleans up too; open and close twice are no-ops', () => {
  const { doc, opener, toast } = page();
  opener.focus();
  const m = createModal({ doc: doc as any });
  m.open();
  m.open();
  assert.equal(toast.parentNode, m.el);
  m.el.open = false;
  m.el.dispatch('close', {});
  assert.equal(doc.documentElement.dataset.modal, undefined);
  assert.equal(toast.parentNode, doc.body);
  assert.equal(doc.activeElement, opener);
  m.close();
  assert.equal(m.isOpen, false);
});
