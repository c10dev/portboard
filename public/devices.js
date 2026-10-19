// 기기 tab: the network tree (구조, features/nettree-view.js) or one card per device with what it is using on this
// server right now (카드; GET /api/usage, src/features/usage.ts), and the detail panel. The cards are
// features/usage.js, 새 기기 features/known.js, Proxmox hosts and guests features/proxmox.js, other machines' ports
// features/host-ports.js.

import { done } from './lib/shell.js'; // first: the bar, sidebar and inspector are wired before anything looks them up
import { canWatchDevice, deviceWatched, initAlerts, setDeviceAlert } from './features/alerts.js';
import { agentLine, portList, renderPortsHint, renderWinHint, sidesText } from './features/host-ports.js';
import { newBlock, renderNewDevices, renderSettings, short } from './features/known.js';
import { findNode, loadView, nodeDetail, renderTree, saveView } from './features/nettree-view.js';
import { initCommandPalette } from './features/palette.js';
import { dayBlock, findGuest, guestDetail, hostLine, loadTrends, pveRef } from './features/proxmox.js';
import { prefill, prefillHint } from './features/suggestions.js';
import { card, hist, idleChip, idleServices, localText, osName, pastChip, poolLine } from './features/usage.js';
import { getJSON, postOrThrow } from './lib/api.js';
import { locale, t } from './lib/i18n.js';
import { routedTitle } from './lib/nettree.js';
import { sheet } from './lib/dialog.js';
import { $, dl, el, extLink } from './lib/dom.js';
import { whyEmpty } from './lib/empty.js';
import { bytes } from './lib/format.js';
import { showProfile } from './lib/profile.js';
import { showAccess } from './lib/access.js';
import { agoMonths as ago, checkedAgo, usageMinutes as minutes } from './lib/time.js';
import { toast } from './lib/toast.js';
import { isSettingsHash } from './lib/settings-route.js';

let data = null;
/** card id whose detail is open, or guest:<node>/<vmid> for a Proxmox guest without a card, or a tree row's address */
let open = null;
/** 구조 (the network tree) or 카드 */
let view = loadView();
const detail = sheet($('detail'), $('detailClose'), () => { open = null; markOpen(); });
const say = (text, error = false) => toast(text, error, { ms: 3500 });

/** The detail's words for a card's kind, where its name came from, how it matched a pool host, how its LAN address was confirmed */
const KIND = { self: t('common.thisServer'), tailnet: t('devices.kind.tailnet'), pool: t('devices.kind.pool'), lan: t('devices.kind.lan'), funnel: t('devices.kind.funnel'), other: t('devices.kind.other') };
const NAME_SOURCE = { user: t('devices.src.user'), tailscale: 'Tailscale', pool: 'compute-pool', proxmox: t('devices.src.proxmox'), vendor: t('devices.src.vendor'), ip: t('devices.src.ip'), funnel: 'Tailscale Funnel' };
const POOL_MATCH = { self: t('common.thisServer'), address: t('devices.match.address'), link: 'prefs.json deviceLinks' };
const LAN_VIA = { 'compute-pool': t('devices.lanVia.pool'), 'ssh-hostkey': t('devices.lanVia.hostKey'), proxmox: 'Proxmox' };

/** What the feature modules need from this page */
const ctx = {
  get data() { return data; },
  showDetail: (id) => showDetail(id),
  nameDevice: (c) => nameDevice(c),
  refresh: (fresh) => refresh(fresh),
};

async function refresh(fresh = false) {
  try {
    data = await getJSON(`/api/usage${fresh ? '?fresh' : ''}`);
    render();
  } catch (err) {
    setStatus(t('devices.loadFailed', { error: err.message }), true);
    done('page');
  }
}

function setStatus(text, error = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', error);
}

// ---------- render ----------

