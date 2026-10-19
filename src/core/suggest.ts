// Smart defaults (c10dev/portboard#33): what Portboard suggests the user turn on or fill in, never does by itself.
//
//   alert  a port that is pinned, or runs as an installed systemd unit, or in a long-lived docker container, and has
//          no down alert yet → "🔔 알림 켜기?". One suggestion per unit / container (its HTTP port first, else its
//          lowest), so compute-pool monitor's 7720 and 7721 are one row.
//          Left out: hidden and stopped ports, Portboard itself (it can't alert about its own death), units made with
//          systemd-run (Claude previews and test services: nothing re-creates them), short-lived containers, system
//          ports whose owner isn't visible (sshd, DNS, tailscaled: the OS looks after those).
//   name   a LAN device without a user-given name → a name to accept in one click, from the best source there is:
//            tailscale  a tailnet peer whose direct WireGuard endpoint is this LAN address (the Mac on Wi-Fi with a
//                       private MAC, otherwise "개인 Wi-Fi 주소 기기"). The endpoint flips between the LAN address
//                       and the router (hairpin NAT), so the server remembers a match for 7 days while the same MAC
//                       is at that address (rememberPeers).
//            hostname   the name the LAN's DNS (the router, DHCP) gives the address, when it answers
//            vendor     a device kind from the MAC vendor (Synology → NAS, Brother → 프린터), only when it says more
//                       than the vendor guess already shown
//          A suggestion that equals the name already shown is no suggestion. A Proxmox guest is already shown under
//          its guest name (usage.ts); that name is what 이름 붙이기 pre-fills (prefillName), and the vendor guess
//          never replaces it.
//
// Dismissed ids live in prefs.json (prefs.ts suggestions.dismissed). Everything here is pure; the feature module
// (src/features/suggestions.ts) collects the inputs.

import { shortVendor, type NameSource } from './clients.ts';

/** Ids fit the router's generic `:device` segment ([A-Za-z0-9][A-Za-z0-9-]{0,62}) */
export const SUGGESTION_ID = /^(alert-\d{1,5}|name-[a-z0-9][a-z0-9-]{0,57})$/;

export interface AlertSuggestion {
  id: string;
  kind: 'alert';
  port: number;
  name: string;
  /** Why this port: pinned, an installed systemd unit, a long-lived container */
  reasons: ('pinned' | 'systemd' | 'docker')[];
  unit: string | null;
  container: string | null;
  /** Other ports of the same unit / container (an alert on this one covers the service) */
  also: number[];
  text: string;
}

export interface NameSuggestion {
  id: string;
  kind: 'name';
  /** clients.json key for POST /api/clients/name and name_device */
  key: string;
  /** 기기 card id when the device has one */
  device: string | null;
  ip: string | null;
  current: string;
  currentSource: NameSource;
  name: string;
  source: 'tailscale' | 'hostname' | 'vendor';
  confidence: 'high' | 'medium' | 'low';
  /** OS when a source knows it (the matched tailnet peer, the Proxmox guest type) */
  os: string | null;
  text: string;
}

export type Suggestion = AlertSuggestion | NameSuggestion;

export interface SuggestionsReport {
  at: string;
  suggestions: Suggestion[];
  /** How many would be shown but were dismissed (무시) */
  dismissed: number;
}

// ---------- alerts ----------

/** The parts of a PortEntry (src/core/index.ts) this needs */
export interface AlertCandidate {
  port: number;
  name: string;
  kind: 'app' | 'ephemeral' | 'system';
  listening: boolean;
  hidden: boolean;
  pinned: boolean;
  alert: boolean;
  container: string | null;
  processes: { unit: string | null }[];
  probe: { http: boolean } | null;
}

export interface ContainerInfo {
  startedAt: number | null;
  restart: string | null;
}

export interface AlertInputs {
  /** Units made with systemd-run (owners.ts transientUnits) */
  transient: Set<string>;
  /** Portboard's own units */
  selfUnits: Set<string>;
  /** docker inspect, by container name */
  containers: Map<string, ContainerInfo>;
  now: number;
}

/** A container that is up for a day, or that docker restarts by itself, is a service rather than an experiment. */
export const LONG_LIVED_MS = 24 * 3600_000;

