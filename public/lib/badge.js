// Badges and chips: the small pills on rows and cards (style.css .badge, .user-chip).

import { el } from './dom.js';
import { t } from './i18n.js';
import { routedTitle } from './nettree.js';

/** <span class="badge tone">; tone: '', ok, info, warn, bad, new */
export function badge(text, tone = '') {
  return el('span', `badge ${tone}`, text);
}

/** What each kind of user chip is, for its tooltip */
export const USER_KIND = {
  tailnet: t('badge.user.tailnet'), lan: t('badge.user.lan'), local: t('badge.user.local'), self: t('common.thisServer'), pool: t('badge.user.pool'), other: t('badge.user.other'),
  routed: t('badge.user.routed'),
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
