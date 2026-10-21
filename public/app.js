// 서비스 tab: every listening port on this server (or, through the host picker, another machine's), refreshed every
// 10 s. The rows are features/ports.js, the actions features/control.js, the devices strip (phone only; the sidebar has
// the devices) features/devices.js, the inspector features/port-inspector.js. lib/shell.js is the bar, sidebar and
// inspector frame; the selected port is the URL hash (#8790), ↑/↓ move it.

import { done, share, shell, stepSelection, typingIn } from './lib/shell.js';
import { initAlerts, missingRows, refreshAlerts } from './features/alerts.js';
import { logsDialog, portAction } from './features/control.js';
import { deviceStrip, remoteHosts } from './features/devices.js';
import { remoteView } from './features/host-ports.js';
import { initCommandPalette } from './features/palette.js';
import { portsOverview, renderInspector } from './features/port-inspector.js';
import { grouped, haystack, renderGroup, renderRow } from './features/ports.js';
import { offerUndo, prefsUndo } from './features/undo.js';
import { errorText, getJSON, post, tryJSON } from './lib/api.js';
import { $, el } from './lib/dom.js';
import { whyEmpty } from './lib/empty.js';
import { locale, t } from './lib/i18n.js';
import { openMenuAt } from './lib/menu.js';
import { showProfile } from './lib/profile.js';
import { showAccess } from './lib/access.js';
import { checkedAgo } from './lib/time.js';
import { toast } from './lib/toast.js';
import { isSettingsHash } from './lib/settings-route.js';

const list = $('list');
const q = $('q');
const showSystem = $('showSystem');
const inUse = $('inUse');
const hostSel = $('hostSel');

const prefs = load();
q.value = prefs.q ?? '';
showSystem.checked = !!prefs.showSystem;
inUse.checked = !!prefs.inUse;

let data = null;
/** Other machines whose ports we know (features/devices.js remoteHosts) */
let hosts = [];
let selfName = t('common.thisServer');
/** host the user picked, by key: a pool name or a device/guest name ('' = this server); kept until that host shows up */
let wantHost = prefs.host ?? '';
/** GET /api/usage: who is using which port right now (byPort) */
let usage = null;
const busy = new Set();
/** Port whose ⋯ menu is open, so the 10-second refresh doesn't close it under the user's finger */
let openMenu = null;
const logs = logsDialog();
const insp = shell()?.inspector ?? null;