export function longLived(c: ContainerInfo | undefined, now: number): boolean {
  if (!c) return false;
  if (c.restart === 'always' || c.restart === 'unless-stopped') return true;
  return c.startedAt !== null && now - c.startedAt >= LONG_LIVED_MS;
}

export function alertSuggestions(ports: AlertCandidate[], inp: AlertInputs): AlertSuggestion[] {
  // Owner of each port: its unit or container; a port with neither stands alone.
  const ownerOf = (p: AlertCandidate) => {
    const unit = p.processes.find((x) => x.unit)?.unit ?? null;
    return p.container ? `ctr:${p.container}` : unit ? `unit:${unit}` : `port:${p.port}`;
  };
  const byOwner = new Map<string, AlertCandidate[]>();
  for (const p of ports) {
    if (!p.listening) continue;
    const k = ownerOf(p);
    byOwner.set(k, [...(byOwner.get(k) ?? []), p]);
  }

  const out: AlertSuggestion[] = [];
  for (const group of byOwner.values()) {
    // Already watched through any of its ports: the service is covered.
    if (group.some((p) => p.alert)) continue;
    const shown = group.filter((p) => !p.hidden);
    if (!shown.length) continue;
    const unit = shown[0].processes.find((x) => x.unit)?.unit ?? null;
    const container = shown[0].container;
    if (unit && inp.selfUnits.has(unit)) continue;

    const reasons: AlertSuggestion['reasons'] = [];
    if (shown.some((p) => p.pinned)) reasons.push('pinned');
    if (unit && !inp.transient.has(unit) && shown[0].kind !== 'system') reasons.push('systemd');
    if (container && longLived(inp.containers.get(container), inp.now)) reasons.push('docker');
    if (!reasons.length) continue;

    const pick = [...shown].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(!!b.probe?.http) - Number(!!a.probe?.http) || a.port - b.port)[0];
    const also = shown.filter((p) => p !== pick).map((p) => p.port).sort((a, b) => a - b);
    out.push({
      id: `alert-${pick.port}`,
      kind: 'alert',
      port: pick.port,
      name: pick.name,
      reasons,
      unit,
      container,
      also,
      text: alertText(reasons, unit, container),
    });
  }
  return out.sort((a, b) => a.port - b.port);
}

function alertText(reasons: AlertSuggestion['reasons'], unit: string | null, container: string | null): string {
  const why = reasons.map((r) => (r === 'pinned' ? '고정한 포트' : r === 'systemd' ? `systemd 서비스 ${unit}` : `오래 도는 컨테이너 ${container}`));
  return `${why.join(' · ')}예요. 멈추면 알림을 받을까요?`;
}

// ---------- names ----------

/** The parts of a 기기 card (src/core/usage.ts DeviceCard) this needs */
export interface NameCard {
  id: string;
  name: string;
  nameSource: NameSource;
  kind: string;
  os: string | null;
  vendor: string | null;
  mac: string | null;
  randomMac: boolean;
  addresses: string[];
  lanIps: string[];
  nameKey: string | null;
  path: { type: 'direct'; endpoint: string } | { type: 'relay'; region: string } | null;
  guestOf: { type: string; vmid: number } | null;
}

/** A 새 기기 without a card (seen only in the neighbour table): known.ts NewDeviceView */
export interface PendingDevice {
  key: string;
  kind: string;
  name: string;
  vendor: string | null;
  ip: string | null;
  cardId: string | null;
  nameKey: string | null;
}

export interface NameInputs {
  /** This server's LAN addresses and the default gateway: never a tailnet peer's own address */
  notPeers: Set<string>;
  /** Reverse DNS (PTR) answers, by IP; absent when the LAN's DNS doesn't answer */
  hostnames: Map<string, string>;
  /** Earlier peer ↔ LAN address matches (rememberPeers): a peer's endpoint flips between its LAN address and the router */
  seen?: PeerSightings;
}

/** LAN address → the tailnet peer last seen with its direct endpoint there, and the MAC at that address then */
export type PeerSightings = Map<string, { peer: string; os: string | null; mac: string | null; at: number }>;

export const PEER_MEMORY_MS = 7 * 86400_000;

