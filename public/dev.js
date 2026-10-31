// 개발 tab (c10dev/portboard#36): git worktrees of every repo under ~/projects, which can safely go, and batch removal
// (`git worktree remove`, never forced; branches kept). The scan runs in the background on the server.
// With other machines listed (GET /api/machines, `portboard agent`), their checkouts show too, read-only, under the
// same repo, each row says which machine it is on, the filter picks one machine, and a checkout whose repo@branch is
// also on another machine gets a badge (warn when there are changes or a session there).

import { done } from './lib/shell.js'; // first: the bar, sidebar and inspector are wired before anything looks them up
import { errorText, post, readJSON, tryJSON } from './lib/api.js';
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
import { alsoOn, cloudBranchLine, elsewhereByOwner, machineOptions, remoteRepos, sameRepo, upstreamBadge } from './lib/machines.js';

let doc = null;
let devDoc = { running: [], startable: {} };
const selected = new Map(); // repo path → Set(worktree path)
let onlyRemovable = false;
try { onlyRemovable = localStorage.getItem('pb.dev.onlyRemovable') === '1'; } catch {}
$('onlyRemovable').checked = onlyRemovable;
/** GET /api/machines' list ([] until it answers, or without other machines) */
let machines = [];
/** the machine filter: '' = every machine */
let machineFilter = '';
try { machineFilter = localStorage.getItem('pb.dev.machine') ?? ''; } catch {}

const toast = (text, error = false) => show(text, error, { ms: error ? 8000 : 3500 });

const lc = (s) => String(s ?? '').toLowerCase();
const multi = () => machines.some((m) => m.reach === 'agent');
const selfName = () => machines.find((m) => m.reach === 'local')?.name ?? '';

/** The branch line, with the machine it is on when there are several */
function branchLine(machine, text) {
  const br = el('div', 'br');
  if (multi()) br.append(el('span', 'wt-mach', machine), ' ');
  br.append(text);
  return br;
}

/** ↑ahead ↓behind its upstream (as of the last fetch), when they differ */
function upstream(tags, w) {
  const up = upstreamBadge(w);
  if (!up) return;
  const b = badge(up[0], up[1]);
  b.title = up[2];
  tags.append(b);
}

