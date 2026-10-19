// The web side of port rules and new-port notices: the inspector's 규칙 rows (which rules matched, in precedence order,
// and where the name and the notice came from), the 설정 section markup, and the toast's actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain browser module, no types
import { ruleFacts, sourceText } from '../public/features/port-rules.js';
// @ts-expect-error plain browser module, no types
import { noticeActions, noticeText } from '../public/features/newports.js';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('ruleFacts: matched rules in order, then where the name and the new-port notice came from; nothing for an old server', () => {
  const p = {
    label: '스크래치패드 미리보기', onNew: 'notify', pinned: true, hidden: false,
    rules: { matched: ['18891-18899', 'vite|next dev'], from: { label: 'rule:18891-18899', onNew: 'rule:vite|next dev', pinned: 'port', hidden: 'default' } },
  };
  assert.deepEqual(ruleFacts(p), [
    ['맞는 규칙', '18891-18899 → vite|next dev (앞이 우선)'],
    ['이름', '스크래치패드 미리보기 · 규칙 18891-18899'],
    ['새 포트', '알림 (토스트 + 푸시) · 규칙 vite|next dev'],
    ['고정', '예 · 이 포트의 항목'],
  ]);
  const plain = { label: null, onNew: 'silent', pinned: false, hidden: false, rules: { matched: [], from: { label: 'default', onNew: 'default', pinned: 'default', hidden: 'default' } } };
  assert.deepEqual(ruleFacts(plain), [['맞는 규칙', '없음'], ['새 포트', '조용히 · 기본값']]);
  assert.deepEqual(ruleFacts({ label: null }), []);
  assert.equal(sourceText('otherPorts'), '나머지 포트');
});

test('설정: the 포트 규칙 section of the modal (with write controls) and its menu item; the inspector links to it', () => {
  const modal = read('public/features/settings-modal.js');
  assert.match(modal, /id: 'port-rules', write: true, body: 'rulesBody', script: 'port-rules\.js'/);
  assert.match(read('public/lib/settings-route.js'), /'port-rules': '포트 규칙'/);
  assert.match(read('public/features/port-inspector.js'), /settings\.html#port-rules/);
});

test('notice toast: text, 열기 always, tailnet 공개 only for a notify that has no URL yet and can be published', () => {
  const e = { id: 1, port: 5173, name: 'Vite', project: 'myapp', action: 'notify', open: null, canExpose: true };
  assert.equal(noticeText(e), '새 서버 :5173 Vite (myapp)');
  assert.deepEqual(noticeActions(e).map((a: any) => a.label), ['열기', 'tailnet 공개']);
  assert.deepEqual(noticeActions({ ...e, open: 'https://h:5173' }).map((a: any) => a.label), ['열기']);
  assert.deepEqual(noticeActions({ ...e, action: 'openBrowserOnce' }).map((a: any) => a.label), ['열기']);
  assert.deepEqual(noticeActions({ ...e, canExpose: false }).map((a: any) => a.label), ['열기']);
  // the toast is the shared one: this module never edits lib/toast.js
  assert.match(read('public/features/newports.js'), /import \{ toast \} from '\.\.\/lib\/toast\.js'/);
});