/** "dev-mac.tail1234.ts.net" → "dev-mac"; "nas.lan." → "nas"; null for nothing useful */
export function cleanHostname(raw: string): string | null {
  const first = raw.trim().replace(/\.$/, '').split('.')[0];
  if (!first || /^\d+$/.test(first) || /^(localhost|unknown|android-[0-9a-f]{8,}|ip-[\d-]+)$/i.test(first)) return null;
  return first.slice(0, 40);
}

/** Vendor → what kind of device it almost always is (only vendors that make one kind of thing): [IEEE name, brand, kind] */
const VENDOR_KIND: [RegExp, string, string][] = [
  [/^Synology/i, 'Synology', 'NAS'],
  [/^QNAP/i, 'QNAP', 'NAS'],
  [/^Brother/i, 'Brother', '프린터'],
  [/^Canon/i, 'Canon', '프린터'],
  [/^Seiko Epson/i, 'Epson', '프린터'],
  [/^Kyocera/i, 'Kyocera', '프린터'],
  [/^Espressif/i, 'Espressif', 'IoT 기기'],
  [/^Tuya/i, 'Tuya', 'IoT 기기'],
  [/^Shelly|^Allterco/i, 'Shelly', 'IoT 기기'],
  [/^Sonos/i, 'Sonos', '스피커'],
  [/^Roku/i, 'Roku', 'TV 스틱'],
  [/^Nintendo/i, 'Nintendo', '게임기'],
  [/^Sony Interactive/i, 'PlayStation', '게임기'],
  [/^Ubiquiti/i, 'Ubiquiti', '네트워크 장비'],
  [/^TP-LINK/i, 'TP-Link', '네트워크 장비'],
  [/^EFM Networks/i, 'ipTIME', '네트워크 장비'],
  [/^Raspberry Pi/i, 'Raspberry Pi', ''],
];

/** "Synology NAS", "Brother 프린터"; null when the vendor says nothing beyond its name */
export function vendorKind(vendor: string): string | null {
  const hit = VENDOR_KIND.find(([re]) => re.test(vendor));
  return hit ? `${hit[1]}${hit[2] ? ` ${hit[2]}` : ''}` : null;
}

const hostOf = (endpoint: string) => endpoint.replace(/^\[/, '').replace(/\]?:\d+$/, '');

/** "mac:bc:24:11:0a:0b:05" → "name-mac-bc-24-11-0a-0b-05" */
export function nameId(key: string): string {
  return `name-${key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}`.slice(0, 63);
}

export function nameSuggestions(cards: NameCard[], pending: PendingDevice[], inp: NameInputs): NameSuggestion[] {
  const peerAt = peersByEndpoint(cards, inp.notPeers);

  type Target = { key: string; device: string | null; ip: string | null; mac: string | null; current: string; currentSource: NameSource; vendor: string | null; guestOf: NameCard['guestOf'] };
  const targets: Target[] = [];
  const seen = new Set<string>();
  for (const c of cards) {
    if (c.kind !== 'lan' || !c.nameKey || c.nameSource === 'user') continue;
    seen.add(c.nameKey);
    targets.push({ key: c.nameKey, device: c.id, ip: c.addresses[0] ?? c.lanIps[0] ?? null, mac: c.mac, current: c.name, currentSource: c.nameSource, vendor: c.vendor, guestOf: c.guestOf });
  }
  for (const p of pending) {
    if (p.kind !== 'lan' || !p.nameKey || seen.has(p.nameKey)) continue;
    seen.add(p.nameKey);
    targets.push({ key: p.nameKey, device: p.cardId, ip: p.ip, mac: p.key.startsWith('mac:') ? p.key.slice(4) : null, current: p.name, currentSource: 'ip', vendor: p.vendor, guestOf: null });
  }

  const out: NameSuggestion[] = [];
  for (const t of targets) {
    // Now, else remembered while the same MAC is at that address (DHCP may have given it to another device since)
    const was = t.ip ? inp.seen?.get(t.ip) : undefined;
    const peer: { name: string; os: string | null } | null | undefined =
      (t.ip ? peerAt.get(t.ip) : null) ?? (was && was.mac && was.mac === t.mac && !(t.ip && peerAt.has(t.ip)) ? { name: was.peer, os: was.os } : null);
    const host = t.ip ? inp.hostnames.get(t.ip) : undefined;
    const hostName = host ? cleanHostname(host) : null;
    const kind = t.vendor ? vendorKind(t.vendor) : null;
    const guestOs = t.guestOf ? (t.guestOf.type === 'lxc' ? 'Proxmox CT' : 'Proxmox VM') : null;
    const pick: Pick<NameSuggestion, 'name' | 'source' | 'confidence' | 'os' | 'text'> | null = peer
      ? { name: peer.name, source: 'tailscale', confidence: 'high', os: peer.os, text: `Tailscale 기기 ${peer.name}${peer.os ? ` (${peer.os})` : ''}가 이 주소에서 직접 연결돼 있어요.` }
      : hostName
        ? { name: hostName, source: 'hostname', confidence: 'high', os: guestOs, text: `LAN DNS가 이 주소를 ${host}(으)로 알려 줘요.` }
        : kind && t.currentSource !== 'proxmox'
          ? { name: kind, source: 'vendor', confidence: 'low', os: guestOs, text: `MAC 제조사(${shortVendor(t.vendor!)})로 짐작한 이름이에요.` }
          : null;
    if (!pick || pick.name === t.current) continue;
    out.push({ id: nameId(t.key), kind: 'name', key: t.key, device: t.device, ip: t.ip, current: t.current, currentSource: t.currentSource, ...pick });
  }
  return out;
}

