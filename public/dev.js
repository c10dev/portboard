// 개발 tab (c10dev/portboard#36): git worktrees of every repo under ~/projects, which can safely go, and batch removal
// (`git worktree remove`, never forced; branches kept). The scan runs in the background on the server.

import { done } from './lib/shell.js'; // first: the bar, sidebar and inspector are wired before anything looks them up
import { errorText, post, readJSON } from './lib/api.js';
import { badge } from './lib/badge.js';
import { initCommandPalette } from './features/palette.js';
import { $, el } from './lib/dom.js';
import { whyEmpty } from './lib/empty.js';
import { kib as mb } from './lib/format.js';
import { agoDays as ago } from './lib/time.js';
import { toast as show } from './lib/toast.js';
import { showAccess } from './lib/access.js';
import { isSettingsHash } from './lib/settings-route.js';

let doc = null;
let devDoc = { running: [], startable: {} };
const selected = new Map(); // repo path → Set(worktree path)
let onlyRemovable = false;
try { onlyRemovable = localStorage.getItem('pb.dev.onlyRemovable') === '1'; } catch {}
$('onlyRemovable').checked = onlyRemovable;

const toast = (text, error = false) => show(text, error, { ms: error ? 8000 : 3500 });

function row(repo, w) {
  const li = el('li', `wt-row${w.removable ? '' : ' keep'}`);
  li.dataset.path = w.path;
  const cb = el('input');
  cb.type = 'checkbox';
  cb.disabled = !w.removable;
  cb.checked = selected.get(repo.path)?.has(w.path) ?? false;
  cb.addEventListener('change', () => {
    const set = selected.get(repo.path) ?? new Set();
    cb.checked ? set.add(w.path) : set.delete(w.path);
    selected.set(repo.path, set);
    render();
  });
  const main = el('div');
  main.append(el('div', 'br', w.branch ?? (w.detached ? '(분리된 HEAD)' : '?')), el('div', 'path', w.short));
  const tags = el('div', 'tags');
  if (w.pr) tags.append(badge(`PR #${w.pr.number} ${w.pr.state === 'MERGED' ? '머지됨' : w.pr.state === 'OPEN' ? '열림' : '닫힘'}`, w.pr.state === 'MERGED' ? 'ok' : w.pr.state === 'OPEN' ? 'info' : ''));
  else if (w.mergedByAncestry) tags.append(badge('머지됨', 'ok'));
  if (w.changes) tags.append(badge(`변경 ${w.changes}`, 'warn'));
  if (w.inUse.length) tags.append(badge(`사용 중 ${w.inUse.length}`, 'warn'));
  if (w.locked) tags.append(badge('잠김', 'warn'));
  if (w.main) tags.append(badge('메인 체크아웃', 'info'));
  else if (!w.removable && w.keep.length) tags.append(badge(`남김: ${w.keep.join(', ')}`));
  if (w.removable) tags.append(badge('지울 수 있음', 'ok'));
  main.append(tags);
  const side = el('div', 'side', [ago(w.lastCommit), mb(w.sizeKb)].filter(Boolean).join(' · '));
  side.append(devControls(w.path));
  li.append(cb, main, side);
  return li;
}

// ---- dev servers (#28) ----
function devControls(path) {
  const box = el('div', 'dev-ctl');
  const running = devDoc.running.find((r) => r.path === path && r.active);
  const startable = devDoc.startable[path];
  if (running) {
    const a = el('a', 'badge ok', `실행 중 :${running.port ?? '?'}`);
    if (running.port) a.href = `service.html#${running.port}`;
    a.title = running.description;
    const stop = el('button', null, '■ 중지');
    stop.dataset.write = '1';
    stop.type = 'button';
    stop.addEventListener('click', () => devAction('stop', path, `${running.description}\n중지할까요? (예약한 포트는 남아요)`));
    box.append(a, stop);
  } else if (startable) {
    const go = el('button', null, `▶ ${startable.preferred}`);
    go.dataset.write = '1';
    go.type = 'button';
    go.title = `npm run ${startable.preferred} — ${startable.scripts[startable.preferred]}`;
    go.addEventListener('click', () => devAction('start', path, null));
    box.append(go);
  }
  return box;
}

async function devAction(kind, path, confirmText) {
  if (confirmText && !window.confirm(confirmText)) return;
  const r = await post(`/api/dev-servers/${kind}`, { path });
  toast(r.body.message ?? `HTTP ${r.status}`, !r.ok);
  await loadDev();
  render();
  loadResv();
}