function render() {
  // Proxmox hosts and pool hosts that report their ports always get a full card: that list is the point.
  const shown = data.cards.filter((c) => c.kind !== 'self' && (c.connections > 0 || c.pveHost || c.ports?.ports.length));
  const selfCard = data.cards.find((c) => c.kind === 'self');
  const idle = data.cards.filter((c) => c.kind !== 'self' && !shown.includes(c));
  const own = shown.filter((c) => c.uses.some((u) => !u.routed));
  const services = new Set(own.flatMap((c) => c.uses.filter((u) => !u.routed).map((u) => u.port)));
  const routed = shown.flatMap((c) => c.uses.filter((u) => u.routed).map((u) => ({ c, u })));

  let head = own.length ? t('devices.head.using', { n: own.length, services: t('devices.head.services', { n: services.size }) }) : t('devices.head.none');
  if (routed.length) {
    const by = [...new Set(routed.map((x) => x.c.name))].join(', ');
    head += ` · ${t('devices.head.routed', { by, n: routed.reduce((a, x) => a + x.u.connections, 0) })}`;
  }
  $('headline').textContent = head;
  $('headline').title = [...new Set(routed.map((x) => x.c))].map((c) => routedTitle(c.name, c.routes)).join('\n');
  const pve = data.proxmox;
  const hint = !pve.configured
    ? t('devices.pve.setup')
    : !pve.ok ? `Proxmox: ${pve.error}` : pve.looseMode ? t('devices.pve.loose') : '';
  $('pveHint').textContent = hint;
  $('pveHint').hidden = !hint;
  renderPortsHint($('pvePortsHint'), data.pvePorts);
  renderWinHint($('winPortsHint'), data.winPorts);
  setStatus(t('devices.status', { time: new Date(data.at).toLocaleTimeString(locale()) }));

  renderNewDevices(ctx);
  renderSettings(ctx);
  paintView();
  $('active').replaceChildren(...(shown.length ? shown.map((c) => card(c, ctx)) : [noneActive()]));
  $('self').replaceChildren(...(selfCard ? [card(selfCard, ctx, true)] : []));

  // Devices only the history knows: a LAN machine that used something here but isn't connected now
  const known = new Set(data.cards.map((c) => c.id));
  const past = Object.entries(hist(data).byDevice)
    // not pseudo-clients (this server's processes, subnet-router traffic, tailscale serve's unpaired legs, docker)
    .filter(([id]) => !['local', 'serve', 'docker'].includes(id) && !id.endsWith('~routed') && !known.has(id))
    .sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen));
  const idleCount = idle.length + past.length;
  $('idleH').textContent = t('devices.idleH', { n: idleCount });
  $('idleH').hidden = $('idle').hidden = idleCount === 0;
  $('idle').replaceChildren(...idle.map((c) => idleChip(c, ctx)), ...past.map(([id, d]) => pastChip(id, d, ctx)));

  $('idleSvcH').textContent = t('devices.idleSvcH', { n: data.idleServices });
  $('idleSvcH').hidden = $('idleSvc').hidden = $('idleSvcList').hidden = data.idleServices === 0;
  $('idleSvcList').replaceChildren(...idleServices(ctx));

  // #settings/… is the 설정 modal over this page (features/settings-modal.js), not a device
  if (!hashUsed && location.hash.length > 1 && !isSettingsHash(location.hash)) {
    hashUsed = true;
    open = decodeURIComponent(location.hash.slice(1));
  }
  if (open) showDetail(open);
  // the cards are there: the main column may show (shell.css [data-wait])
  done('page');
}

let hashUsed = false;

/** No device card: say where devices come from */
function noneActive() {
  const others = data.cards.some((c) => c.kind !== 'self');
  return whyEmpty(el('div'), others
    ? { title: t('devices.empty.others'), text: t('devices.empty.others.text') }
    : { title: t('devices.empty.none'), text: t('devices.empty.none.text') });
}

// ---------- detail ----------

function showDetail(id) {
  if (id?.startsWith('guest:')) return showGuest(id);
  const c = data.cards.find((x) => x.id === id);
  if (!c) return showNode(id);
  const same = open === id && detail.open;
  open = id;
  detail.show(() => paintDetail(c, id), same);
  markOpen();
}

