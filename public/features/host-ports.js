// Other machines' listening ports (compute-pool hosts, the Proxmox host and its containers, the desktop's Windows side;
// src/features/host-ports.ts), shared by the 서비스 and 기기 tabs. Each port comes from /api/devices or /api/usage as
// { port, scope, addresses, processes, tailnet, lan, url }.

import { el, extLink } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { agoMonths as ago, checkedAgo } from '../lib/time.js';

/** Where the port can be reached, as a short tag: [text, tone, title]. */
export function reachTag(p, deviceName) {
  if (p.scope === 'loopback') return [t('hostports.loopback'), 'warn', t('hostports.loopback.title', { addrs: p.addresses.join(', '), device: deviceName })];
  if (p.scope === 'other') return [p.addresses.join(', '), '', t('hostports.other.title')];
  if (p.tailnet) return ['tailnet', 'info', p.side === 'windows' ? t('hostports.tailnet.titleWin', { addrs: p.addresses.join(', ') }) : t('hostports.tailnet.title', { addrs: p.addresses.join(', ') })];
  if (p.lan) return ['LAN', 'info', t('hostports.lan.title', { addrs: p.addresses.join(', ') })];
  return [p.scope === 'all' ? t('hostports.all') : 'Tailscale IP', '', t('hostports.offTailnet.title', { addrs: p.addresses.join(', ') })];
}

/** "node, vite" or a hint that the host could not name it */
export function processText(p) {
  return p.processes.length ? p.processes.join(', ') : t('hostports.noProcess');
}

/** <ul> of ports: ":3000 node [tailnet] 열기 ↗". */
export function portList(ports, deviceName, { limit = Infinity } = {}) {
  const ul = el('ul', 'hports');
  for (const p of ports.slice(0, limit)) {
    const li = el('li');
    const name = el('span', 'hp-name');
    name.append(el('span', 'hp-port', `:${p.port}`));
    if (p.side) {
      const s = el('span', 'tag', p.side === 'windows' ? 'Windows' : 'WSL');
      s.title = p.side === 'windows' ? t('hostports.side.windows') : t('hostports.side.wsl');
      name.append(s);
    }
    name.append(el('span', p.processes.length ? 'hp-proc' : 'hp-proc unknown', processText(p)));
    const [text, tone, title] = reachTag(p, deviceName);
    const tag = el('span', `tag ${tone}`, text);
    tag.title = title;
    name.append(tag);
    li.append(name);
    if (p.url) {
      const a = extLink(t('hostports.open'), p.url, 'hp-open');
      a.title = p.url;
      a.addEventListener('click', (ev) => ev.stopPropagation());
      li.append(a);
    }
    ul.append(li);
  }
  if (ports.length > limit) ul.append(el('li', 'hp-more', t('hostports.more', { n: ports.length - limit })));
  return ul;
}

/** "Windows 12 · WSL 3" for a merged desktop list, else '' */
export function sidesText(ports) {
  if (!ports.sides) return '';
  const n = (side) => ports.ports.filter((p) => p.side === side).length;
  return `Windows ${n('windows')} · WSL ${ports.sides.wsl == null ? t('hostports.noInfo') : n('wsl')}`;
}

// ---- 서비스 tab: the host picker's view of another machine ----

/** The #remote box for a host from remoteHosts() (features/devices.js), filtered by the search text */
export function remoteView(d, needle) {
  const ports = d.ports.ports.filter((p) => !needle || [p.port, ...p.processes, ...p.addresses].join(' ').toLowerCase().includes(needle));
  const head = el('div', 'remote-head');
  const open = d.ports.ports.filter((p) => p.tailnet || p.lan).length;
  head.append(el('strong', null, d.label), el('span', null, t('hostports.remote.head', { state: d.state, n: d.ports.ports.length, open, checked: checkedAgo(d.ports.at) })));
  const note = el('p', 'remote-note', d.note);
  return [head, ports.length ? portList(ports, d.name) : el('p', 'empty', needle ? t('hostports.noMatch') : t('hostports.noPorts')), note];
}

// ---- 기기 tab: "열린 포트 N" on cards and the readers' setup hints ----

/** "pve에서 읽음" / "agent" / "compute-pool": where a card's port list came from */
export function portsFrom(c, data) {
  if (c.portsSource === 'agent') return t('hostports.fromAgent');
  return c.portsSource === 'pve-ssh' ? t('hostports.readFrom', { node: data.pvePorts?.node ?? t('devices.pveHost') }) : 'compute-pool';
}

const AGENT_ERROR = { unreachable: 'hostports.err.unreachable', timeout: 'hostports.err.timeout', auth: 'hostports.agent.err.auth', http: 'hostports.agent.err.http', 'bad-answer': 'hostports.agent.err.badAnswer' };

