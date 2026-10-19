// Other machines' listening ports (compute-pool hosts, the Proxmox host and its containers, the desktop's Windows side;
// src/features/host-ports.ts), shared by the 서비스 and 기기 tabs. Each port comes from /api/devices or /api/usage as
// { port, scope, addresses, processes, tailnet, lan, url }.

import { el, extLink } from '../lib/dom.js';
import { agoMonths as ago, checkedAgo } from '../lib/time.js';

/** Where the port can be reached, as a short tag: [text, tone, title]. */
export function reachTag(p, deviceName) {
  if (p.scope === 'loopback') return ['그 기기 안에서만', 'warn', `${p.addresses.join(', ')}: ${deviceName} 안의 프로그램만 접속할 수 있어요`];
  if (p.scope === 'other') return [p.addresses.join(', '), '', '특정 주소(LAN, docker 등)에만 열려 있어요'];
  if (p.tailnet) return ['tailnet', 'info', `Tailscale로 접속할 수 있어요 (${p.addresses.join(', ')})${p.side === 'windows' ? '. Windows 방화벽이 막고 있으면 안 열려요' : ''}`];
  if (p.lan) return ['LAN', 'info', `LAN 주소로 접속할 수 있어요 (${p.addresses.join(', ')}). 밖에서는 서브넷 라우터를 거쳐요.`];
  return [p.scope === 'all' ? '모든 인터페이스' : 'Tailscale IP', '', `${p.addresses.join(', ')} · 지금은 Tailscale에 없어서 열 수 없어요`];
}

/** "node, vite" or a hint that the host could not name it */
export function processText(p) {
  return p.processes.length ? p.processes.join(', ') : '프로세스 모름';
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
      s.title = p.side === 'windows' ? 'Windows에서 직접 열린 포트 (WSL 밖)' : 'WSL 안에서 열린 포트 (compute-pool)';
      name.append(s);
    }
    name.append(el('span', p.processes.length ? 'hp-proc' : 'hp-proc unknown', processText(p)));
    const [text, tone, title] = reachTag(p, deviceName);
    const tag = el('span', `tag ${tone}`, text);
    tag.title = title;
    name.append(tag);
    li.append(name);
    if (p.url) {
      const a = extLink('열기 ↗', p.url, 'hp-open');
      a.title = p.url;
      a.addEventListener('click', (ev) => ev.stopPropagation());
      li.append(a);
    }
    ul.append(li);
  }
  if (ports.length > limit) ul.append(el('li', 'hp-more', `외 ${ports.length - limit}개`));
  return ul;
}

/** "Windows 12 · WSL 3" for a merged desktop list, else '' */
export function sidesText(ports) {
  if (!ports.sides) return '';
  const n = (side) => ports.ports.filter((p) => p.side === side).length;
  return `Windows ${n('windows')} · WSL ${ports.sides.wsl == null ? '정보 없음' : n('wsl')}`;
}

// ---- 서비스 tab: the host picker's view of another machine ----

/** The #remote box for a host from remoteHosts() (features/devices.js), filtered by the search text */
export function remoteView(d, needle) {
  const ports = d.ports.ports.filter((p) => !needle || [p.port, ...p.processes, ...p.addresses].join(' ').toLowerCase().includes(needle));
  const head = el('div', 'remote-head');
  const open = d.ports.ports.filter((p) => p.tailnet || p.lan).length;
  head.append(el('strong', null, d.label), el('span', null, `${d.state} · 열린 포트 ${d.ports.ports.length}개 · 바로 열 수 있는 것 ${open}개 · ${checkedAgo(d.ports.at)}`));
  const note = el('p', 'remote-note', d.note);
  return [head, ports.length ? portList(ports, d.name) : el('p', 'empty', needle ? '검색과 맞는 포트가 없어요.' : '열린 TCP 포트가 없어요.'), note];
}

// ---- 기기 tab: "열린 포트 N" on cards and the readers' setup hints ----

/** "pve에서 읽음" / "compute-pool": where a card's port list came from */
export function portsFrom(c, data) {
  return c.portsSource === 'pve-ssh' ? `${data.pvePorts?.node ?? 'Proxmox 호스트'}에서 읽음` : 'compute-pool';
}

/** card ids whose port list the user folded */
const foldedPorts = new Set();

