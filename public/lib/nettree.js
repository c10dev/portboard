// @ts-check
// The network tree (src/core/nettree.ts: tree on GET /api/devices and /api/usage) in words, one copy for the sidebar's
// 기기 rows (features/nav.js) and the 기기 tab's 구조 view (features/nettree-view.js): what a row says, its badges,
// where a click goes, and the rows in order with their depth and the groups above them (for collapsing).

import { t } from './i18n.js';

/** The sidebar's collapsed groups (node keys); lib/shell-boot.js reads the same key. The 기기 tab keeps its own. */
export const FOLD_KEY = 'pb.navFold';
export const TAB_FOLD_KEY = 'pb.devTreeFold';

export const guestKind = (g) => (g.type === 'lxc' ? 'CT' : 'VM');

/** The 기기 tab's address for a node: its card (device id or lan:<ip>), else the Proxmox guest sheet */
export const nodeTarget = (n) => n.device ?? (n.guest ? `guest:${n.guest.node}/${n.guest.vmid}` : null);

/** How the tailnet reaches a LAN machine: [chip text, explanation] */
export function reachText(reach, router) {
  if (reach === 'tailnet') return [t('nettree.reach.tailnet'), t('nettree.reach.tailnet.why')];
  if (reach === 'routed') return [t('nettree.reach.routed', { router }), t('nettree.reach.routed.why', { router })];
  if (reach === 'arp') return [t('nettree.reach.arp'), t('nettree.reach.arp.why')];
  return ['', ''];
}

/** "LAN 192.168.1.0/24 · pve1가 라우팅" (standby: "… · 대기, 지금은 X가 라우팅") */
export function subnetLabel(n, routerName, names = new Map()) {
  const s = n.subnet;
  if (s.role === 'primary') return `${n.name} · ${t('nettree.routedBy', { router: routerName })}`;
  const primary = s.primary ? names.get(s.primary) ?? s.primary : null;
  return primary ? `${n.name} · ${t('nettree.standbyNow', { router: primary })}` : `${n.name} · ${t('nettree.standbyFor', { router: routerName })}`;
}

/** The sentence for a "pve1 경유" chip: routes are the router card's subnets */
export function routedTitle(router, routes = []) {
  const what = routes.length ? routes.join(', ') : 'LAN';
  return t('nettree.routedTitle', { what, router });
}

/** Small badges [{ text, tone, title }] for a row; full adds the ones the sidebar leaves to the tooltip */
export function nodeBadges(n, { full = false, router = '' } = {}) {
  const out = [];
  if (n.self) out.push({ text: t('common.thisServer'), tone: 'info' });
  if (n.guest?.lanOnly) out.push({ text: t('nettree.badge.lanOnly'), title: t('nettree.badge.lanOnly.title') });
  if ((n.kind === 'host' || n.kind === 'guest' || (n.kind === 'device' && !n.reach)) && n.online === false) {
    out.push({ text: t('devices.offline'), tone: 'off', title: n.guest?.status === 'running' ? t('nettree.badge.offline.running') : undefined });
  }
  if (n.guest && n.guest.status !== 'running' && n.online !== false) out.push({ text: n.guest.status, tone: 'off' });
  if (n.kind === 'subnet' && n.subnet.role === 'standby') out.push({ text: t('nettree.badge.standby'), tone: 'warn', title: t('nettree.badge.standby.title') });
  if (n.reach === 'routed') {
    const [text, title] = reachText('routed', router);
    out.push({ text: full ? text : t('nettree.badge.routed'), title });
  }
  if (n.reach === 'arp') {
    const [text, title] = reachText('arp');
    out.push({ text: full ? text : 'ARP', title });
  }
  if (full && n.reach === 'tailnet') {
    const [text, title] = reachText('tailnet');
    out.push({ text, tone: 'ok', title });
  }
  if (n.path?.type === 'relay') out.push({ text: 'DERP', title: t('nettree.badge.derp.title', { region: n.path.region }) });
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
