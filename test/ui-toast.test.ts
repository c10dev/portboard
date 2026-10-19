// The toast stack (public/lib/toast.js), undo for reversible prefs changes (public/features/undo.js, alerts.js) and the
// ⋯ menu's order (public/lib/menu.js), on the fake DOM with mocked timers.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument, FakeElement, make } from './fixtures/fake-dom.ts';
import { createToasts, lifetime, MAX_TOASTS, mergeKey, MIN_MS, toast } from '../public/lib/toast.js';
import { offerUndo, prefsUndo } from '../public/features/undo.js';
import { menuOrder, moreMenu, openMenuAt } from '../public/lib/menu.js';

// lib/dom.js builds with the global document (extLink, moreMenu), so the page's #toast lives there
const doc = new FakeDocument();
(globalThis as any).document = doc;
doc.body.append(make(doc, 'div', { id: 'toast', class: 'toast', role: 'status', hidden: '' }));

function stack() {
  const root = make(doc, 'div');
  return { root, s: createToasts(root as any) };
}
const texts = (s: any) => s.items.map((it: any) => it.node.querySelector('.toast-text').textContent);
const button = (node: FakeElement, cls: string) => node.querySelector(`button.${cls}`)!;

function withTimers(fn: () => void | Promise<void>) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try { await fn(); } finally { mock.timers.reset(); }
  };
}

test('lifetime: never under 6 s; 20 s with a link, 7 s for an error; an action toast stays until closed', () => {
  assert.equal(MIN_MS, 6000);
  assert.equal(lifetime({}), 6000);
  assert.equal(lifetime({ ms: 2500 }), 6000, 'callers asking for less get 6 s');
  assert.equal(lifetime({ ms: 3500, error: true }), 6000);
  assert.equal(lifetime({ error: true }), 7000);
  assert.equal(lifetime({ link: 'https://x' }), 20000);
  assert.equal(lifetime({ ms: 9000 }), 9000);
  assert.equal(lifetime({ action: { label: '되돌리기', onClick() {} } }), null);
  assert.equal(lifetime({ action: { label: '되돌리기', onClick() {} }, ms: 6000 }), null, 'an action wins over ms');
});

test('mergeKey: the text (and error) by default, the given key first; action toasts only merge with a key', () => {
  assert.equal(mergeKey('a'), mergeKey('a'));
  assert.notEqual(mergeKey('a'), mergeKey('a', { error: true }));
  assert.equal(mergeKey('a', { key: 'k' }), mergeKey('b', { key: 'k' }));
  assert.equal(mergeKey('a', { action: { label: 'x', onClick() {} } }), null);
});

test('the stack: role=status, polite, not atomic; never hidden (an empty stack is just empty)', () => {
  const { root, s } = stack();
  assert.equal(root.className, 'toast-stack');
  assert.equal(root.getAttribute('role'), 'status');
  assert.equal(root.getAttribute('aria-live'), 'polite');
  assert.equal(root.getAttribute('aria-atomic'), 'false');
  assert.equal(root.hidden, false, 'unhidden before the first toast goes in, so it is announced');
  s.show('저장했어요');
  assert.equal(root.children.length, 1);
  s.clear();
  assert.equal(root.hidden, false);
  assert.equal(root.children.length, 0);
});

test('repeats merge into the live toast as "(×N)" and restart its time; after it closes the count starts over', withTimers(() => {
  const { root, s } = stack();
  s.show('복사했어요');
  s.show('복사했어요');
  mock.timers.tick(5000);
  s.show('복사했어요');
  assert.equal(root.children.length, 1);
  assert.deepEqual(texts(s), ['복사했어요 (×3)']);
  assert.equal(s.items[0].count, 3);
  mock.timers.tick(5999);
  assert.equal(s.items.length, 1, 'the third showing restarted the 6 s');
  mock.timers.tick(1);
  assert.equal(s.items.length, 0);
  s.show('복사했어요');
  assert.deepEqual(texts(s), ['복사했어요']);
  // an error with the same text is a different toast
  s.show('복사했어요', { error: true });
  assert.equal(s.items.length, 2);
  assert.ok(s.items[0].node.classList.contains('error'));
}));

test('a toast stays at least 6 s, an error 7 s; an action toast stays until it is used or closed', withTimers(async () => {
  const { s } = stack();
  s.show('짧게', { ms: 3000 });
  s.show('오류', { error: true });
  let used = 0;
  s.show('8790 고정을 풀었어요', { action: { label: '되돌리기', onClick: () => { used++; } } });
  mock.timers.tick(5999);
  assert.equal(s.items.length, 3);
  mock.timers.tick(1);
  assert.deepEqual(texts(s), ['8790 고정을 풀었어요', '오류']);
  mock.timers.tick(1000);
  assert.deepEqual(texts(s), ['8790 고정을 풀었어요']);
  mock.timers.tick(60 * 60 * 1000);
  assert.deepEqual(texts(s), ['8790 고정을 풀었어요'], 'still there an hour later');
  assert.equal(s.items[0].timed, false);
  const action = button(s.items[0].node, 'toast-action');
  assert.equal(action.textContent, '되돌리기');
  action.click();
  assert.equal(used, 1);
  assert.equal(s.items.length, 0, 'using it closes it');
  // × closes any toast
  s.show('닫아 보기', { action: { label: '되돌리기', onClick: () => { used++; } } });
  button(s.items[0].node, 'toast-close').click();
  assert.equal(s.items.length, 0);
  assert.equal(used, 1, 'closing does not run the action');
}));

