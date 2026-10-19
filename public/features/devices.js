// Devices (GET /api/devices, src/features/devices.ts) on the 서비스 tab: the strip of device cards above the port
// list, and the other machines whose ports the host picker can show. POOL_STATE is shared with the 기기 tab.

import { el } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { ago, isJustNow } from '../lib/time.js';

/** compute-pool host state → [text, tone] */
export const POOL_STATE = {
  ok: [t('devices.pool.ok'), 'ok'],
  degraded: [t('devices.pool.degraded'), 'warn'],
  'wsl-down': [t('devices.pool.wslDown'), 'bad'],
  'host-down': [t('devices.pool.hostDown'), 'bad'],
  auth: [t('devices.pool.auth'), 'bad'],
  'agent-away': [t('devices.pool.agentAway'), 'off'],
  'agent-busy': [t('devices.pool.agentBusy'), 'warn'],
  unknown: [t('devices.pool.unknown'), 'off'],
};

/** One small card per device: name, state, load; hover for addresses, runners and the last 24 h of runs */
export function deviceStrip(doc) {
  return doc.devices.map((d) => {
    const pool = d.pool;
    const [stateText, tone] = pool ? POOL_STATE[pool.state] ?? [pool.state, 'off'] : d.online ? [t('devices.online'), 'ok'] : [t('devices.offline'), 'off'];
    const card = el('div', `device ${tone}${d.self ? ' self' : ''}`);

    const head = el('div', 'device-head');
    head.append(el('span', 'dot'), el('strong', null, d.self ? t('devices.strip.self', { name: d.name }) : d.name), el('span', 'device-os', d.os ?? (pool ? `pool · ${pool.kind}` : '')));

    const bits = [stateText];
    if (pool) {
      if (pool.cpuPct != null) bits.push(`CPU ${pool.cpuPct}%`);
      else if (pool.load1 != null && pool.cores) bits.push(`load ${pool.load1.toFixed(1)}/${pool.cores}`);
      if (pool.memTotalMb) bits.push(t('devices.strip.mem', { pct: Math.round((1 - pool.memAvailMb / pool.memTotalMb) * 100) }));
      if (pool.diskFreePct != null) bits.push(t('devices.strip.disk', { pct: pool.diskFreePct }));
      if (pool.busy) bits.push(t('devices.strip.jobs', { busy: pool.busy, slots: pool.slots }));
    } else if (!d.online && d.lastSeen) {
      bits.push(isJustNow(d.lastSeen) ? t('devices.strip.seenJustNow') : ago(d.lastSeen, { suffix: true }));
    }
    const line = el('div', 'device-line', bits.join(' · '));

    const tip = [
      d.tailscaleIps[0] && `Tailscale ${d.tailscaleIps[0]}`,
      d.lanIps.length && `LAN ${d.lanIps.join(', ')}`,
      d.path?.type === 'direct' && t('devices.path.direct', { endpoint: d.path.endpoint }),
      d.path?.type === 'relay' && t('devices.strip.relay', { region: d.path.region }),
      pool && `compute-pool: ${pool.name} (${pool.kind}) ${pool.inRotation ? t('devices.strip.inRotation') : t('devices.strip.notInRotation')}`,
      pool?.detail && pool.detail !== 'ok' && pool.detail,
      pool?.runners && `GitHub runner ${pool.runners.active}/${pool.runners.total}`,
      pool?.last24h && t('devices.strip.runs', { n: pool.last24h.runs, failed: pool.last24h.failed }),
    ].filter(Boolean);
    card.title = tip.join('\n');
    card.append(head, line);
    return card;
  });
}

/**
 * Other machines whose ports we know: compute-pool hosts (desktop, mac), the Proxmox host and its containers (pve1,
 * nas, jellyfin), the desktop's Windows side. Each: { key, name, label, state, note, online, ports }.
 */
export function remoteHosts(doc) {
  const node = doc.pvePorts?.node ?? t('devices.pveHost');
  const pveNote = (name) => t('devices.remote.pveNote', { node, name });
  const hosts = doc.devices.filter((d) => !d.self && d.ports).map((d) => {
    if (d.portsSource === 'agent') {
      const ok = !!d.agent?.ok;
      const note = ok ? t('devices.remote.agentNote', { dns: d.dnsName ?? d.name }) : t('devices.remote.agentStale', { name: d.name });
      return { key: d.name, name: d.name, label: d.name, state: ok ? t('devices.online') : t('devices.remote.agentDown'), online: ok && d.online, ports: d.ports, note };
    }
    if (d.portsSource === 'pve-ssh' || !d.pool) {
      const note = d.portsSource === 'pve-ssh' ? pveNote(d.name) : t('devices.remote.winNote', { dns: d.dnsName ?? d.name });
      return { key: d.name, name: d.name, label: d.name, state: d.online ? t('devices.online') : t('devices.remote.tsOff'), online: d.online, ports: d.ports, note };
    }
    const [stateText] = POOL_STATE[d.pool.state] ?? [d.pool.state];
    const host = {
      key: d.pool.name, name: d.pool.name, label: d.name === d.pool.name ? d.name : `${d.pool.name} · ${d.name}`, state: stateText, online: d.online, ports: d.ports,
      note: d.tailscaleIps.length && d.online
        ? t('devices.remote.poolNote', { dns: d.dnsName ?? d.name, name: d.pool.name })
        : t('devices.remote.poolAway', { name: d.name }),
    };
    if (d.ports.sides) {
      host.note = t('devices.remote.sidesNote', { dns: d.dnsName ?? d.name });
    }
    return host;
  });
  // Containers without a tailnet device of their own (jellyfin): straight from the Proxmox tree.
  const known = new Set(doc.devices.map((d) => d.id));
  for (const h of doc.proxmox?.hosts ?? []) {
    for (const g of h.guests) {
      if (!g.ports || (g.device && known.has(g.device)) || hosts.some((x) => x.key === g.name)) continue;
      hosts.push({ key: g.name, name: g.name, label: `${g.name} · CT ${g.vmid}`, state: g.status === 'running' ? t('devices.running') : g.status, online: g.status === 'running', ports: g.ports, note: pveNote(g.name) });
    }
  }
  return hosts;
}
