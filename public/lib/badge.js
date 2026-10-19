// Badges and chips: the small pills on rows and cards (style.css .badge, .user-chip).

import { el } from './dom.js';
import { routedTitle } from './nettree.js';

/** <span class="badge tone">; tone: '', ok, info, warn, bad, new */
export function badge(text, tone = '') {
  return el('span', `badge ${tone}`, text);
}

/** What each kind of user chip is, for its tooltip */
export const USER_KIND = {
  tailnet: 'Tailscale 기기', lan: 'LAN 기기', local: '이 서버 안의 프로세스', self: '이 서버', pool: 'compute-pool 호스트', other: '기타 주소',
  routed: '서브넷 라우터를 거쳐 온 tailnet 기기. 출발 주소가 라우터 주소로 바뀌어서 원래 기기는 알 수 없어요.',
};

/** The 기기 tab's address for a device id (none: the tab itself) */
export const deviceHref = (id) => (id == null ? 'devices.html' : `devices.html#${encodeURIComponent(id)}`);

/** <a class="user-chip u-kind"> linking to the device on the 기기 tab */
export function userChip(text, kind, href, title) {
  const a = el('a', `user-chip u-${kind}`, text);
  a.href = href;
  if (title) a.title = title;
  return a;
}

/** Chip for someone connected now ({ kind, name, connections, id, via } from /api/usage byPort or the detail's usingNow) */
export function usingChip(u, { title = false } = {}) {
  // a subnet-routed chip always says which route it is: it links to the router, whose detail explains SNAT
  const tip = u.kind === 'routed' && u.viaName ? routedTitle(u.viaName, u.routes) : title ? USER_KIND[u.kind] : null;
  return userChip(u.connections > 1 ? `${u.name} ×${u.connections}` : u.name, u.kind, deviceHref(u.kind === 'local' ? null : u.via ?? u.id), tip);
}