test('only the front toast shows: the newest is depth 0, the rest are behind (inert); moving one to the front keeps the DOM', withTimers(() => {
  const { root, s } = stack();
  s.show('하나');
  s.show('둘');
  s.show('셋');
  assert.deepEqual(texts(s), ['셋', '둘', '하나']);
  assert.deepEqual(s.items.map((it: any) => [it.node.dataset.depth, it.node.inert]), [['0', false], ['1', true], ['2', true]]);
  const order = [...root.children];
  s.show('하나');
  assert.deepEqual(texts(s), ['하나 (×2)', '셋', '둘'], 'a repeat comes to the front');
  assert.deepEqual([...root.children], order, 'no node moved (so nothing is announced twice)');
  assert.equal(s.items[0].node.inert, false);
  // the oldest goes once there are more than MAX_TOASTS
  for (let i = 0; i < MAX_TOASTS + 2; i++) s.show(`t${i}`);
  assert.equal(s.items.length, MAX_TOASTS);
  assert.equal(root.children.length, MAX_TOASTS);
  assert.equal(texts(s)[0], `t${MAX_TOASTS + 1}`);
}));

test('toast(): the old (text, error, { link, ms }) call and the options form both work, on the page #toast', withTimers(() => {
  const root = doc.getElementById('toast')!;
  assert.equal(root.hidden, true, 'the page serves #toast hidden');
  toast('저장했어요');
  assert.equal(root.className, 'toast-stack');
  assert.equal(root.hidden, false);
  toast('Serve가 꺼져 있어요', true, { link: 'https://login.tailscale.com/x' });
  const front = root.children.find((n) => n.dataset.depth === '0')!;
  assert.ok(front.classList.contains('error'));
  assert.equal(front.querySelector('a')!.getAttribute('href'), 'https://login.tailscale.com/x');
  assert.match(front.textContent, /Serve가 꺼져 있어요 설정 열기/);
  let undone = false;
  const h = toast({ text: '숨겼어요', action: { label: '되돌리기', onClick: () => { undone = true; } } });
  const top = root.children.find((n) => n.dataset.depth === '0')!;
  assert.match(top.textContent, /^숨겼어요/);
  top.querySelector('button.toast-action')!.click();
  assert.equal(undone, true);
  h.close();
  mock.timers.tick(20000);
  assert.equal(root.children.length, 0);
}));

test('prefsUndo: unpin, hide, clearing (or changing) a label and alert off get an undo; adding things does not', () => {
  const p = { port: 8790, label: 'portboard', pinned: true, hidden: false, alert: true };
  assert.deepEqual(prefsUndo(p, { pinned: false }), { text: '8790 고정을 풀었어요', prev: { pinned: true } });
  assert.deepEqual(prefsUndo(p, { hidden: true }), { text: '8790 숨겼어요', prev: { hidden: false } });
  assert.deepEqual(prefsUndo(p, { alert: false }), { text: '8790 다운 알림을 껐어요', prev: { alert: true } });
  assert.deepEqual(prefsUndo(p, { label: '' }), { text: '8790 이름 "portboard"을(를) 지웠어요', prev: { label: 'portboard' } });
  assert.deepEqual(prefsUndo(p, { label: '   ' })?.prev, { label: 'portboard' }, 'whitespace clears too');
  assert.deepEqual(prefsUndo(p, { label: null })?.prev, { label: 'portboard' });
  assert.deepEqual(prefsUndo(p, { label: 'pb' })?.prev, { label: 'portboard' });
  // nothing taken away: no undo
  const bare = { port: 3000, label: null, pinned: false, hidden: true, alert: false };
  assert.equal(prefsUndo(bare, { pinned: true }), null);
  assert.equal(prefsUndo(bare, { hidden: false }), null);
  assert.equal(prefsUndo(bare, { alert: true }), null);
  assert.equal(prefsUndo(bare, { label: 'web' }), null, 'a first label');
  assert.equal(prefsUndo(p, { label: 'portboard' }), null, 'the same label');
  assert.equal(prefsUndo(bare, { pinned: false }), null, 'already unpinned');
  assert.equal(prefsUndo(null, { pinned: false }), null);
  // every field of the patch comes back as it was, nothing else
  assert.deepEqual(prefsUndo(p, { pinned: false, label: '' })?.prev, { pinned: true, label: 'portboard' });
  assert.deepEqual(prefsUndo({ ...p, label: null }, { hidden: true, label: '' })?.prev, { hidden: false, label: null });
});