/** The selected port (the URL hash), shown in the inspector */
let selected = portFromHash();
function portFromHash() {
  const n = Number(location.hash.replace(/^#/, ''));
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** What the rows need from this page (features/ports.js) */
const rowCtx = {
  tpl: $('row'),
  get usage() { return usage; },
  busy,
  get openMenu() { return openMenu; },
  setOpenMenu: (port) => (openMenu = port),
  savePrefs,
  act,
  rename,
  confirmAct,
  openLogs: (p) => logs.show(p),
  get selected() { return selected; },
  shown: () => !!insp?.shown,
};

function load() {
  try { return JSON.parse(localStorage.getItem('portboard') ?? '{}'); } catch { return {}; }
}
function save() {
  try { localStorage.setItem('portboard', JSON.stringify({ q: q.value, showSystem: showSystem.checked, inUse: inUse.checked, host: wantHost })); } catch {}
}

// ---- devices strip and host picker ----
let devicesAt = 0;

async function refreshDevices(force = false) {
  if (!force && Date.now() - devicesAt < 30_000) return;
  devicesAt = Date.now();
  // the port list still works without it
  const doc = await tryJSON('/api/devices');
  if (doc) renderDevices(doc);
}

function renderDevices(doc) {
  share('devices', doc);
  const box = $('devices');
  const chips = deviceStrip(doc);
  box.replaceChildren(...chips);
  box.hidden = chips.length === 0;
  updateHosts(doc);
}

function updateHosts(doc) {
  selfName = doc.devices.find((d) => d.self)?.name ?? t('common.thisServer');
  hosts = remoteHosts(doc);
  const opts = [['', t('services.host.self', { name: selfName })], ...hosts.map((d) => [d.key, t('services.host.remote', { name: d.name, n: d.ports.ports.length })])];
  hostSel.replaceChildren(...opts.map(([value, label]) => {
    const o = el('option', null, label);
    o.value = value;
    return o;
  }));
  hostSel.value = hosts.some((d) => d.key === wantHost) ? wantHost : '';
  hostSel.hidden = hosts.length === 0;
  hostLabel();
  render();
}

/** The title shows the picked host (the <select> over it is transparent, lib/shell.js) */
function hostLabel() {
  $('host').textContent = hostSel.selectedOptions[0]?.textContent ?? t('services.host.self', { name: selfName });
}

function selectedHost() {
  return hostSel.value ? hosts.find((d) => d.key === hostSel.value) ?? null : null;
}

async function refreshUsage(fresh = false) {
  // the port list still works without it
  const next = await tryJSON(`/api/usage${fresh ? '?fresh' : ''}`);
  if (!next) return;
  usage = next;
  share('usage', usage);
  render();
}

async function refresh(fresh = false) {
  refreshDevices(fresh);
  refreshUsage(fresh);
  if (fresh) refreshAlerts();
  try {
    data = await getJSON(`/api/ports${fresh ? '?fresh' : ''}`);
    share('ports', data);
    if (!selectedHost()) setStatus(t('services.status', { time: new Date(data.at).toLocaleTimeString(locale()), n: data.ports.length }));
    render();
  } catch (err) {
    setStatus(t('services.loadFailed', { error: err.message }), true);
    done('page');
  }
}

function setStatus(text, error = false) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('error', error);
}

function render() {
  if (data) {
    $('host').title = data.tailscale.dnsName ?? data.host.hostname;
    if (!$('host').textContent) $('host').textContent = t('services.host.self', { name: data.host.hostname });
  }
  const remote = selectedHost();
  $('remote').hidden = !remote;
  list.hidden = !!remote;
  inUse.disabled = showSystem.disabled = !!remote;
  if (remote) {
    $('empty').hidden = true;
    $('remote').replaceChildren(...remoteView(remote, q.value.trim().toLowerCase()));
    setStatus(t('services.remoteStatus', { name: remote.name, n: remote.ports.ports.length, checked: checkedAgo(remote.ports.at) }));
    paintInspector();
    done('page');
    return;
  }
  if (!data) return;
  const needle = q.value.trim().toLowerCase();
  const users = (p) => (p.listening && usage?.byPort[p.port]) || null;
  const inUseCount = data.ports.filter(users).length;
  $('inUseCount').textContent = usage ? ` ${inUseCount}` : '';
  const rows = data.ports.filter((p) => {
    // "지금 사용 중" also shows system ports such as sshd: being used is the point
    if (inUse.checked) { if (!users(p)) return false; }
    else if (!showSystem.checked && !p.visible) return false;
    if (!needle) return true;
    return haystack(p, usage).includes(needle);
  });
  const missing = inUse.checked ? [] : missingRows(data.ports, needle);
  list.replaceChildren(...missing, ...grouped(rows).map((it) => (it.ports ? renderGroup(it, rowCtx) : renderRow(it, rowCtx))));
  $('empty').hidden = rows.length + missing.length > 0;
  if (!$('empty').hidden) whyEmpty($('empty'), emptyNote(needle));
  paintInspector();
  // the rows are there: the main column may show (shell.css [data-wait])
  done('page');
  // opened on a #port: show it once the rows are there
  if (!revealed && selected != null) {
    revealed = true;
    select(selected, { open: true, scroll: true });
  }
}
let revealed = false;

// ---- selection and the inspector ----

function paintInspector() {
  if (!insp?.shown) return;
  if (selectedHost()) {
    renderInspector(insp, null, { ...rowCtx, emptyText: t('services.remoteInspector') });
    return;
  }
  const p = data?.ports.find((x) => x.port === selected) ?? null;
  renderInspector(insp, p, p || !data ? rowCtx : { ...rowCtx, overview: portsOverview(data.ports, usage, missingRows(data.ports).length) });
}

/** Select a port (null: none): the row's highlight, the hash (no new history entry), the inspector */
function select(port, { open = false, scroll = false } = {}) {
  selected = port;
  history.replaceState(null, '', port == null ? location.pathname + location.search : `#${port}`);
  for (const li of list.querySelectorAll('li.row[data-port]')) li.classList.toggle('selected', Number(li.dataset.port) === port);
  if (open && port != null && insp?.usable && !insp.shown) insp.open();
  paintInspector();
  document.dispatchEvent(new Event('shell:select'));
  if (scroll) list.querySelector(`li.row[data-port="${port}"]`)?.scrollIntoView({ block: 'nearest' });
}

// A click on a row (not on its links, buttons, menus or fields) selects it; on a phone 상세 stays inline instead
list.addEventListener('click', (e) => {
  const li = e.target.closest('li.row[data-port]');
  if (!li || e.target.closest('a, button, summary, details, input, label, select') || !insp?.usable) return;
  select(Number(li.dataset.port), { open: true });
});
// A right-click on a row opens its ⋯ menu (the name link and fields keep the browser's own menu)
list.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li.row[data-port]');
  if (!li || e.target.closest('a, input, select, textarea')) return;
  if (openMenuAt(li.querySelector('.actions > details.menu'))) e.preventDefault();
});
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.metaKey || e.ctrlKey || e.altKey || !insp?.usable || selectedHost()) return;
  if (typingIn(e.target, document)) return;
  const keys = [...list.querySelectorAll('li.row[data-port]')].map((li) => Number(li.dataset.port));
  const next = stepSelection(keys, selected, e.key === 'ArrowDown' ? 1 : -1);
  if (next == null) return;
  e.preventDefault();
  select(next, { scroll: true });
});
// #settings/… is the 설정 modal over this page (features/settings-modal.js): the selection stays as it was
window.addEventListener('hashchange', () => { if (!isSettingsHash(location.hash)) select(portFromHash(), { open: true, scroll: true }); });
document.addEventListener('shell:layout', () => paintInspector());