/** "열린 포트 N" with the list, for a compute-pool host or a Proxmox host/container (other machines only). */
export function portsBox(c, data) {
  if (!c.ports) {
    // an agent host whose worker predates port reporting
    if (c.pool?.kind === 'agent' && c.pool.agent?.connected) return el('div', 'hports-none', '포트 정보 없음 · worker 업데이트 필요');
    return null;
  }
  const d = el('details', 'hports-box');
  d.open = !foldedPorts.has(c.id);
  d.addEventListener('toggle', () => (d.open ? foldedPorts.delete(c.id) : foldedPorts.add(c.id)));
  const sum = el('summary');
  const open = c.ports.ports.filter((p) => p.tailnet || p.lan).length;
  const where = c.ports.ports.some((p) => p.lan) ? 'LAN 주소로' : 'tailnet에서';
  sum.append(el('strong', null, `열린 포트 ${c.ports.ports.length}`));
  const sides = sidesText(c.ports);
  sum.append(document.createTextNode(` · ${sides ? `${sides} · ` : ''}${where} ${open}개 · ${c.portsSource === 'pve-ssh' ? `${portsFrom(c, data)} · ` : ''}${checkedAgo(c.ports.at)}`));
  sum.addEventListener('click', (ev) => ev.stopPropagation());
  d.append(sum, portList(c.ports.ports, c.name, { limit: 12 }));
  return d;
}

/** Fill a hint box: the text, plus "설치 방법 ↗" when setup is what's missing */
function hint(box, text, setupUrl) {
  box.replaceChildren();
  if (!text) { box.hidden = true; return; }
  box.append(document.createTextNode(text));
  if (setupUrl) box.append(document.createTextNode(' '), extLink('설치 방법 ↗', setupUrl));
  box.hidden = false;
}

const READ_ERROR = { unreachable: '연결 안 됨', timeout: '시간 초과' };

/** The Proxmox host's SSH port reader: a setup hint until the key is installed, then only problems. */
export function renderPortsHint(box, pp) {
  const node = pp?.node ?? 'Proxmox';
  const lastOk = pp?.lastOk ? ` · 마지막 성공 ${ago(new Date(pp.lastOk).toISOString())} 전` : '';
  const text = !pp || !pp.enabled || pp.pending ? ''
    : pp.error === 'not-installed' ? `${node}·컨테이너의 열린 포트를 보려면 ${node}에 읽기 전용 키를 한 번 설치해 주세요 (포트 목록만 읽어요).`
    : pp.error === 'no-key' ? `이 서버에 ${node}용 키(~/.ssh/portboard_ro)가 없어서 ${node} 포트를 읽지 않아요.`
    : pp.error === 'host-key' ? `${node}의 SSH 호스트 키가 known_hosts와 맞지 않아서 연결하지 않았어요.`
    : pp.error === 'bad-config' ? 'pveports.json 설정이 잘못됐어요 (~/.config/portboard/pveports.json).'
    : pp.error === 'bad-output' ? `${node}의 portboard-ports 스크립트가 예상과 다른 출력을 냈어요.`
    : pp.error ? `${node} 포트 읽기 실패 (${READ_ERROR[pp.error] ?? '오류'})${lastOk}`
    : pp.unmatched?.length ? `CT ${pp.unmatched.join(', ')}의 포트는 Proxmox 목록과 맞출 수 없어서 표시하지 않았어요.`
    : '';
  hint(box, text, text && (pp.error === 'not-installed' || pp.error === 'no-key') ? pp.setupUrl : null);
}

/** The desktop's Windows-side reader: the setup hint until the user is set and the key works, then only problems. */
export function renderWinHint(box, wp) {
  const dev = wp?.device ?? 'Windows';
  const text = !wp || !wp.enabled || wp.pending ? ''
    : wp.error === 'no-user' || wp.error === 'not-installed' ? `${dev}의 Windows 쪽 포트(WSL 밖)를 보려면 Windows에 읽기 전용 키를 한 번 설치해 주세요 (포트 목록만 읽어요).`
    : wp.error === 'no-key' ? `이 서버에 키(~/.ssh/portboard_ro)가 없어서 ${dev}의 Windows 포트를 읽지 않아요.`
    : wp.error === 'host-key' ? `${dev} Windows의 SSH 호스트 키가 known_hosts와 맞지 않아서 연결하지 않았어요.`
    : wp.error === 'bad-config' ? 'winports.json 설정이 잘못됐어요 (~/.config/portboard/winports.json).'
    : wp.error === 'bad-output' ? `${dev}의 ports.ps1이 예상과 다른 출력을 냈어요.`
    : wp.error ? `${dev} Windows 포트 읽기 실패 (${READ_ERROR[wp.error] ?? '오류'})${wp.lastOk ? ` · 마지막 성공 ${ago(new Date(wp.lastOk).toISOString())} 전` : ''}`
    : '';
  hint(box, text, text && ['no-user', 'not-installed', 'no-key'].includes(wp.error) ? wp.setupUrl : null);
}
