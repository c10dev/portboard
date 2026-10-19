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
import { locale, t } from './lib/i18n.js';

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
  main.append(el('div', 'br', w.branch ?? (w.detached ? `(${t('dev.detached')})` : '?')), el('div', 'path', w.short));
  const tags = el('div', 'tags');
  if (w.pr) tags.append(badge(t(w.pr.state === 'MERGED' ? 'dev.pr.merged' : w.pr.state === 'OPEN' ? 'dev.pr.open' : 'dev.pr.closed', { n: w.pr.number }), w.pr.state === 'MERGED' ? 'ok' : w.pr.state === 'OPEN' ? 'info' : ''));
  else if (w.mergedByAncestry) tags.append(badge(t('dev.merged'), 'ok'));
  if (w.changes) tags.append(badge(t('dev.changes', { n: w.changes }), 'warn'));
  if (w.inUse.length) tags.append(badge(t('dev.inUse', { n: w.inUse.length }), 'warn'));
  if (w.locked) tags.append(badge(t('dev.locked'), 'warn'));
  if (w.main) tags.append(badge(t('dev.main'), 'info'));
  else if (!w.removable && w.keep.length) tags.append(badge(t('dev.keep', { reasons: w.keep.join(', ') })));
  if (w.removable) tags.append(badge(t('dev.removable'), 'ok'));
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
    const a = el('a', 'badge ok', t('dev.running', { port: running.port ?? '?' }));
    if (running.port) a.href = `service.html#${running.port}`;
    a.title = running.description;
    const stop = el('button', null, t('dev.stop'));
    stop.dataset.write = '1';
    stop.type = 'button';
    stop.addEventListener('click', () => devAction('stop', path, t('dev.stop.confirm', { what: running.description })));
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
  if (!window.confirm(t('dev.remove.confirm', { repo: repo.name, n: paths.length, list }))) return;
  try {
    const { body } = await post('/api/worktrees/remove', { repo: repo.path, paths });
    const failed = (body.results ?? []).filter((r) => !r.ok);
    selected.delete(repo.path);
    toast(failed.length ? t('dev.remove.partial', { ok: paths.length - failed.length, failed: failed.length, errors: failed.map((f) => f.message).join(' / ') }) : t('dev.remove.done', { n: paths.length }), failed.length > 0);
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
  const tot = doc.totals;
  $('headline').textContent = doc.at ? t('dev.headline', { repos: tot.repos, worktrees: tot.worktrees, removable: tot.removable, size: tot.removableKb ? ` (${mb(tot.removableKb)})` : '' }) : t('dev.scanning');
  $('status').textContent = doc.scanning ? t('dev.rescanning') : doc.at ? t('dev.scanned', { time: new Date(doc.at).toLocaleTimeString(locale()), s: Math.round((doc.tookMs ?? 0) / 100) / 10 }) : '';
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
    head.append(el('h3', null, repo.name), el('span', 'meta', `${t('dev.repo.meta', { worktrees: repo.worktrees.length - 1, removable: removable.length })}${repo.prsKnown ? '' : ` · ${t('dev.repo.noPrs')}`}`), el('span', 'spacer'));
    if (removable.length) {
      const all = el('button', null, t('dev.selectAll'));
      all.type = 'button';
      all.addEventListener('click', () => { selected.set(repo.path, new Set(removable.map((w) => w.path))); render(); });
      head.append(all);
    }
    const sel = selected.get(repo.path)?.size ?? 0;
    const rm = el('button', 'btn primary', t('dev.removeSel', { n: sel }));
    rm.dataset.write = '1';
    rm.type = 'button';
    rm.disabled = sel === 0;
    rm.addEventListener('click', () => removeSelected(repo));
    head.append(rm);
    if (prunable.length) {
      const pr = el('button', null, t('dev.prune', { n: prunable.length }));
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
      title: t('dev.empty.removable'),
      actions: [{ label: t('dev.empty.showAll'), onClick: () => { $('onlyRemovable').checked = false; $('onlyRemovable').dispatchEvent(new Event('change')); } }],
    });
  }
  return whyEmpty(el('div'), {
    title: t('dev.empty.repos'),
    text: t('dev.empty.repos.text'),
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
  if (!li) { toast(t('dev.notListed'), true); return; }
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
    $('status').textContent = t('dev.loadFailed', { error: err });
    done('page');
    return;
  }
  render();
  // the repos are there (or 검사 중…): the main column may show (shell.css [data-wait])
  done('page');
  // ?refresh is accepted once a minute (L1); a click sooner shows the running or last scan
  if (rescan && doc.refresh === 'throttled') toast(t('dev.throttled'));
  if (doc.scanning || !doc.at) setTimeout(() => load(), 2000);
}

// ---- port reservations (#27) ----
async function loadResv() {
  let list = [];
  try { list = (await readJSON('/api/reservations')).reservations ?? []; } catch {}
  const ul = $('resvList');
  ul.replaceChildren();
  if (!list.length) { ul.append(el('li', 'muted', t('dev.resv.none'))); return; }
  for (const r of list) {
    const li = el('li');
    li.append(el('code', null, `:${r.port}`), el('strong', null, r.owner));
    if (r.note) li.append(el('span', 'muted', r.note));
    const l = r.listening;
    li.append(l ? badge(t('dev.resv.inUse', { what: `${l.name}${l.project ? ` (${l.project})` : ''}` }), l.matchesOwner === false ? 'warn' : 'ok') : badge(t('dev.resv.free')));
    if (l && l.matchesOwner === false) li.append(el('span', 'muted', t('dev.resv.other')));
    li.append(el('span', 'spacer'));
    const rel = el('button', null, t('dev.resv.release'));
    rel.dataset.write = '1';
    rel.type = 'button';
    rel.addEventListener('click', async () => {
      if (!window.confirm(t('dev.resv.release.confirm', { port: r.port, owner: r.owner }))) return;
      const res = await post(`/api/reservations/${r.port}/release`);
      toast(res.ok ? t('dev.resv.released', { port: r.port }) : t('dev.resv.releaseFailed', { status: res.status }), !res.ok);
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
    toast(body.existing ? t('dev.resv.existing', { owner: body.reservation.owner, port: body.reservation.port }) : t('dev.resv.done', { port: body.reservation.port, owner: body.reservation.owner }));
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
