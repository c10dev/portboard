// 설정 체크리스트 (GET /api/onboarding): a header chip "설정 7/9" on the 서비스 page, hidden once everything is ok. It
// links to the 설정 tab, whose 시작하기 section (settings-start.js) lists what is left with each next step.
// Self-contained: the page only loads this script; the chip goes in the shell's sidebar footer (lib/shell.js #shellFoot),
// or a header .controls on a page without the shell.

import { tryJSON } from '../lib/api.js';
import { $, el } from '../lib/dom.js';

async function refresh() {
  // the page works without it
  const list = await tryJSON('/api/onboarding');
  const a = $('obChip');
  if (!list || !a) return;
  const left = list.total - list.ok;
  a.hidden = left === 0;
  a.classList.toggle('warn', list.items.some((i) => i.status === 'warn'));
  $('obText').textContent = list.summary;
  a.title = `설정 탭에서 보기 · 남은 것 ${left}개: ${list.items.filter((i) => i.status !== 'ok').map((i) => i.title).join(', ')}`;
}

function init() {
  // the shell's sidebar footer carries the chip already (src/core/shell.ts); a page without the shell gets one
  if ($('obChip')) {
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60_000);
    return;
  }
  const controls = $('shellFoot') ?? document.querySelector('header.top .controls');
  if (!controls) return;
  const a = el('a', 'btn ob-chip');
  a.id = 'obChip';
  a.href = 'settings.html#start';
  a.hidden = true;
  a.setAttribute('aria-label', '설정 체크리스트 (설정 탭)');
  a.append(el('span', 'ob-icon', '☑'), el('span', 'ob-text'));
  a.lastElementChild.id = 'obText';
  const before = $('swChip') ?? $('alertsBtn');
  if (before?.parentElement === controls) controls.insertBefore(a, before);
  else if (controls.id === 'shellFoot') controls.prepend(a);
  else controls.insertBefore(a, controls.lastElementChild);
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60_000);
}

init();
