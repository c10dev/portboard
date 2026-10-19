// Devices (GET /api/devices, src/features/devices.ts) on the 서비스 tab: the strip of device cards above the port
// list, and the other machines whose ports the host picker can show. POOL_STATE is shared with the 기기 tab.

import { el } from '../lib/dom.js';
import { ago } from '../lib/time.js';

/** compute-pool host state → [text, tone] */
export const POOL_STATE = {
  ok: ['정상', 'ok'],
  degraded: ['일부 문제', 'warn'],
  'wsl-down': ['WSL 꺼짐', 'bad'],
  'host-down': ['응답 없음', 'bad'],
  auth: ['SSH 인증 실패', 'bad'],
  'agent-away': ['에이전트 끊김', 'off'],
  'agent-busy': ['사용 중', 'warn'],
  unknown: ['상태 모름', 'off'],
};

/** One small card per device: name, state, load; hover for addresses, runners and the last 24 h of runs */
export function deviceStrip(doc) {
  return doc.devices.map((d) => {
    const pool = d.pool;
    const [stateText, tone] = pool ? POOL_STATE[pool.state] ?? [pool.state, 'off'] : d.online ? ['온라인', 'ok'] : ['오프라인', 'off'];
    const card = el('div', `device ${tone}${d.self ? ' self' : ''}`);

    const head = el('div', 'device-head');
    head.append(el('span', 'dot'), el('strong', null, d.self ? `${d.name} (이 서버)` : d.name), el('span', 'device-os', d.os ?? (pool ? `pool · ${pool.kind}` : '')));

    const bits = [stateText];
    if (pool) {
      if (pool.cpuPct != null) bits.push(`CPU ${pool.cpuPct}%`);
      else if (pool.load1 != null && pool.cores) bits.push(`load ${pool.load1.toFixed(1)}/${pool.cores}`);
      if (pool.memTotalMb) bits.push(`메모리 ${Math.round((1 - pool.memAvailMb / pool.memTotalMb) * 100)}%`);
      if (pool.diskFreePct != null) bits.push(`디스크 여유 ${pool.diskFreePct}%`);
      if (pool.busy) bits.push(`작업 ${pool.busy}/${pool.slots}`);
    } else if (!d.online && d.lastSeen) {
      bits.push(`${ago(d.lastSeen)} 전`);
    }
    const line = el('div', 'device-line', bits.join(' · '));

    const tip = [
      d.tailscaleIps[0] && `Tailscale ${d.tailscaleIps[0]}`,
      d.lanIps.length && `LAN ${d.lanIps.join(', ')}`,
      d.path?.type === 'direct' && `직결 ${d.path.endpoint}`,
      d.path?.type === 'relay' && `릴레이 ${d.path.region}`,
      pool && `compute-pool: ${pool.name} (${pool.kind}) ${pool.inRotation ? '작업 받는 중' : '작업 안 받음'}`,
      pool?.detail && pool.detail !== 'ok' && pool.detail,
      pool?.runners && `GitHub runner ${pool.runners.active}/${pool.runners.total}`,
      pool?.last24h && `24시간 실행 ${pool.last24h.runs}회 (실패 ${pool.last24h.failed})`,
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
  const node = doc.pvePorts?.node ?? 'Proxmox 호스트';
  const pveNote = (name) => `${node}에서 읽기 전용 SSH로 읽은 목록이에요 (1분마다). tailnet 포트는 Tailscale 이름으로, LAN 포트는 LAN 주소로 열려요. "그 기기 안에서만"은 ${name} 안의 프로그램만 쓸 수 있어요.`;
  const hosts = doc.devices.filter((d) => !d.self && d.ports).map((d) => {
    if (d.portsSource === 'pve-ssh' || !d.pool) {
      const note = d.portsSource === 'pve-ssh' ? pveNote(d.name) : `Windows OpenSSH의 읽기 전용 키로 읽은 목록이에요 (1분마다). tailnet 포트는 ${d.dnsName ?? d.name} 이름으로 열려요.`;
      return { key: d.name, name: d.name, label: d.name, state: d.online ? '온라인' : 'Tailscale 꺼짐', online: d.online, ports: d.ports, note };
    }
    const [stateText] = POOL_STATE[d.pool.state] ?? [d.pool.state];
    const host = {
      key: d.pool.name, name: d.pool.name, label: d.name === d.pool.name ? d.name : `${d.pool.name} · ${d.name}`, state: stateText, online: d.online, ports: d.ports,
      note: d.tailscaleIps.length && d.online
        ? `compute-pool이 알려 준 목록이에요. tailnet 포트는 ${d.dnsName ?? d.name} 이름으로 열려요. "그 기기 안에서만"은 ${d.pool.name} 안의 프로그램만 쓸 수 있어요.`
        : `compute-pool이 알려 준 목록이에요. ${d.name}이(가) 지금 Tailscale에 없어서 바로 열 수는 없어요.`,
    };
    if (d.ports.sides) {
      host.note = `WSL 쪽은 compute-pool이, Windows 쪽은 Windows OpenSSH의 읽기 전용 키로 읽은 목록이에요. WSL 포트를 Windows localhost로 넘겨 주는 소켓은 WSL 줄 하나로 합쳤어요. tailnet 포트는 ${d.dnsName ?? d.name} 이름으로 열려요.`;
    }
    return host;
  });
  // Containers without a tailnet device of their own (jellyfin): straight from the Proxmox tree.
  const known = new Set(doc.devices.map((d) => d.id));
  for (const h of doc.proxmox?.hosts ?? []) {
    for (const g of h.guests) {
      if (!g.ports || (g.device && known.has(g.device)) || hosts.some((x) => x.key === g.name)) continue;
      hosts.push({ key: g.name, name: g.name, label: `${g.name} · CT ${g.vmid}`, state: g.status === 'running' ? '실행 중' : g.status, online: g.status === 'running', ports: g.ports, note: pveNote(g.name) });
    }
  }
  return hosts;
}
