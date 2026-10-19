// 최근 기록 (#30): a folded list at the bottom of the dashboard — the last writes (allowed or denied) from the
// dashboard, the plugin hooks and the MCP server. Read when opened, and again on every open.

import { tryJSON } from '../lib/api.js';
import { auditRow } from '../lib/audit.js';
import { el } from '../lib/dom.js';

const LIMIT = 15;

function mount() {
  const main = document.querySelector('main');
  if (!main || document.getElementById('auditRecent')) return;
  const box = el('details', 'audit-recent');
  box.id = 'auditRecent';
  const sum = el('summary', null, '최근 기록');
  const ul = el('ul', 'audit-list');
  const note = el('p', 'muted small', '포트 하나의 기록은 서비스 상세 페이지의 ‘기록’에 있어요.');
  box.append(sum, ul, note);
  box.addEventListener('toggle', async () => {
    if (!box.open) return;
    const doc = await tryJSON(`/api/audit?limit=${LIMIT}`);
    if (!doc) return ul.replaceChildren(el('li', 'muted', '기록을 불러오지 못했어요.'));
    if (!doc.entries.length) return ul.replaceChildren(el('li', 'muted', '아직 변경 기록이 없어요.'));
    ul.replaceChildren(...doc.entries.map((e) => {
      const li = auditRow(e);
      if (e.target?.port) li.querySelector('.audit-target')?.replaceChildren(Object.assign(el('a', null, li.querySelector('.audit-target').textContent), { href: `service.html#${e.target.port}` }));
      return li;
    }));
  });
  main.append(box);
}

mount();
