// 기기 tab, 구조 view: the network tree (GET /api/usage tree, src/core/nettree.ts) with a line of detail per machine —
// OS, addresses, how the tailnet reaches it, direct or DERP, its listening ports and the 사용 중 chip — next to the
// cards (카드). A row opens that device's card detail, a Proxmox guest's sheet, or (a LAN address with neither) a
// short sheet of what is known. Groups fold; what is folded is remembered per browser (lib/nettree.js TAB_FOLD_KEY).

import { POOL_STATE } from './devices.js';
import { osName } from './usage.js';
import { routedTitle, flatten, guestKind, loadFolded, nodeBadges, nodeTarget, nodeText, reachText, saveFolded, TAB_FOLD_KEY } from '../lib/nettree.js';
import { dl, el } from '../lib/dom.js';

const VIEW_KEY = 'pb.devView';

/** 구조 or 카드, as last chosen (구조 first) */
export function loadView() {
  try { return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'tree'; } catch { return 'tree'; }
}

export function saveView(v) {
  try { localStorage.setItem(VIEW_KEY, v); } catch {}
}

/** The tree's node for a 기기 tab address (a card id, lan:<ip>, guest:<node>/<vmid>) */
export function findNode(tree, target) {
  return flatten(tree).rows.find((r) => nodeTarget(r.node) === target) ?? null;
}

const pathText = (p) => (p?.type === 'direct' ? '직결' : p?.type === 'relay' ? `DERP ${p.region}` : null);

/** The dot's tone, as the cards and the sidebar: compute-pool state, else online/offline; LAN-only has an open ring */
function toneOf(n, card) {
  if (card?.pool) return (POOL_STATE[card.pool.state] ?? [null, 'off'])[1];
  if (n.online === true) return 'ok';
  if (n.online === false) return 'off';
  return n.kind === 'device' ? 'lan' : null;
}

/** The meta line under a machine's name */
function metaBits(n, card, router) {
  const bits = [];
  const os = card ? osName(card) : n.os;
  if (os) bits.push(os);
  if (n.guest) bits.push(`${guestKind(n.guest)} ${n.guest.vmid}${n.guest.status !== 'running' ? ` · ${n.guest.status}` : ''}`);
  // running on Proxmox, gone from the tailnet: the VM is up, only its Tailscale isn't
  if (n.guest?.status === 'running' && n.online === false) bits.push('Proxmox에서는 실행 중');
  const ips = [...n.lanIps, ...n.tailscaleIps.filter((ip) => ip.includes('.'))];
  if (ips.length) bits.push(ips.join(' · '));
  if (n.reach === 'routed') bits.push(`${router} 경유`);
  const path = pathText(n.path);
  if (path) bits.push(path);
  if (n.ports != null) bits.push(`포트 ${n.ports}개`);
  return bits;
}

/** 사용 중: what this machine uses on this server now; 경유: what came through it as the subnet router */
function useChips(card) {
  if (!card) return [];
  const out = [];
  const own = card.uses.filter((u) => !u.routed);
  const via = card.uses.filter((u) => u.routed);
  if (own.length) {
    const c = el('span', 'nt-use', `사용 중 ${own.length}`);
    c.title = own.map((u) => `${u.service} :${u.port}`).join(', ');
    out.push(c);
  }
  if (via.length) {
    const c = el('span', 'nt-use routed', `${card.name} 경유 ${via.reduce((a, u) => a + u.connections, 0)}`);
    c.title = routedTitle(card.name, card.routes);
    out.push(c);
  }
  return out;
}

/**
 * Paints the tree into box. ctx: { data (usage), open (the 기기 tab address shown now), showDetail(target) }.
 * Returns the number of rows.
 */