test('offerUndo: 되돌리기 re-posts the previous prefs exactly once, then says 되돌렸어요; repeats merge by port and field', withTimers(async () => {
  const { s } = stack();
  const show = (text: string, error: boolean, opts: any) => s.show(text, { ...opts, error });
  const posted: any[] = [];
  const repost = async (prev: any) => { posted.push(prev); return true; };
  const before = { port: 8790, label: 'portboard', pinned: true, hidden: false, alert: true };
  offerUndo(8790, prefsUndo(before, { label: '' }), repost, show);
  offerUndo(8790, prefsUndo(before, { pinned: false }), repost, show);
  offerUndo(8790, prefsUndo(before, { pinned: false }), repost, show);
  assert.deepEqual(texts(s), ['8790 고정을 풀었어요 (×2)', '8790 이름 "portboard"을(를) 지웠어요']);
  button(s.items[0].node, 'toast-action').click();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(posted, [{ pinned: true }]);
  assert.deepEqual(texts(s), ['되돌렸어요', '8790 이름 "portboard"을(를) 지웠어요']);
  button(s.items[1].node, 'toast-action').click();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(posted, [{ pinned: true }, { label: 'portboard' }]);
  // a failed re-post says its own error (repost does) and no 되돌렸어요
  offerUndo(3000, { text: '3000 숨겼어요', prev: { hidden: false } }, async () => false, show);
  s.clear();
  offerUndo(3000, { text: '3000 숨겼어요', prev: { hidden: false } }, async () => false, show);
  button(s.items[0].node, 'toast-action').click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(s.items.length, 0);
  assert.equal(offerUndo(1, null, repost, show), null);
}));

test('alerts.js: turning a port alert off posts {alert:false} with 되돌리기, which posts {alert:true} back', withTimers(async () => {
  const calls: { url: string; body: unknown }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(init?.method === 'POST' ? '{}' : 'null', { status: init?.method === 'POST' ? 200 : 404 });
  }) as typeof fetch;
  try {
    const { setPortAlert } = await import('../public/features/alerts.js');
    const root = doc.getElementById('toast')!;
    assert.equal((await setPortAlert(5173, false)).ok, true, 'the answer, as lib/api.js post (the palette reads r.ok)');
    const front = root.children.find((n) => n.dataset.depth === '0')!;
    assert.match(front.textContent, /^5173 다운 알림을 껐어요/);
    front.querySelector('button.toast-action')!.click();
    for (let i = 0; i < 20 && calls.length < 2; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [
      { url: '/api/ports/5173/prefs', body: { alert: false } },
      { url: '/api/ports/5173/prefs', body: { alert: true } },
    ]);
    // turning it on offers nothing to undo
    await setPortAlert(5173, true);
    assert.ok(!root.children.some((c) => /다운 알림을 껐어요/.test(c.textContent)), 'the used one is gone and none came');
  } finally {
    globalThis.fetch = real;
  }
}));

test('menuOrder / moreMenu: destructive items last, after a separator; openMenuAt opens one and closes the others', () => {
  const items = [
    { label: '중지', onClick() {}, danger: true },
    { label: '이름 바꾸기', onClick() {} },
    { label: '재시작', onClick() {} },
  ];
  assert.deepEqual(menuOrder(items).map((it: any) => it?.label ?? '—'), ['이름 바꾸기', '재시작', '—', '중지']);
  assert.deepEqual(menuOrder(items.slice(1)).map((it: any) => it.label), ['이름 바꾸기', '재시작'], 'no separator without danger');
  assert.deepEqual(menuOrder(items.slice(0, 1)).map((it: any) => it.label), ['중지'], 'or with only danger');
  const a = moreMenu({ ariaLabel: '8790 더 보기', items }) as any;
  const panel = a.querySelector('.menu-panel');
  assert.deepEqual(panel.children.map((c: any) => (c.className === 'menu-sep' ? '—' : c.textContent)), ['이름 바꾸기', '재시작', '—', '중지']);
  assert.equal(panel.children[2].getAttribute('role'), 'separator');
  assert.ok(panel.children[3].classList.contains('danger'));
  const b = moreMenu({ ariaLabel: '3000 더 보기', items }) as any;
  doc.body.append(a, b);
  assert.equal(openMenuAt(a), true);
  assert.equal(a.open, true);
  assert.equal(openMenuAt(b), true);
  assert.deepEqual([a.open, b.open], [false, true]);
  assert.equal(openMenuAt(null), false);
  // a press outside closes it, one inside does not
  for (const fn of doc.listeners.get('pointerdown') ?? []) fn({ target: b.querySelector('summary') });
  assert.equal(b.open, true);
  for (const fn of doc.listeners.get('pointerdown') ?? []) fn({ target: doc.body });
  assert.equal(b.open, false);
});
