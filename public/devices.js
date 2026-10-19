// 기기 tab: the network tree (구조, features/nettree-view.js) or one card per device with what it is using on this
// server right now (카드; GET /api/usage, src/features/usage.ts), and the detail panel. The cards are
// features/usage.js, 새 기기 features/known.js, Proxmox hosts and guests features/proxmox.js, other machines' ports
// features/host-ports.js.

import { done } from './lib/shell.js'; // first: the bar, sidebar and inspector are wired before anything looks them up
import { canWatchDevice, deviceWatched, initAlerts, setDeviceAlert } from './features/alerts.js';
import { portList, renderPortsHint, renderWinHint, sidesText } from './features/host-ports.js';
import { newBlock, renderNewDevices, renderSettings, short } from './features/known.js';
import { findNode, loadView, nodeDetail, renderTree, saveView } from './features/nettree-view.js';
import { initCommandPalette } from './features/palette.js';
import { dayBlock, findGuest, guestDetail, hostLine, loadTrends, pveRef } from './features/proxmox.js';
import { prefill, prefillHint } from './features/suggestions.js';
import { card, hist, idleChip, idleServices, localText, osName, pastChip, poolLine } from './features/usage.js';
import { getJSON, postOrThrow } from './lib/api.js';
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
    setStatus(`불러오기 실패: ${err.message}`, true);
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

  let head = own.length ? `지금 기기 ${own.length}대가 서비스 ${services.size}개를 쓰는 중` : '지금 이 서버를 쓰는 기기가 없어요';
  if (routed.length) {
    const by = [...new Set(routed.map((x) => x.c.name))].join(', ');
    head += ` · ${by} 경유 ${routed.reduce((a, x) => a + x.u.connections, 0)}개`;
  }
  $('headline').textContent = head;
  $('headline').title = [...new Set(routed.map((x) => x.c))].map((c) => routedTitle(c.name, c.routes)).join('\n');
  const pve = data.proxmox;
  const hint = !pve.configured
    ? 'Proxmox 토큰을 넣으면 VM/CT 트리를 보여줘요 (~/.config/portboard/proxmox.json)'
    : !pve.ok ? `Proxmox: ${pve.error}` : pve.looseMode ? 'proxmox.json을 다른 사용자도 읽을 수 있어요: chmod 600 권장' : '';
  $('pveHint').textContent = hint;
  $('pveHint').hidden = !hint;
  renderPortsHint($('pvePortsHint'), data.pvePorts);
  renderWinHint($('winPortsHint'), data.winPorts);
  setStatus(`${new Date(data.at).toLocaleTimeString()} 기준 · 10초마다 갱신`);

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
  $('idleH').textContent = `지금 안 쓰는 기기 · ${idleCount}`;
  $('idleH').hidden = $('idle').hidden = idleCount === 0;
  $('idle').replaceChildren(...idle.map((c) => idleChip(c, ctx)), ...past.map(([id, d]) => pastChip(id, d, ctx)));

  $('idleSvcH').textContent = `아무도 안 쓰는 서비스 · ${data.idleServices}`;
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
    ? { title: '지금 이 서버에 연결한 기기가 없어요.', text: '다른 기기에서 서비스를 열면 카드가 생겨요. 아래는 지금 안 쓰는 기기예요.' }
    : { title: '아직 아는 기기가 없어요.', text: '기기는 Tailscale(tailscale status), compute-pool 호스트, 이 서버로 들어온 연결(LAN은 ip neigh)에서 와요. 이 서버의 Tailscale이 켜져 있는지 확인해 보세요.' });
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
  body.append(el('div', 'd-kicker', { self: '이 서버', tailnet: 'Tailscale 기기', pool: 'compute-pool 호스트', lan: 'LAN 기기', funnel: 'Tailscale Funnel (인터넷 공개)', other: '기타 주소' }[c.kind]));
  body.append(el('h3', 'd-title', c.name));
  if (c.newDevice) body.append(newBlock(c, ctx));
  const rows = [
    ['이름 출처', { user: '직접 붙인 이름', tailscale: 'Tailscale', pool: 'compute-pool', proxmox: 'Proxmox 게스트 이름', vendor: 'MAC 제조사로 추정', ip: '주소', funnel: 'Tailscale Funnel' }[c.nameSource]],
    ['OS', osName(c)],
    ['상태', c.kind === 'lan' || c.kind === 'funnel' ? null : c.online ? '온라인' : `오프라인${c.lastSeen ? ` · ${ago(c.lastSeen)}` : ''}`],
    ['Tailscale 경로', c.path?.type === 'direct' ? `직결 ${c.path.endpoint}` : c.path?.type === 'relay' ? `릴레이 (${c.path.region})` : null],
    ['Tailscale IP', c.tailscaleIps.join('\n')],
    ['LAN IP', c.lanIps.join(', ') || (c.kind === 'lan' ? c.addresses.join(', ') : null)],
    ['지금 들어온 주소', c.addresses.join(', ')],
    ['MAC', c.mac ? `${c.mac}${c.randomMac ? ' (개인 Wi-Fi 주소)' : ''}` : null],
    ['제조사', c.vendor],
    ['compute-pool', c.pool ? poolLine(c.pool) : null],
    ['pool 연결 방식', c.pool && c.poolMatch ? { self: '이 서버', address: 'Tailscale 주소', link: 'prefs.json deviceLinks' }[c.poolMatch] : null],
    ['LAN 주소 확인', Object.entries(c.lanVia ?? {}).map(([ip, via]) => `${ip}: ${{ 'compute-pool': 'compute-pool 설정', 'ssh-hostkey': 'SSH 호스트 키가 같음', proxmox: 'Proxmox' }[via] ?? via}`).join('\n')],
    ['서브넷 라우터', c.routes.join(', ')],
    ['가상화', c.virt && c.virt.type !== 'none' ? `${c.virt.type}${c.virt.proxmoxMac ? ' · Proxmox MAC(BC:24:11)' : ''}` : null],
    ['Proxmox', c.guestOf ? `${c.guestOf.node}의 ${c.guestOf.type === 'lxc' ? 'CT' : 'VM'} ${c.guestOf.vmid} · ${c.guestOf.status}` : null],
    ['Proxmox 호스트', c.pveHost ? hostLine(c.pveHost) : null],
    ['마지막 사용', hist(data).byDevice[c.id] ? `${ago(hist(data).byDevice[c.id].lastSeen)} · ${new Date(hist(data).byDevice[c.id].lastSeen).toLocaleString()}` : null],
  ];
  body.append(dl(rows));
  const ref = pveRef(c);
  if (ref) body.append(dayBlock(ref, ref.vmid != null ? `${c.guestOf.node}의 ${c.guestOf.type === 'lxc' ? 'CT' : 'VM'} ${ref.vmid}` : `노드 ${ref.node}`, () => open === id && showDetail(id)));
  if (c.kind !== 'self' && c.ports) {
    const box = el('div', 'd-use');
    const h = el('div', 'd-use-h');
    h.append(el('strong', null, `${c.name}에 열린 포트 ${c.ports.ports.length}개`), el('span', 'use-port', checkedAgo(c.ports.at)));
    box.append(h, c.ports.ports.length ? portList(c.ports.ports, c.name) : el('p', 'muted', '열린 TCP 포트가 없어요.'));
    if (c.ports.sides) box.append(el('p', 'muted small', `${sidesText(c.ports)}. Windows 쪽은 Windows OpenSSH의 읽기 전용 키로(1분마다), WSL 쪽은 compute-pool이 읽어요. WSL 포트를 Windows localhost로 넘겨 주는 소켓(wslrelay)은 WSL 줄 하나로 합쳤어요.`));
    box.append(el('p', 'muted small', c.portsSource === 'pve-ssh'
      ? `${data.pvePorts?.node ?? 'Proxmox 호스트'}에서 읽기 전용 SSH 키로 읽은 목록이에요 (ss -ltn, 1분마다). tailnet 표시는 Tailscale 이름으로, LAN 표시는 LAN 주소로 열 수 있다는 뜻이에요 (${data.pvePorts?.node ?? 'Proxmox 호스트'}가 LAN을 tailnet에 라우팅). "그 기기 안에서만"은 그 기기 안의 프로그램만 쓸 수 있어요.`
      : 'compute-pool이 알려 준 목록이에요. tailnet 표시는 Tailscale 이름으로 바로 열 수 있다는 뜻이고, "그 기기 안에서만"은 그 기기 안의 프로그램만 쓸 수 있어요.'));
    body.append(box);
  } else if (c.kind !== 'self' && c.pool?.kind === 'agent' && c.pool.agent?.connected) {
    body.append(el('p', 'muted', '이 기기의 worker가 포트를 알려 주지 않아요. 새 cpool로 업데이트하면 보여요 (compute-pool docs/install.md, Updating the Mac worker).'));
  }
  const recent = hist(data).byDevice[c.kind === 'self' ? 'local' : c.id]?.recent ?? [];
  if (recent.length) {
    const box = el('div', 'd-recent');
    box.append(el('div', 'd-recent-h', '최근 7일'));
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
        const tag = el('span', 'tag', `${c.name} 경유`);
        tag.title = routedTitle(c.name, c.routes);
        h.append(tag);
      }
      if (u.url?.startsWith('http')) h.append(extLink('열기 ↗', u.url, 'd-open'));
      box.append(h, dl([
        ['경로', u.via === 'serve' ? `tailscale ${c.kind === 'funnel' ? 'funnel' : 'serve'} :${u.servePort} → :${u.port}` : null],
        ['연결', `${u.connections}개`],
        ['서버→기기', bytes(u.bytesSent)],
        ['기기→서버', bytes(u.bytesReceived)],
        ['RTT', u.rttMs != null ? `${u.rttMs} ms` : null],
        ['언제부터', sinceText(u)],
        ['처음 사용', u.firstSeen && u.firstSeen < u.since ? firstText(u.firstSeen) : null],
        ['프로세스', u.processes.join(', ')],
        ['서비스 전체 이름', u.fullName !== u.service ? u.fullName : null],
      ]));
      body.append(box);
    }
  } else {
    body.append(el('p', 'muted', '지금 이 서버에서 쓰는 서비스가 없어요.'));
  }
  if (c.nameKey) {
    const b = el('button', 'name-btn', c.nameSource === 'user' ? '이름 바꾸기' : '이름 붙이기');
    b.dataset.write = '1';
    b.type = 'button';
    b.addEventListener('click', () => nameDevice(c));
    body.append(b);
  }
  if (canWatchDevice(c)) {
    const on = deviceWatched(c.id);
    const b = el('button', 'name-btn alert-btn', on ? '🔔 오프라인 알림 끄기' : '🔔 오프라인 알림 켜기');
    b.dataset.write = '1';
    b.type = 'button';
    b.title = 'tailnet에서 오프라인이 되면(1분 넘게) iPhone 등으로 알림. compute-pool 호스트는 compute-pool이 따로 알려요.';
    b.addEventListener('click', () => setDeviceAlert(c.id, !on));
    body.append(b);
  }
}