/** A tree row with no card (a LAN address the ARP table or a name knows, nothing connected now) */
function showNode(id) {
  const row = id ? findNode(data.tree, id) : null;
  if (!row) { open = null; $('detail').hidden = true; return; }
  const same = open === id && detail.open;
  open = id;
  detail.show(() => $('detailBody').replaceChildren(...nodeDetail(row)), same);
  markOpen();
}

/** A Proxmox guest with no card of its own (jellyfin) */
function showGuest(id) {
  const guest = findGuest(id, data);
  if (!guest) { open = null; $('detail').hidden = true; return; }
  const same = open === id && detail.open;
  open = id;
  detail.show(() => $('detailBody').replaceChildren(...guestDetail(guest, () => open === id && showGuest(id))), same);
  markOpen();
}

function paintDetail(c, id) {
  const body = $('detailBody');
  body.replaceChildren();
  body.append(el('div', 'd-kicker', KIND[c.kind]));
  body.append(el('h3', 'd-title', c.name));
  if (c.newDevice) body.append(newBlock(c, ctx));
  const rows = [
    [t('devices.row.nameSource'), NAME_SOURCE[c.nameSource]],
    ['OS', osName(c)],
    [t('devices.row.status'), c.kind === 'lan' || c.kind === 'funnel' ? null : c.online ? t('devices.online') : `${t('devices.offline')}${c.lastSeen ? ` · ${ago(c.lastSeen)}` : ''}`],
    [t('devices.row.tsPath'), c.path?.type === 'direct' ? t('devices.path.direct', { endpoint: c.path.endpoint }) : c.path?.type === 'relay' ? t('devices.path.relay', { region: c.path.region }) : null],
    ['Tailscale IP', c.tailscaleIps.join('\n')],
    ['LAN IP', c.lanIps.join(', ') || (c.kind === 'lan' ? c.addresses.join(', ') : null)],
    [t('devices.row.addresses'), c.addresses.join(', ')],
    ['MAC', c.mac ? (c.randomMac ? t('devices.mac.random', { mac: c.mac }) : c.mac) : null],
    [t('devices.row.vendor'), c.vendor],
    ['compute-pool', c.pool ? poolLine(c.pool) : null],
    [t('devices.row.agent'), c.agent ? agentLine(c.agent) : null],
    [t('devices.row.poolMatch'), c.pool && c.poolMatch ? POOL_MATCH[c.poolMatch] : null],
    [t('devices.row.lanVia'), Object.entries(c.lanVia ?? {}).map(([ip, via]) => `${ip}: ${LAN_VIA[via] ?? via}`).join('\n')],
    [t('devices.row.routes'), c.routes.join(', ')],
    [t('devices.row.virt'), c.virt && c.virt.type !== 'none' ? `${c.virt.type}${c.virt.proxmoxMac ? ' · Proxmox MAC(BC:24:11)' : ''}` : null],
    ['Proxmox', c.guestOf ? `${t('devices.guestOf', { node: c.guestOf.node, kind: c.guestOf.type === 'lxc' ? 'CT' : 'VM', vmid: c.guestOf.vmid })} · ${c.guestOf.status}` : null],
    [t('devices.pveHost'), c.pveHost ? hostLine(c.pveHost) : null],
    [t('devices.row.lastUsed'), hist(data).byDevice[c.id] ? `${ago(hist(data).byDevice[c.id].lastSeen)} · ${new Date(hist(data).byDevice[c.id].lastSeen).toLocaleString(locale())}` : null],
  ];
  body.append(dl(rows));
  const ref = pveRef(c);
  if (ref) body.append(dayBlock(ref, ref.vmid != null ? t('devices.guestOf', { node: c.guestOf.node, kind: c.guestOf.type === 'lxc' ? 'CT' : 'VM', vmid: ref.vmid }) : t('devices.node', { node: ref.node }), () => open === id && showDetail(id)));
  if (c.kind !== 'self' && c.ports) {
    const box = el('div', 'd-use');
    const h = el('div', 'd-use-h');
    h.append(el('strong', null, t('devices.ports.head', { name: c.name, n: c.ports.ports.length })), el('span', 'use-port', checkedAgo(c.ports.at)));
    box.append(h, c.ports.ports.length ? portList(c.ports.ports, c.name) : el('p', 'muted', t('hostports.noPorts')));
    if (c.ports.sides) box.append(el('p', 'muted small', t('devices.ports.sidesNote', { sides: sidesText(c.ports) })));
    box.append(el('p', 'muted small', c.portsSource === 'pve-ssh'
      ? t('devices.ports.pveNote', { node: data.pvePorts?.node ?? t('devices.pveHost') })
      : c.portsSource === 'agent' ? t('devices.ports.agentNote')
      : t('devices.ports.poolNote')));
    body.append(box);
  } else if (c.kind !== 'self' && c.pool?.kind === 'agent' && c.pool.agent?.connected) {
    body.append(el('p', 'muted', t('devices.ports.noWorker')));
  }
  const recent = hist(data).byDevice[c.kind === 'self' ? 'local' : c.id]?.recent ?? [];
  if (recent.length) {
    const box = el('div', 'd-recent');
    box.append(el('div', 'd-recent-h', t('devices.recent')));
    const ul = el('ul', 'uses');
    for (const r of recent) {
      const li = el('li');
      const name = el('span', 'use-name');
      name.append(el('span', null, r.service), el('span', 'use-port', `:${r.port}`));
      li.append(name, el('span', 'use-meta', `${minutes(r.minutes)} · ${ago(r.lastSeen)}`));
      ul.append(li);
    }
    box.append(ul);
    body.append(box);
  }
  if (c.uses.some((u) => u.routed)) body.append(routedExplain(c));
  const uses = c.kind === 'self' ? data.local.uses : c.uses;
  if (uses.length) {
    for (const u of uses) {
      const box = el('div', 'd-use');
      const h = el('div', 'd-use-h');
      h.append(el('strong', null, c.kind === 'self' ? localText(u) : u.service), el('span', 'use-port', `:${u.port}`));
      if (u.routed) {
        const tag = el('span', 'tag', t('nettree.via', { name: c.name }));
        tag.title = routedTitle(c.name, c.routes);
        h.append(tag);
      }
      if (u.url?.startsWith('http')) h.append(extLink(t('hostports.open'), u.url, 'd-open'));
      box.append(h, dl([
        [t('devices.use.path'), u.via === 'serve' ? `tailscale ${c.kind === 'funnel' ? 'funnel' : 'serve'} :${u.servePort} → :${u.port}` : null],
        [t('devices.use.conns'), t('devices.use.connCount', { n: u.connections })],
        [t('devices.use.sent'), bytes(u.bytesSent)],
        [t('devices.use.received'), bytes(u.bytesReceived)],
        ['RTT', u.rttMs != null ? `${u.rttMs} ms` : null],
        [t('devices.use.since'), sinceText(u)],
        [t('devices.use.first'), u.firstSeen && u.firstSeen < u.since ? firstText(u.firstSeen) : null],
        [t('devices.use.procs'), u.processes.join(', ')],
        [t('devices.use.fullName'), u.fullName !== u.service ? u.fullName : null],
      ]));
      body.append(box);
    }
  } else {
    body.append(el('p', 'muted', t('devices.noUses')));
  }
  if (c.nameKey) {
    const b = el('button', 'name-btn', c.nameSource === 'user' ? t('devices.rename') : t('devices.nameIt'));
    b.dataset.write = '1';
    b.type = 'button';
    b.addEventListener('click', () => nameDevice(c));
    body.append(b);
  }
  if (canWatchDevice(c)) {
    const on = deviceWatched(c.id);
    const b = el('button', 'name-btn alert-btn', on ? t('devices.alert.off') : t('devices.alert.on'));
    b.dataset.write = '1';
    b.type = 'button';
    b.title = t('devices.alert.title');
    b.addEventListener('click', () => setDeviceAlert(c.id, !on));
    body.append(b);
  }
}

