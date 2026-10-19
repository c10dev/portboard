// The network tree (src/core/nettree.ts: tree on GET /api/devices and /api/usage) in words, one copy for the sidebar's
// 기기 rows (features/nav.js) and the 기기 tab's 구조 view (features/nettree-view.js): what a row says, its badges,
// where a click goes, and the rows in order with their depth and the groups above them (for collapsing).

/** The sidebar's collapsed groups (node keys); lib/shell-boot.js reads the same key. The 기기 tab keeps its own. */
export const FOLD_KEY = 'pb.navFold';
export const TAB_FOLD_KEY = 'pb.devTreeFold';

export const guestKind = (g) => (g.type === 'lxc' ? 'CT' : 'VM');

/** The 기기 tab's address for a node: its card (device id or lan:<ip>), else the Proxmox guest sheet */
export const nodeTarget = (n) => n.device ?? (n.guest ? `guest:${n.guest.node}/${n.guest.vmid}` : null);

/** How the tailnet reaches a LAN machine: [chip text, explanation] */
export function reachText(reach, router) {
  if (reach === 'tailnet') return ['tailnet 직접', '자기 Tailscale 주소가 있어서 tailnet에서 바로 열려요.'];
  if (reach === 'routed') return [`${router} 경유로만`, `Tailscale이 없어요. tailnet에서는 ${router}가 라우팅하는 LAN 주소로만 닿아요.`];
  if (reach === 'arp') return ['ARP로만 확인', '이 서버의 ARP 표에만 보여요. 이 서버에 접속한 적은 없어요.'];
  return ['', ''];
}

/** "LAN 192.168.1.0/24 · pve1가 라우팅" (standby: "… · 대기, 지금은 X가 라우팅") */
export function subnetLabel(n, routerName, names = new Map()) {
  const s = n.subnet;
  if (s.role === 'primary') return `${n.name} · ${routerName}가 라우팅`;
  const primary = s.primary ? names.get(s.primary) ?? s.primary : null;
  return primary ? `${n.name} · 대기 (지금은 ${primary}가 라우팅)` : `${n.name} · ${routerName} 대기`;
}

/** The sentence for a "pve1 경유" chip: routes are the router card's subnets */
export function routedTitle(router, routes = []) {
  const what = routes.length ? routes.join(', ') : 'LAN';
  return `${what}를 ${router}이 라우팅해서 출발지가 ${router}로 보여요. 원래 기기는 여기서 알 수 없어요.`;
}

/** Small badges [{ text, tone, title }] for a row; full adds the ones the sidebar leaves to the tooltip */
export function nodeBadges(n, { full = false, router = '' } = {}) {
  const out = [];
  if (n.self) out.push({ text: '이 서버', tone: 'info' });
  if (n.guest?.lanOnly) out.push({ text: 'LAN 전용', title: 'Tailscale이 없는 게스트예요. LAN 주소로만 열려요.' });
  if ((n.kind === 'host' || n.kind === 'guest' || (n.kind === 'device' && !n.reach)) && n.online === false) {
    out.push({ text: '오프라인', tone: 'off', title: n.guest?.status === 'running' ? 'tailnet에서는 오프라인, Proxmox에서는 실행 중이에요.' : undefined });
  }
  if (n.guest && n.guest.status !== 'running' && n.online !== false) out.push({ text: n.guest.status, tone: 'off' });
  if (n.kind === 'subnet' && n.subnet.role === 'standby') out.push({ text: '대기', tone: 'warn', title: '같은 서브넷을 광고하지만 지금은 다른 라우터가 쓰여요 (HA 대기).' });
  if (n.reach === 'routed') {
    const [text, title] = reachText('routed', router);
    out.push({ text: full ? text : '경유', title });
  }
  if (n.reach === 'arp') {
    const [text, title] = reachText('arp');
    out.push({ text: full ? text : 'ARP', title });
  }
  if (full && n.reach === 'tailnet') {
    const [text, title] = reachText('tailnet');
    out.push({ text, tone: 'ok', title });
  }
  if (n.path?.type === 'relay') out.push({ text: 'DERP', title: `DERP 릴레이(${n.path.region})로 연결돼요` });
  return out;
}

/** The row's own name: a subnet says who routes it; a guest keeps its Proxmox name */
export function nodeText(n, parent, names) {
  if (n.kind === 'subnet') return subnetLabel(n, names.get(n.subnet.router) ?? parent?.name ?? n.subnet.router, names);
  return n.name;
}

/** The muted text after the name: VM 205 / CT 204, a LAN address */
export function nodeSub(n) {
  if (n.guest) return `${guestKind(n.guest)} ${n.guest.vmid}`;
  if (n.reach || n.kind === 'device') return n.lanIps[0] ?? '';
  return '';
}

/**
 * Rows depth first: { node, depth, up (the keys of every group above), parent, router (the name of the router whose
 * LAN it is in) }. names: device id → name, for the routers named in subnets.
 */
export function flatten(tree) {
  const rows = [];
  const names = new Map();
  const walk = (nodes, depth, up, parent, router) => {
    for (const node of nodes) {
      if (node.device) names.set(node.device, node.name);
      const r = node.kind === 'subnet' ? parent?.name ?? router : router;
      rows.push({ node, depth, up, parent, router });
      if (node.children.length) walk(node.children, depth + 1, [...up, node.key], node, r);
    }
  };
  walk(tree?.roots ?? [], 0, [], null, '');
  return { rows, names };
}

/** The collapsed keys, as remembered (storage may be missing or blocked) */
export function loadFolded(key = FOLD_KEY, storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(key) ?? 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function saveFolded(folded, key = FOLD_KEY, storage = globalThis.localStorage) {
  try { storage?.setItem(key, JSON.stringify(folded)); } catch {}
}