function row(repo, w, elsewhere) {
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
  main.append(branchLine(selfName(), w.branch ?? (w.detached ? `(${t('dev.detached')})` : '?')), el('div', 'path', w.short));
  const tags = el('div', 'tags');
  const also = w.branch ? alsoOn(elsewhere.get(lc(`${repo.name}@${w.branch}`))) : null;
  if (also) {
    const b = badge(also[0], also[1]);
    b.title = also[2];
    tags.append(b);
  }
  upstream(tags, w);
  if (w.pr) tags.append(badge(t(w.pr.state === 'MERGED' ? 'dev.pr.merged' : w.pr.state === 'OPEN' ? 'dev.pr.open' : 'dev.pr.closed', { n: w.pr.number }), w.pr.state === 'MERGED' ? 'ok' : w.pr.state === 'OPEN' ? 'info' : ''));
  else if (w.mergedByAncestry) tags.append(badge(t('dev.merged'), 'ok'));
  if (w.changes) tags.append(badge(t('dev.changes', { n: w.changes }), 'warn'));
  if (w.inUse.length) tags.append(badge(t('dev.inUse', { n: w.inUse.length }), 'warn'));
  if (w.claude) tags.append(badge(t('dev.claude'), 'info'));
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

/** Another machine's checkout: read-only (no removal, no dev server controls), its path only when that agent shares paths */
function remoteRow(machine, w) {
  const li = el('li', 'wt-row keep wt-remote');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.disabled = true;
  const main = el('div');
  main.append(branchLine(machine, w.branch), el('div', 'path', w.path ?? t('dev.machines.noPath')));
  const tags = el('div', 'tags');
  if (w.dirty) tags.append(badge(t('dev.changes', { n: w.dirty }), 'warn'));
  upstream(tags, w);
  if (w.inUse) tags.append(badge(t('dev.machines.inUse'), 'warn'));
  if (w.claude) tags.append(badge(t('dev.claude'), 'info'));
  if (w.main) tags.append(badge(t('dev.main'), 'info'));
  if (w.reservedPort) tags.append(badge(`:${w.reservedPort}`));
  main.append(tags);
  li.append(cb, main, el('div', 'side', ago(w.lastCommit) ?? ''));
  return li;
}

/** The machine filter in the filter menu: shown once another machine has checkouts */
function paintMachineFilter() {
  const sel = $('machineFilter');
  const opts = machineOptions(machines);
  $('machineFilterRow').hidden = opts.length < 2;
  if (machineFilter && !opts.some((o) => o.value === machineFilter)) machineFilter = '';
  sel.replaceChildren(el('option', null, t('dev.machines.all')), ...opts.map((o) => {
    const op = el('option', null, o.label);
    op.value = o.value;
    return op;
  }));
  sel.firstChild.value = '';
  sel.value = machineFilter;
}

async function loadMachines() {
  const d = await tryJSON('/api/machines');
  machines = d?.machines ?? [];
  paintMachineFilter();
  render();
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
  const local = !machineFilter || machineFilter === selfName();
  const elsewhere = elsewhereByOwner(machines);
  // other machines' checkouts (never removable: hidden with 정리 가능만)
  const remote = onlyRemovable ? [] : remoteRepos(machines, local ? null : machineFilter);
  const used = new Set();
  const remoteOf = (repo) => {
    const mine = remote.filter((r) => sameRepo(repo, r));
    for (const r of mine) used.add(r);
    return mine;
  };
  for (const repo of [...doc.repos].sort((a, b) => b.worktrees.filter((w) => w.removable).length - a.worktrees.filter((w) => w.removable).length)) {
    // The main checkout is listed too (its dev server can be started here), but never selectable for removal.
    const wts = local ? repo.worktrees.filter((w) => !onlyRemovable || w.removable) : [];
    const removable = local ? repo.worktrees.filter((w) => w.removable) : [];
    const prunable = local ? repo.worktrees.filter((w) => w.prunable) : [];
    const theirs = remoteOf(repo);
    if (!local && !theirs.length) continue;
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
    // another machine picked: this repo's local rows are hidden, so is removing them
    if (local) {
      const rm = el('button', 'btn primary', t('dev.removeSel', { n: sel }));
      rm.dataset.write = '1';
      rm.type = 'button';
      rm.disabled = sel === 0;
      rm.addEventListener('click', () => removeSelected(repo));
      head.append(rm);
    }
    if (prunable.length) {
      const pr = el('button', null, t('dev.prune', { n: prunable.length }));
      pr.dataset.write = '1';
      pr.type = 'button';
      pr.addEventListener('click', () => prune(repo));
      head.append(pr);
    }
    const ul = el('ul', 'wt-list');
    for (const w of wts) ul.append(row(repo, w, elsewhere));
    for (const r of theirs) for (const w of r.worktrees) ul.append(remoteRow(r.machine, w));
    // work pushed to claude/* branches from elsewhere (a cloud session, as a rule): not checked out here
    const cloud = local && !onlyRemovable ? cloudBranchLine(repo) : null;
    sec.append(head, ...(cloud ? [el('p', 'wt-cloud', cloud)] : []), ul);
    box.append(sec);
  }
  // repos that are only on other machines
  for (const r of remote.filter((x) => !used.has(x))) {
    const sec = el('section', 'wt-repo wt-remote');
    const head = el('header');
    head.append(el('h3', null, r.repo), el('span', 'meta', t('dev.machines.onlyOn', { machine: r.machine })));
    const ul = el('ul', 'wt-list');
    for (const w of r.worktrees) ul.append(remoteRow(r.machine, w));
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
$('machineFilter').addEventListener('change', (e) => {
  machineFilter = e.target.value;
  try { localStorage.setItem('pb.dev.machine', machineFilter); } catch {}
  render();
});
$('onlyRemovable').addEventListener('change', (e) => {
  onlyRemovable = e.target.checked;
  try { localStorage.setItem('pb.dev.onlyRemovable', onlyRemovable ? '1' : '0'); } catch {}
  render();
});
load();
loadMachines();
void showAccess();