/** since is the persisted start of this run of use when Portboard has it, else when this process first saw the connection. */
function sinceText(u) {
  const bound = u.since === data.observingSince || u.since === hist(data).startedAt;
  return bound ? t('devices.since.bound', { t: ago(u.since) }) : t('devices.since.at', { t: ago(u.since), when: new Date(u.since).toLocaleString(locale()) });
}

function firstText(iso) {
  return iso === hist(data).startedAt ? t('devices.first.bound', { t: ago(iso) }) : `${ago(iso)} · ${new Date(iso).toLocaleString(locale())}`;
}

function routedExplain(c) {
  const self = data.cards.find((x) => x.kind === 'self');
  const lan = Object.keys(c.lanVia ?? {})[0] ?? c.addresses[0];
  const why = el('div', 'explain');
  why.append(
    el('strong', null, t('devices.routed.h', { name: c.name })),
    el('p', null, t('devices.routed.p', { name: c.name, routes: c.routes.join(', '), selfLan: data.selfLanIps?.[0] ?? '192.168.1.x', lan })),
    el('p', null, t('devices.routed.fix')),
  );
  const ol = el('ol');
  ol.append(
    el('li', null, t('devices.routed.fix1', { name: self?.name ?? t('common.thisServer'), ip: self?.tailscaleIps?.[0] ?? '100.x' })),
    el('li', null, t('devices.routed.fix2', { name: c.name, lan })),
  );
  why.append(ol);
  return why;
}