/** since is the persisted start of this run of use when Portboard has it, else when this process first saw the connection. */
function sinceText(u) {
  const bound = u.since === data.observingSince || u.since === hist(data).startedAt;
  return bound ? `${ago(u.since)} 이전부터 (기록 시작 시점)` : `${ago(u.since)}부터 · ${new Date(u.since).toLocaleString()}`;
}

function firstText(t) {
  return t === hist(data).startedAt ? `${ago(t)} 이전 (기록 시작 시점)` : `${ago(t)} · ${new Date(t).toLocaleString()}`;
}

function routedExplain(c) {
  const self = data.cards.find((x) => x.kind === 'self');
  const lan = Object.keys(c.lanVia ?? {})[0] ?? c.addresses[0];
  const why = el('div', 'explain');
  why.append(
    el('strong', null, `${c.name}을(를) 거쳐 온 연결`),
    el('p', null, `${c.name}은(는) tailnet에 ${c.routes.join(', ')}을(를) 열어 주는 서브넷 라우터예요. 다른 tailnet 기기가 이 서버의 LAN 주소(${data.selfLanIps?.[0] ?? '192.168.1.x'})로 접속하면, ${c.name}이(가) 출발 주소를 자기 LAN 주소(${lan})로 바꿔서(SNAT) 보내요. 그래서 여기서는 원래 어느 기기였는지 알 수 없고, ${c.name} 자신이 연결한 것과도 구별되지 않아요.`),
    el('p', null, '원래 기기가 보이게 하려면:'),
  );
  const ol = el('ol');
  ol.append(
    el('li', null, `그 기기에서 이 서버를 Tailscale 이름이나 IP로 접속하기 (${self?.name ?? '이 서버'}, ${self?.tailscaleIps?.[0] ?? '100.x'}). 가장 간단해요.`),
    el('li', null, `${c.name}에서 SNAT 끄기: tailscale set --snat-subnet-routes=false. 이때는 LAN 쪽(공유기나 이 서버)에 100.64.0.0/10 → ${lan} 경로가 있어야 응답이 돌아가요.`),
  );
  why.append(ol);
  return why;
}

// ---------- naming ----------

async function nameDevice(c) {
  const hint = c.vendor ? ` (제조사: ${short(c.vendor)})` : '';
  const next = window.prompt(`${c.addresses[0] ?? c.id} 이름${hint}${prefillHint(c)}\n비우면 자동 이름으로 돌아가요.`, prefill(c));
  if (next === null) return;
  try {
    const body = await postOrThrow('/api/clients/name', { key: c.nameKey, name: next.trim() || null });
    say(body.name ? `"${body.name}"(으)로 저장했어요` : '이름을 지웠어요');
    await refresh(true);
  } catch (err) {
    say(`저장 실패: ${err.message}`, true);
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
