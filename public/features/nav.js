// The shell's sidebar on every page (lib/shell.js): the views' counts, 고정 (pinned ports) and 기기 (a status dot per
// device, linking to devices.html#id). Loaded on every page by the registry (src/features/ports.ts ui). What it shows,
// and the footer chips as they are when the page goes away, are kept in localStorage (pb.nav), and lib/shell-boot.js
// paints them on the next page before anything else, so a tab click keeps the same sidebar. A page that
// already fetched ports or devices shares them (lib/shell.js share); what nobody shared lately is fetched here once a
// minute, the 개발 and 설정 counts (worktrees, onboarding) every 5 minutes like onboarding.js.

import { tryJSON } from '../lib/api.js';
import { deviceHref } from '../lib/badge.js';
import { onShared, shell, sharedAt } from '../lib/shell.js';
import { flatten, nodeBadges, nodeSub, nodeTarget, nodeText } from '../lib/nettree.js';
import { POOL_STATE } from './devices.js';

const EVERY = 60_000;
const SLOW = 5 * 60_000;
let slowAt = 0;

/** The views' counts: 서비스 (ports the list shows by default), 기기 (online), 개발 (worktrees), 설정 (steps left) */
export function navCounts({ ports, devices, worktrees, onboarding }) {
  const out = {};
  if (ports) out.services = ports.ports.filter((p) => p.listening && p.visible).length;
  if (devices) out.devices = devices.devices.filter((d) => d.online).length;
  if (worktrees?.totals) out.dev = worktrees.totals.worktrees;
  if (onboarding) out.settings = onboarding.total - onboarding.ok || null;
  return out;
}

/** 고정: pinned ports, linking to their row on the 서비스 tab (which selects it) */
export function navPinned(ports) {
  return ports.ports.filter((p) => p.pinned).map((p) => ({
    key: p.port, text: p.name, sub: String(p.port), href: `./#${p.port}`,
    tone: p.listening ? null : 'warn', title: `${p.port} ${p.name}${p.listening ? '' : ' · 리스닝 없음'}`,
  }));
}

/**
 * 기기: the network tree (routers and Proxmox hosts → guests and routed LANs → LAN machines, then 직접 연결), one 24 px
 * row each with the dot the 기기 tab uses (compute-pool state, else online/offline) and small badges. depth, up (the
 * groups above it) and fold (it has rows under it) let lib/shell-boot.js indent and collapse it. Without a tree (an
 * older server): one flat line per device.
 */
export function navDevices(devices) {
  if (devices.tree?.roots?.length) return navTree(devices);
  return devices.devices.map((d) => {
    const [state, tone] = d.pool ? POOL_STATE[d.pool.state] ?? [d.pool.state, 'off'] : d.online ? ['온라인', 'ok'] : ['오프라인', 'off'];
    return { key: d.id, text: d.self ? `${d.name} (이 서버)` : d.name, tone, href: deviceHref(d.id), title: `${d.name} · ${state}` };
  });
}

function navTree(devices) {
  const byId = new Map(devices.devices.map((d) => [d.id, d]));
  const { rows, names } = flatten(devices.tree);
  return rows.map(({ node: n, depth, up, parent, router }) => {
    const d = n.device ? byId.get(n.device) : undefined;
    const [state, tone] = d?.pool ? POOL_STATE[d.pool.state] ?? [d.pool.state, 'off']
      : n.online === true ? ['온라인', 'ok'] : n.online === false ? ['오프라인', 'off']
      : n.kind === 'device' ? ['LAN', 'lan'] : ['', null];
    const target = nodeTarget(n);
    const text = nodeText(n, parent, names);
    const badges = nodeBadges(n, { router });
    const said = nodeBadges(n, { full: true, router }).map((b) => (b.title ? `${b.text} — ${b.title}` : b.text));
    const title = [text, n.kind === 'subnet' || n.kind === 'group' ? null : state, n.lanIps.join(', ') || null, ...said].filter(Boolean).join(' · ');
    return {
      key: n.key, text, sub: nodeSub(n), tone, href: target ? deviceHref(target) : null, title, target,
      depth, up, fold: n.children.length > 0, badges: badges.map((b) => b.text),
    };
  });
}

const data = { ports: null, devices: null, worktrees: null, onboarding: null };

/** The cache lib/shell-boot.js paints from: { counts, pinned, devices, chips } */
export const NAV_KEY = 'pb.nav';
const cache = (() => { try { return JSON.parse(localStorage.getItem(NAV_KEY) ?? 'null') ?? {}; } catch { return {}; } })();

/** The footer chips as they show now, for the next page's first paint */
export function chipState(doc = document) {
  const ob = doc.getElementById('obChip');
  const sw = doc.getElementById('swChip');
  return {
    ob: ob ? { hidden: ob.hidden, warn: ob.classList.contains('warn'), text: doc.getElementById('obText')?.textContent ?? '', title: ob.title } : null,
    sw: sw ? { hidden: sw.hidden, tone: sw.classList.contains('alarm') ? 'alarm' : sw.classList.contains('warn') ? 'warn' : null, text: doc.getElementById('swText')?.textContent ?? '' } : null,
  };
}

function save() {
  try { localStorage.setItem(NAV_KEY, JSON.stringify({ ...cache, chips: chipState() })); } catch {}
}

function paint() {
  const s = shell();
  if (!s) return;
  const counts = navCounts(data);
  s.setCounts(counts);
  cache.counts = { ...cache.counts, ...counts };
  if (data.ports) s.setPinned((cache.pinned = navPinned(data.ports)));
  if (data.devices) s.setDevices((cache.devices = navDevices(data.devices)));
  save();
  // the 서비스 tab's selected port, highlighted under 고정
  const sel = location.hash.replace(/^#/, '');
  for (const a of document.querySelectorAll('#sidePinned .side-item')) a.classList.toggle('selected', s.view === 'services' && a.dataset.key === sel);
  // the 기기 tab's open device, highlighted in the tree
  const open = decodeURIComponent(sel);
  for (const a of document.querySelectorAll('#sideDevices .side-item')) a.classList.toggle('selected', s.view === 'devices' && !!open && a.dataset.target === open);
}

async function load() {
  if (document.hidden) return;
  const stale = (key) => Date.now() - sharedAt(key) > EVERY / 2;
  // until a first answer, the slow ones are retried every minute (the worktree scan may still be running)
  const slow = Date.now() - slowAt > SLOW || !data.worktrees?.at;
  if (slow) slowAt = Date.now();
  const [ports, devices, worktrees, onboarding] = await Promise.all([
    stale('ports') ? tryJSON('/api/ports') : null,
    stale('devices') ? tryJSON('/api/devices') : null,
    slow ? tryJSON('/api/worktrees') : null,
    slow || !data.onboarding ? tryJSON('/api/onboarding') : null,
  ]);
  // the sidebar works with whatever answered
  Object.assign(data, Object.fromEntries(Object.entries({ ports, devices, worktrees, onboarding }).filter(([, v]) => v)));
  paint();
}

if (shell()) {
  onShared('ports', (v) => { data.ports = v; paint(); });
  onShared('devices', (v) => { data.devices = v; paint(); });
  window.addEventListener('hashchange', paint);
  // the chips' latest state, as the user leaves for another tab
  window.addEventListener('pagehide', save);
  document.addEventListener('shell:select', paint);
  // a moment first, so the page's own first fetches are shared instead of fetched twice
  setTimeout(load, 1000);
  setInterval(load, EVERY);
}