async function loadDev() {
  try { devDoc = await readJSON('/api/dev-servers'); } catch {}
}

async function removeSelected(repo) {
  const paths = [...(selected.get(repo.path) ?? [])];
  if (!paths.length) return;
  const list = paths.map((p) => repo.worktrees.find((w) => w.path === p)).filter(Boolean).map((w) => `• ${w.branch ?? w.short}`).join('\n');
  if (!window.confirm(`${repo.name}의 워크트리 ${paths.length}개를 지울까요?\n(git worktree remove — 폴더가 지워지고 브랜치는 남아요)\n\n${list}`)) return;
  try {
    const { body } = await post('/api/worktrees/remove', { repo: repo.path, paths });
    const failed = (body.results ?? []).filter((r) => !r.ok);
    selected.delete(repo.path);
    toast(failed.length ? `${paths.length - failed.length}개 지움, ${failed.length}개 실패: ${failed.map((f) => f.message).join(' / ')}` : `${paths.length}개 지웠어요`, failed.length > 0);
  } catch (err) {
    toast(String(err), true);
  }
  // The server queued a scan after the removal (fresh): wait for it, no forced full scan per batch
  load();
}

async function prune(repo) {
  const r = await post('/api/worktrees/prune', { repo: repo.path });
  toast(r.body.message ?? `HTTP ${r.status}`, !r.ok);
  load();
}

function render() {
  if (!doc) return;
  const t = doc.totals;
  $('headline').textContent = doc.at ? `저장소 ${t.repos}개 · 워크트리 ${t.worktrees}개 · 지울 수 있음 ${t.removable}개${t.removableKb ? ` (${mb(t.removableKb)})` : ''}` : '검사 중…';
  $('status').textContent = doc.scanning ? '다시 검사하는 중…' : doc.at ? `${new Date(doc.at).toLocaleTimeString()} 검사 · ${Math.round((doc.tookMs ?? 0) / 100) / 10}초` : '';
  const box = $('repos');
  box.replaceChildren();
  for (const repo of [...doc.repos].sort((a, b) => b.worktrees.filter((w) => w.removable).length - a.worktrees.filter((w) => w.removable).length)) {
    // The main checkout is listed too (its dev server can be started here), but never selectable for removal.
    const wts = repo.worktrees.filter((w) => !onlyRemovable || w.removable);
    const removable = repo.worktrees.filter((w) => w.removable);
    const prunable = repo.worktrees.filter((w) => w.prunable);
    if (onlyRemovable && !removable.length && !prunable.length) continue;
    const sec = el('section', 'wt-repo');
    const head = el('header');
    head.append(el('h3', null, repo.name), el('span', 'meta', `워크트리 ${repo.worktrees.length - 1}개 · 지울 수 있음 ${removable.length}개${repo.prsKnown ? '' : ' · PR 정보 없음'}`), el('span', 'spacer'));
    if (removable.length) {
      const all = el('button', null, '지울 수 있는 것 모두 선택');
      all.type = 'button';
      all.addEventListener('click', () => { selected.set(repo.path, new Set(removable.map((w) => w.path))); render(); });
      head.append(all);
    }
    const sel = selected.get(repo.path)?.size ?? 0;
    const rm = el('button', 'btn primary', `선택한 ${sel}개 지우기`);
    rm.dataset.write = '1';
    rm.type = 'button';
    rm.disabled = sel === 0;
    rm.addEventListener('click', () => removeSelected(repo));
    head.append(rm);
    if (prunable.length) {
      const pr = el('button', null, `사라진 ${prunable.length}개 기록 정리`);
      pr.dataset.write = '1';
      pr.type = 'button';
      pr.addEventListener('click', () => prune(repo));
      head.append(pr);
    }
    const ul = el('ul', 'wt-list');
    for (const w of wts) ul.append(row(repo, w));
    sec.append(head, ul);
    box.append(sec);
  }
  if (!box.children.length && doc.at) box.append(noRepos());
  // #settings/… is the 설정 modal over this page (features/settings-modal.js), not a worktree
  if (!hashUsed && location.hash.length > 1 && !isSettingsHash(location.hash) && box.children.length) {
    hashUsed = true;
    showWorktree(decodeURIComponent(location.hash.slice(1)));
  }
}