export function renderTree(box, ctx) {
  const data = ctx.data;
  const cards = new Map(data.cards.map((c) => [c.id, c]));
  const { rows, names } = flatten(data.tree);
  if (!rows.length) {
    box.replaceChildren(el('p', 'muted nt-empty', '아직 구조를 그릴 기기가 없어요. Tailscale이 켜져 있는지 확인해 보세요.'));
    return 0;
  }
  const folded = loadFolded(TAB_FOLD_KEY);
  const list = el('div', 'nt-list');
  list.setAttribute('role', 'tree');
  list.setAttribute('aria-label', '네트워크 구조');
  for (const { node: n, depth, up, parent, router } of rows) {
    const card = n.device ? cards.get(n.device) : undefined;
    const target = nodeTarget(n);
    const group = n.kind === 'subnet' || n.kind === 'group';
    const row = el('div', `nt-row k-${n.kind}${group ? ' nt-group' : ''}`);
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.style.setProperty('--d', String(depth));
    row.dataset.key = n.key;
    row.dataset.up = up.join(' ');
    row.hidden = up.some((k) => folded[k]);
    if (target) row.dataset.target = target;
    if (n.children.length) row.setAttribute('aria-expanded', folded[n.key] ? 'false' : 'true');

    const fold = el(n.children.length ? 'button' : 'span', n.children.length ? 'nt-fold' : 'nt-fold-pad');
    if (n.children.length) {
      fold.type = 'button';
      fold.setAttribute('aria-label', `${nodeText(n, parent, names)} 접기·펼치기`);
      fold.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const f = loadFolded(TAB_FOLD_KEY);
        if (f[n.key]) delete f[n.key];
        else f[n.key] = 1;
        saveFolded(f, TAB_FOLD_KEY);
        renderTree(box, ctx);
      });
    }
    row.append(fold);

    if (group) {
      const head = el('div', 'nt-head');
      head.append(el('strong', 'nt-name', nodeText(n, parent, names)));
      const count = [...walkCount(n)];
      head.append(el('span', 'nt-count', `${count.length}대`));
      for (const b of nodeBadges(n, { full: true, router })) head.append(badge(b));
      row.append(head);
      if (n.kind === 'subnet') {
        row.title = n.subnet.role === 'primary'
          ? `tailnet 기기가 ${n.subnet.cidr} 주소로 접속하면 ${names.get(n.subnet.router) ?? n.subnet.router}가 받아서 LAN으로 보내요${n.subnet.standby.length ? ` · 대기: ${n.subnet.standby.map((s) => names.get(s) ?? s).join(', ')}` : ''}`
          : '같은 서브넷을 광고하는 대기 라우터예요. 지금 라우팅하는 라우터 쪽에 LAN 기기가 있어요.';
      }
      row.addEventListener('click', () => fold.click?.());
    } else {
      const tone = toneOf(n, card);
      const main = el('div', 'nt-main');
      const line = el('div', 'nt-line');
      line.append(el('span', `dot${tone ? ` t-${tone}` : ''}`), el('strong', 'nt-name', n.name));
      for (const b of nodeBadges(n, { full: true, router })) line.append(badge(b));
      line.append(...useChips(card));
      main.append(line, el('div', 'nt-meta', metaBits(n, card, router).join(' · ')));
      row.append(main);
      if (target) {
        row.tabIndex = 0;
        row.classList.add('tappable');
        const open = () => ctx.showDetail(target);
        row.addEventListener('click', open);
        row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
      }
      if (ctx.open && ctx.open === target) row.classList.add('selected');
    }
    list.append(row);
  }
  box.replaceChildren(list);
  return rows.length;
}

function* walkCount(n) {
  for (const c of n.children) {
    if (c.kind !== 'subnet' && c.kind !== 'group') yield c;
    yield* walkCount(c);
  }
}

function badge(b) {
  const s = el('span', `badge ${b.tone ?? ''}`, b.text);
  if (b.title) s.title = b.title;
  return s;
}

/** The sheet for a tree row with no card (a LAN address only the ARP table or a name knows) */
export function nodeDetail(row) {
  const n = row.node;
  const [reach, why] = reachText(n.reach, row.router);
  return [
    el('div', 'd-kicker', 'LAN 기기'),
    el('h3', 'd-title', n.name),
    dl([
      ['LAN IP', n.lanIps.join(', ')],
      ['어떻게 닿나', reach ? `${reach} — ${why}` : null],
      ['서브넷', row.parent?.subnet ? `${row.parent.subnet.cidr} · ${row.router}가 라우팅` : null],
    ]),
    el('p', 'muted', '지금 이 서버에 연결돼 있지 않아서 카드가 없어요. 이 서버에 접속하면 카드와 사용 기록이 생겨요.'),
  ];
}