/** A device's `portboard agent` in one line: "v1.1.0 · load 0.42 · 3.1/7.8 GB free · disk 52% free", or why it isn't answering */
export function agentLine(a) {
  if (!a) return '';
  if (a.pending) return t('hostports.agent.pending');
  if (!a.ok) {
    const lastOk = a.lastOk ? ` · ${t('hostports.lastOk', { t: ago(new Date(a.lastOk).toISOString()) })}` : '';
    return t('hostports.agent.failed', { error: t(AGENT_ERROR[a.error] ?? 'hostports.err.other'), lastOk });
  }
  const l = a.info?.load;
  const gb = (mb) => (mb / 1024).toFixed(1);
  return [
    a.info ? `v${a.info.version}` : null,
    l ? t('hostports.agent.load', { load: l.load1, cores: l.cores }) : null,
    l?.memAvailMb != null && l.memTotalMb ? t('hostports.agent.mem', { avail: gb(l.memAvailMb), total: gb(l.memTotalMb) }) : null,
    l?.diskFreePct != null ? t('hostports.agent.disk', { pct: l.diskFreePct }) : null,
  ].filter(Boolean).join(' · ');
}

/** card ids whose port list the user folded */
const foldedPorts = new Set();

/** "열린 포트 N" with the list, for a compute-pool host or a Proxmox host/container (other machines only). */
export function portsBox(c, data) {
  if (!c.ports) {
    // an agent host whose worker predates port reporting
    if (c.pool?.kind === 'agent' && c.pool.agent?.connected) return el('div', 'hports-none', t('hostports.noWorker'));
    return null;
  }
  const d = el('details', 'hports-box');
  d.open = !foldedPorts.has(c.id);
  d.addEventListener('toggle', () => (d.open ? foldedPorts.delete(c.id) : foldedPorts.add(c.id)));
  const sum = el('summary');
  const open = c.ports.ports.filter((p) => p.tailnet || p.lan).length;
  const where = c.ports.ports.some((p) => p.lan) ? t('hostports.sum.lan', { n: open }) : t('hostports.sum.tailnet', { n: open });
  sum.append(el('strong', null, t('hostports.sum.open', { n: c.ports.ports.length })));
  const sides = sidesText(c.ports);
  sum.append(document.createTextNode(` · ${sides ? `${sides} · ` : ''}${where} · ${c.portsSource === 'pve-ssh' || c.portsSource === 'agent' ? `${portsFrom(c, data)} · ` : ''}${checkedAgo(c.ports.at)}`));
  sum.addEventListener('click', (ev) => ev.stopPropagation());
  d.append(sum, portList(c.ports.ports, c.name, { limit: 12 }));
  return d;
}

/** Fill a hint box: the text, plus "설치 방법 ↗" when setup is what's missing */
function hint(box, text, setupUrl) {
  box.replaceChildren();
  if (!text) { box.hidden = true; return; }
  box.append(document.createTextNode(text));
  if (setupUrl) box.append(document.createTextNode(' '), extLink(t('hostports.setup'), setupUrl));
  box.hidden = false;
}

const READ_ERROR = { unreachable: 'hostports.err.unreachable', timeout: 'hostports.err.timeout' };

/** The Proxmox host's SSH port reader: why it hasn't read yet, a setup hint until the key is installed, then only problems. */
export function renderPortsHint(box, pp) {
  const node = pp?.node ?? 'Proxmox';
  const lastOk = pp?.lastOk ? ` · ${t('hostports.lastOk', { t: ago(new Date(pp.lastOk).toISOString()) })}` : '';
  const text = !pp || !pp.enabled ? ''
    : pp.pending ? (pp.reason ? t('hostports.pve.pending', { node, reason: pp.reason }) : '')
    : pp.error === 'not-installed' ? t('hostports.pve.notInstalled', { node })
    : pp.error === 'no-key' ? t('hostports.pve.noKey', { node })
    : pp.error === 'host-key' ? t('hostports.pve.hostKey', { node })
    : pp.error === 'bad-config' ? t('hostports.pve.badConfig')
    : pp.error === 'bad-output' ? t('hostports.pve.badOutput', { node })
    : pp.error ? t('hostports.pve.failed', { node, error: t(READ_ERROR[pp.error] ?? 'hostports.err.other'), lastOk })
    : pp.unmatched?.length ? t('hostports.pve.unmatched', { ids: pp.unmatched.join(', ') })
    : '';
  hint(box, text, text && (pp.error === 'not-installed' || pp.error === 'no-key') ? pp.setupUrl : null);
}

/** The desktop's Windows-side reader: why it hasn't read yet, the setup hint until the user is set and the key works, then only problems. */
export function renderWinHint(box, wp) {
  const dev = wp?.device ?? 'Windows';
  const text = !wp || !wp.enabled ? ''
    : wp.pending ? (wp.reason ? t('hostports.win.pending', { dev, reason: wp.reason }) : '')
    : wp.error === 'no-user' || wp.error === 'not-installed' ? t('hostports.win.notInstalled', { dev })
    : wp.error === 'no-key' ? t('hostports.win.noKey', { dev })
    : wp.error === 'host-key' ? t('hostports.win.hostKey', { dev })
    : wp.error === 'bad-config' ? t('hostports.win.badConfig')
    : wp.error === 'bad-output' ? t('hostports.win.badOutput', { dev })
    : wp.error ? t('hostports.win.failed', { dev, error: t(READ_ERROR[wp.error] ?? 'hostports.err.other'), lastOk: wp.lastOk ? ` · ${t('hostports.lastOk', { t: ago(new Date(wp.lastOk).toISOString()) })}` : '' })
    : '';
  hint(box, text, text && ['no-user', 'not-installed', 'no-key'].includes(wp.error) ? wp.setupUrl : null);
}