/** Nothing listed: no repos under the root, or the filter hides them all */
function noRepos() {
  if (doc.repos.length) {
    return whyEmpty(el('div'), {
      title: '지울 수 있는 워크트리가 없어요.',
      actions: [{ label: '전체 보기', onClick: () => { $('onlyRemovable').checked = false; $('onlyRemovable').dispatchEvent(new Event('change')); } }],
    });
  }
  return whyEmpty(el('div'), {
    title: '찾은 git 저장소가 없어요.',
    text: 'PORTBOARD_REPOS_ROOT(기본 ~/projects, 쉼표로 여러 개) 바로 아래의 git 저장소를 봐요. 바꾸려면 이 환경 변수를 설정하고 Portboard를 다시 시작해요.',
  });
}

let hashUsed = false;

/** dev.html#<path> and the palette: scroll to that worktree's row and flash it (turns the filter off if it hides it) */
function showWorktree(path) {
  let li = [...document.querySelectorAll('.wt-row')].find((n) => n.dataset.path === path);
  if (!li && onlyRemovable) {
    $('onlyRemovable').checked = false;
    $('onlyRemovable').dispatchEvent(new Event('change'));
    li = [...document.querySelectorAll('.wt-row')].find((n) => n.dataset.path === path);
  }
  if (!li) { toast('목록에 없는 워크트리예요', true); return; }
  li.scrollIntoView({ block: 'center' });
  li.classList.remove('flash');
  void li.offsetWidth;
  li.classList.add('flash');
}

async function load(rescan = false) {
  await loadDev();
  try {
    doc = await readJSON(`/api/worktrees${rescan ? '?refresh' : ''}`);
  } catch (err) {
    $('status').textContent = `불러오기 실패: ${err}`;
    done('page');
    return;
  }
  render();
  // the repos are there (or 검사 중…): the main column may show (shell.css [data-wait])
  done('page');
  // ?refresh is accepted once a minute (L1); a click sooner shows the running or last scan
  if (rescan && doc.refresh === 'throttled') toast('조금 전에 전체 검사를 했어요 — 마지막 결과예요 (1분에 한 번)');
  if (doc.scanning || !doc.at) setTimeout(() => load(), 2000);
}

// ---- port reservations (#27) ----
async function loadResv() {
  let list = [];
  try { list = (await readJSON('/api/reservations')).reservations ?? []; } catch {}
  const ul = $('resvList');
  ul.replaceChildren();
  if (!list.length) { ul.append(el('li', 'muted', '예약한 포트가 없어요.')); return; }
  for (const r of list) {
    const li = el('li');
    li.append(el('code', null, `:${r.port}`), el('strong', null, r.owner));
    if (r.note) li.append(el('span', 'muted', r.note));
    const l = r.listening;
    li.append(l ? badge(`사용 중: ${l.name}${l.project ? ` (${l.project})` : ''}`, l.matchesOwner === false ? 'warn' : 'ok') : badge('비어 있음'));
    if (l && l.matchesOwner === false) li.append(el('span', 'muted', '예약한 쪽이 아닌 프로세스가 쓰는 중'));
    li.append(el('span', 'spacer'));
    const rel = el('button', null, '예약 해제');
    rel.dataset.write = '1';
    rel.type = 'button';
    rel.addEventListener('click', async () => {
      if (!window.confirm(`:${r.port} (${r.owner}) 예약을 해제할까요? 실행 중인 서버는 그대로예요.`)) return;
      const res = await post(`/api/reservations/${r.port}/release`);
      toast(res.ok ? `:${r.port} 예약을 해제했어요` : `해제 실패 (HTTP ${res.status})`, !res.ok);
      loadResv();
    });
    li.append(rel);
    ul.append(li);
  }
}

$('resvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const port = $('resvPort').value ? Number($('resvPort').value) : undefined;
  const r = await post('/api/reservations', { owner: $('resvOwner').value, port, note: $('resvNote').value || undefined });
  const { body } = r;
  if (r.ok) {
    toast(body.existing ? `${body.reservation.owner}은(는) 이미 :${body.reservation.port}를 예약했어요` : `:${body.reservation.port}를 ${body.reservation.owner}에 예약했어요`);
    $('resvForm').reset();
  } else toast(errorText(r), true);
  loadResv();
});
loadResv();

$('rescan').addEventListener('click', () => load(true));
initCommandPalette({ refresh: () => load(true), showWorktree });
$('onlyRemovable').addEventListener('change', (e) => {
  onlyRemovable = e.target.checked;
  try { localStorage.setItem('pb.dev.onlyRemovable', onlyRemovable ? '1' : '0'); } catch {}
  render();
});
load();
void showAccess();