/** Tailnet peers by the LAN address of their direct endpoint; an address two peers share is a NAT (null), not a device. */
function peersByEndpoint(cards: NameCard[], notPeers: Set<string>): Map<string, NameCard | null> {
  const peerAt = new Map<string, NameCard | null>();
  for (const c of cards) {
    if ((c.kind !== 'tailnet' && c.kind !== 'pool') || c.path?.type !== 'direct') continue;
    const ip = hostOf(c.path.endpoint);
    if (notPeers.has(ip) || c.lanIps.includes(ip)) continue;
    peerAt.set(ip, peerAt.has(ip) ? null : c);
  }
  return peerAt;
}

/** The sightings after this sample: a peer whose endpoint is a LAN card's address now, with that card's MAC; old ones expire. */
export function rememberPeers(prev: PeerSightings, cards: NameCard[], notPeers: Set<string>, now: number, ttl = PEER_MEMORY_MS): PeerSightings {
  const next: PeerSightings = new Map([...prev].filter(([, v]) => now - v.at < ttl));
  const lanMac = new Map<string, string | null>();
  for (const c of cards) if (c.kind === 'lan') for (const ip of [...c.addresses, ...c.lanIps]) lanMac.set(ip, c.mac);
  for (const [ip, peer] of peersByEndpoint(cards, notPeers)) {
    if (peer && lanMac.has(ip)) next.set(ip, { peer: peer.name, os: peer.os, mac: lanMac.get(ip) ?? null, at: now });
  }
  return next;
}

/**
 * The name to pre-fill when naming a device by hand: the suggestion, else a name that came from somewhere better
 * than a guess (the Proxmox guest name), else nothing.
 */
export function prefillName(c: Pick<NameCard, 'name' | 'nameSource'>, s: NameSuggestion | undefined): string {
  if (c.nameSource === 'user') return c.name;
  if (s) return s.name;
  return c.nameSource === 'proxmox' ? c.name : '';
}

// ---------- together ----------

export function report(all: Suggestion[], dismissed: Set<string>, now: number): SuggestionsReport {
  const shown = all.filter((s) => !dismissed.has(s.id));
  return { at: new Date(now).toISOString(), suggestions: shown, dismissed: all.length - shown.length };
}

/** `docker inspect --format '{{.Name}}\t{{.State.StartedAt}}\t{{.HostConfig.RestartPolicy.Name}}'` */
export function parseDockerInspect(text: string): Map<string, ContainerInfo> {
  const out = new Map<string, ContainerInfo>();
  for (const line of text.split('\n')) {
    const [name, started = '', restart = ''] = line.trim().split('\t');
    if (!name) continue;
    const t = Date.parse(started);
    out.set(name.replace(/^\//, ''), { startedAt: Number.isFinite(t) && t > 0 ? t : null, restart: restart || null });
  }
  return out;
}

/** `ip route show default` → gateway addresses */
export function parseDefaultRoutes(text: string): string[] {
  return [...text.matchAll(/^default\s+via\s+(\S+)/gm)].map((m) => m[1]);
}
