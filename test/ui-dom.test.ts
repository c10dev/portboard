// h() from public/lib/dom.js on the fake DOM: boolean props go to the element's property when it has one, else to
// the attribute (readonly → readOnly in a browser). And the caller that needed it: the 포트 규칙 form keeps an existing
// rule's key read-only while you edit it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument, make } from './fixtures/fake-dom.ts';
import { h } from '../public/lib/dom.js';
import { t } from '../public/lib/i18n.js';

const doc = new FakeDocument();
(globalThis as any).document = doc;

test('h: a boolean prop sets the property when the element has one, else an empty attribute', () => {
  const input: any = h('input', { readonly: true, disabled: true });
  assert.equal(input.getAttribute('readonly'), '');
  assert.equal(input.disabled, true);
  assert.equal((h('details', { open: true }) as any).open, true);
  assert.equal((h('button', { hidden: true }) as any).hidden, true);
  assert.equal((h('input', { readonly: false }) as any).hasAttribute('readonly'), false, 'false is left out');
});

test('포트 규칙: the key of a rule being edited is read-only; the form for a new rule is not', async () => {
  doc.body.append(make(doc, 'div', { id: 'rulesBody' }));
  const view = { rules: [{ key: '3000-3010', kind: 'range', rule: { label: 'web' } }], exact: [], problems: [] };
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => view });
  // @ts-expect-error plain browser module, no types
  await import('../public/features/port-rules.js');
  for (let i = 0; i < 100 && !doc.getElementById('prKey'); i++) await new Promise((r) => setImmediate(r));
  const key = () => doc.getElementById('prKey')!;
  assert.ok(key(), 'the form is painted');
  assert.equal(key().hasAttribute('readonly'), false, 'a new rule: the key is typed in');

  const buttons = () => doc.querySelectorAll('button');
  buttons().find((b) => b.textContent === t('rules.edit'))!.click();
  assert.equal(key().getAttribute('readonly'), '', 'editing 3000-3010: the key cannot change');

  buttons().find((b) => b.textContent === t('rules.cancel'))!.click();
  assert.equal(key().hasAttribute('readonly'), false, 'back to a new rule');
});