/** Why no row is shown, and what brings them back */
function emptyNote(needle) {
  const all = () => { inUse.checked = false; showSystem.checked = true; save(); render(); };
  if (!data.ports.length) return { title: t('services.empty.none') };
  if (needle) {
    const hiddenHits = data.ports.filter((p) => haystack(p, usage).includes(needle)).length;
    if (hiddenHits) return { title: t('services.empty.hiddenHits', { q: q.value.trim(), n: hiddenHits }), actions: [{ label: t('services.empty.showAll'), onClick: all }] };
    return {
      title: t('services.empty.noMatch', { q: q.value.trim() }),
      text: t('services.empty.paletteHint'),
      actions: [{ label: t('services.empty.clear'), onClick: () => { q.value = ''; save(); render(); } }, { label: t('services.empty.palette'), onClick: () => palette.open(q.value.trim()) }],
    };
  }
  if (inUse.checked) return { title: t('services.empty.inUse'), text: t('services.empty.inUseText'), actions: [{ label: t('services.empty.showAll'), onClick: all }] };
  return { title: t('services.empty.filtered', { n: data.ports.length }), text: t('services.empty.filteredText'), actions: [{ label: t('services.empty.showAll'), onClick: all }] };
}

function rename(p) {
  const next = window.prompt(t('services.renamePrompt', { port: p.port, auto: p.detectedName }), p.label ?? '');
  if (next === null) return;
  savePrefs(p.port, { label: next });
}

/** Save prefs; unpin, hide, a cleared label and alert off apply at once with a 되돌리기 toast (features/undo.js) */
async function savePrefs(port, patch) {
  const before = data?.ports.find((p) => p.port === port) ?? null;
  if (await postPrefs(port, patch)) {
    offerUndo(port, prefsUndo(before, patch), async (prev) => {
      const ok = await postPrefs(port, prev);
      await refresh(true);
      return ok;
    });
  }
  await refresh(true);
}

async function postPrefs(port, patch) {
  try {
    const r = await post(`/api/ports/${port}/prefs`, patch);
    if (!r.ok) toast(errorText(r), true);
    return r.ok;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

function confirmAct(p, kind, question) {
  if (window.confirm(question)) act(p.port, kind);
}

async function act(port, kind) {
  busy.add(port);
  render();
  try {
    await portAction(port, kind, () => data?.ports.some((p) => p.port === port && p.alert));
  } finally {
    busy.delete(port);
    await refresh(true);
  }
}

q.addEventListener('input', () => { save(); render(); });
hostSel.addEventListener('change', () => {
  wantHost = hostSel.value;
  hostLabel();
  save();
  if (!wantHost && data) setStatus(t('services.status', { time: new Date(data.at).toLocaleTimeString(locale()), n: data.ports.length }));
  render();
});
inUse.addEventListener('change', () => { save(); render(); });
showSystem.addEventListener('change', () => { save(); render(); });
$('refresh').addEventListener('click', () => refresh(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 10_000);

initAlerts({ render, reload: () => refresh(true) });
const palette = initCommandPalette({ refresh: () => refresh(true), openLogs: (p) => logs.show(p), confirmAct, savePrefs });
void showProfile();
void showAccess();
refresh();
