// 설정 tab · 시작하기: the setup checklist (GET /api/onboarding, src/core/onboarding.ts) — what is left first, each with
// its next step (a command to copy, or a link), then what is done. The 서비스 tab's "설정 n/m" chip links here.

import { tryJSON } from '../lib/api.js';
import { $, button, el, extLink, h } from '../lib/dom.js';
import { copy } from '../lib/toast.js';

const TONE = { ok: 'ok', warn: 'warn', missing: 'todo' };
const LABEL = { ok: '완료', warn: '확인 필요', missing: '설정 전' };

/** A dashboard page (settings.html#remote) opens here; a doc in a new tab. */
const linkTo = (label, href) => (/^https?:/.test(href) ? extLink(`${label} ↗`, href) : h('a', { href }, `${label} →`));

function action(a) {
  if (!a) return null;
  if (a.kind === 'link') return linkTo(a.label, a.href);
  return h('span', { class: 'set-row' }, a.label ? h('span', null, `${a.label}:`) : null, h('code', { class: 'set-cmd' }, a.text), button('복사', () => copy(a.text), { title: '명령 복사' }));
}

function row(i) {
  return h(
    'li',
    { dataset: { key: i.key } },
    el('span', `dot ${TONE[i.status]}`),
    h('strong', null, i.title),
    h('span', { class: `set-state ${TONE[i.status]}` }, LABEL[i.status]),
    h('p', { class: 'set-detail' }, i.detail),
    i.action || i.links?.length ? h('div', { class: 'set-extra' }, action(i.action), (i.links ?? []).map((l) => linkTo(l.label, l.href))) : null,
  );
}

async function refresh() {
  const box = $('startBody');
  if (!box) return;
  const list = await tryJSON('/api/onboarding');
  if (!list) {
    box.replaceChildren(el('p', 'set-note', '설정 체크리스트를 읽지 못했어요.'));
    return;
  }
  const todo = list.items.filter((i) => i.status !== 'ok');
  const done = list.items.filter((i) => i.status === 'ok');
  // replaceChildren() would print a null as text: leave the empty parts out
  box.replaceChildren(
    ...[
      h('p', { class: 'set-note' }, todo.length ? `${list.total}개 중 ${list.ok}개 완료 · 남은 것 ${todo.length}개` : `${list.total}개 모두 설정됐어요.`),
      todo.length ? h('ul', { class: 'set-list', 'aria-label': '남은 것' }, todo.map(row)) : null,
      done.length ? h('details', { open: !todo.length }, h('summary', { class: 'set-note' }, `된 것 ${done.length}개`), h('ul', { class: 'set-list', 'aria-label': '된 것' }, done.map(row))) : null,
      h('p', { class: 'set-note' }, '비밀값(토큰, ntfy 토픽, 키)은 여기 나오지 않아요. 상태는 설정 파일과 데이터 수집 상태에서 읽어요.'),
    ].filter(Boolean),
  );
}

/** Fill the section once its container is there: now, or when the 설정 modal has built it (settings:mount) */
function mount() {
  const body = $('startBody');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  refresh();
  document.addEventListener('settings:refresh', refresh);
}

mount();
document.addEventListener('settings:mount', mount);
