// Owners and cleanup (c10dev/portboard#25, #26): an owner badge on each dev-server row (Claude session, worktree@branch)
// and a banner listing leftover servers with one "정리" button. Self-contained: it decorates the rows app.js renders
// (matched by their .port text) and re-applies after every re-render.

import { post, tryJSON } from '../lib/api.js';
import { el } from '../lib/dom.js';
import { done } from '../lib/shell.js';

let doc = null;
let busy = false;
/** GET /api/claude/sessions (#43): the SessionEnd auto-stop setting */
let claude = null;

const AUTO_STOP = [
  ['off', '자동 중지 안 함 (기본)'],
  ['scratchpad', 'scratchpad·임시 유닛만 자동 중지'],
  ['all', '그 세션의 서버 모두 자동 중지'],
];

/** "Claude 세션 'x'이 끝났어요" for the sessions whose SessionEnd hook made candidates */
function endedLine(cands) {
  const names = [...new Set(cands.filter((c) => c.reasons.includes('session-ended-hook')).map((c) => c.owner.session.title ?? c.owner.session.id.slice(0, 8)))];
  if (!names.length) return null;
  return el('p', 'owners-ended', `Claude 세션 ${names.map((n) => `‘${n}’`).join(', ')}이 끝났어요 — 그 세션이 띄운 서버예요.`);
}

function autoStopMenu() {
  const current = claude?.settings?.autoStop ?? 'off';
  const menu = el('details', 'menu');
  const sum = el('summary', null, '⋯');
  sum.dataset.write = '1';
  sum.title = '세션 종료 시 자동 정리';
  const panel = el('div', 'menu-panel');
  panel.append(el('span', 'muted', 'Claude 세션이 끝나면 (SessionEnd 훅)'));
  for (const [mode, label] of AUTO_STOP) {
    const b = el('button', null, `${mode === current ? '✓ ' : ''}${label}`);
    b.type = 'button';
    b.addEventListener('click', async () => {
      const r = await post('/api/claude/settings', { autoStop: mode });
      if (r.ok) claude = { ...claude, settings: r.body.settings };
      banner();
    });
    panel.append(b);
  }
  menu.append(sum, panel);
  return menu;
}

function ownerLabel(o) {
  const parts = [];
  if (o.session) parts.push(`세션: ${o.session.title ?? o.session.id.slice(0, 8)}${o.session.alive ? '' : ' (끝남)'}`);
  if (o.worktree) parts.push(`${o.worktree.repoName}@${o.worktree.branch ?? '?'}${o.worktree.merged ? ' (머지됨)' : ''}`);
  if (o.scratchpad && !o.session) parts.push('scratchpad');
  if (o.cwdGone) parts.push('폴더 없음');
  return parts.join(' · ');
}

function decorate() {
  if (!doc) return;
  const byPort = new Map(doc.ports.map((p) => [String(p.port), p]));
  // the rows, and the 서비스 inspector (features/port-inspector.js): its head looks like a row, .insp-owner gets facts
  for (const li of document.querySelectorAll('#list li.row, #inspBody .insp-port')) {
    const port = li.querySelector('.port')?.textContent?.trim();
    const row = port && byPort.get(port);
    const badges = li.querySelector('.badges');
    if (!badges) continue;
    badges.querySelectorAll('.owner-badge').forEach((b) => b.remove());
    const facts = li.classList.contains('insp-port') ? document.querySelector('#inspBody .insp-owner') : null;
    facts?.replaceChildren();
    if (!row) continue;
    const label = ownerLabel(row.owner);
    if (!label) continue;
    if (facts) {
      const o = row.owner;
      const add = (k, v) => { if (v) facts.append(el('dt', null, k), el('dd', null, v)); };
      add('세션', o.session && `${o.session.title ?? o.session.id.slice(0, 8)}${o.session.alive ? '' : ' (끝남)'}`);
      add('워크트리', o.worktree && `${o.worktree.repoName}@${o.worktree.branch ?? '?'}${o.worktree.merged ? ' (머지됨)' : ''} · ${o.worktree.path}`);
      add('정리 후보', row.reasons.length ? row.reasonText.join(', ') : null);
    }
    const b = el('span', `badge owner-badge${row.reasons.length ? ' warn' : ''}`, label);
    b.title = row.reasons.length ? `정리 후보: ${row.reasonText.join(', ')}` : `pid ${row.pid}${row.unit ? ` · ${row.unit} (systemd-run)` : ''}${row.owner.worktree ? ` · ${row.owner.worktree.path}` : ''}`;
    badges.append(b);
  }
}

function banner() {
  let box = document.getElementById('ownersBanner');
  const list = document.getElementById('list');
  if (!list) return;
  if (!box) {
    box = el('section', 'owners-banner');
    box.id = 'ownersBanner';
    list.parentElement.insertBefore(box, list);
  }
  const cands = doc ? doc.ports.filter((p) => p.reasons.length) : [];
  box.hidden = cands.length === 0;
  if (!cands.length) return;
  box.replaceChildren();
  const head = el('div', 'owners-head');
  head.append(el('strong', null, `정리할 수 있는 서버 ${cands.length}개`));
  const btn = el('button', 'btn', busy ? '정리 중…' : '모두 정리');
  btn.dataset.write = '1';
  btn.type = 'button';
  btn.disabled = busy;
  btn.addEventListener('click', () => cleanup(cands));
  const actions = el('div', 'owners-actions');
  actions.append(btn, autoStopMenu());
  head.append(actions);
  const ul = el('ul', 'owners-list');
  for (const c of cands) {
    const li = el('li');
    li.append(el('code', null, `:${c.port}`), ' ', el('span', null, c.name), ' — ', el('span', 'muted', `${c.reasonText.join(', ')} · ${ownerLabel(c.owner)}`));
    ul.append(li);
  }
  box.append(head, ...[endedLine(cands)].filter(Boolean), ul, el('p', 'muted', '정리는 프로세스에 SIGTERM을, systemd-run으로 띄운 임시 유닛은 stop을 보내요. 설치된 systemd 서비스·docker·고정한 포트는 후보에 넣지 않아요.'));
}

async function cleanup(cands) {
  const lines = cands.map((c) => `:${c.port} ${c.name} — ${c.reasonText.join(', ')}`).join('\n');
  if (!window.confirm(`이 서버들을 중지할까요?\n\n${lines}`)) return;
  busy = true;
  banner();
  try {
    const { body } = await post('/api/cleanup', { ports: cands.map((c) => c.port) });
    const failed = (body.results ?? []).filter((r) => !r.ok);
    window.alert(failed.length ? `일부 실패:\n${failed.map((r) => `:${r.port} ${r.message}`).join('\n')}` : `${cands.length}개 정리했어요.`);
  } finally {
    busy = false;
    await load();
    document.getElementById('refresh')?.click();
  }
}

async function load() {
  // the dashboard works without it
  [doc, claude] = await Promise.all([tryJSON('/api/owners').then((d) => d ?? doc), tryJSON('/api/claude/sessions').then((c) => c ?? claude)]);
  banner();
  decorate();
  // the banner is in place: the 서비스 list may show without it pushing the rows down later
  done('owners');
}

for (const id of ['list', 'inspBody']) {
  const box = document.getElementById(id);
  if (box) new MutationObserver(() => decorate()).observe(box, { childList: true });
}
load();
setInterval(() => { if (!document.hidden) load(); }, 30_000);