// ---------- naming ----------

async function nameDevice(c) {
  const hint = c.vendor ? ` ${t('devices.namePrompt.vendor', { vendor: short(c.vendor) })}` : '';
  const next = window.prompt(t('devices.namePrompt', { addr: c.addresses[0] ?? c.id, hint, prefill: prefillHint(c) }), prefill(c));
  if (next === null) return;
  try {
    const body = await postOrThrow('/api/clients/name', { key: c.nameKey, name: next.trim() || null });
    say(body.name ? t('devices.saved', { name: body.name }) : t('devices.cleared'));
    await refresh(true);
  } catch (err) {
    say(t('devices.saveFailed', { error: err.message }), true);
  }
}

// ---------- 구조 / 카드 ----------

/** The open device's row in the tree */
function markOpen() {
  for (const r of document.querySelectorAll('#netTree .nt-row[data-target]')) r.classList.toggle('selected', !!open && r.dataset.target === open);
}

function paintView() {
  const main = document.querySelector('.dev-main');
  main.dataset.mode = view;
  for (const b of document.querySelectorAll('.view-switch .seg')) b.setAttribute('aria-pressed', String(b.dataset.viewMode === view));
  if (view === 'tree') renderTree($('netTree'), { data, open, showDetail: (id) => showDetail(id) });
}

for (const b of document.querySelectorAll('.view-switch .seg')) {
  b.addEventListener('click', () => {
    view = b.dataset.viewMode;
    saveView(view);
    if (data) paintView();
  });
}

// ---------- wiring ----------

$('refresh').addEventListener('click', () => refresh(true));
// a device link on this tab (the sidebar's tree, a chip): open it here
window.addEventListener('hashchange', () => {
  if (isSettingsHash(location.hash)) return;
  const id = decodeURIComponent(location.hash.slice(1));
  if (data && id) showDetail(id);
});

initAlerts({ render: () => data && render(), reload: () => data && render() });
initCommandPalette({ refresh: () => refresh(true), showDevice: (id) => data && showDetail(id) });
void showProfile();
void showAccess();
refresh();
// Proxmox trends: the last hour for the sparklines, every minute (the server caches 60 s too)
const pollTrends = () => loadTrends('hour', { force: true }).then(() => data && render());
pollTrends();
setInterval(() => { if (!document.hidden) pollTrends(); }, 60_000);
setInterval(() => { if (!document.hidden) refresh(); }, 10_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
