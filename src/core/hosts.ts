// Which Host headers the dashboard answers (the DNS-rebinding guard in server.ts), and which listen addresses are
// outside loopback and the tailnet (c10dev/portboard#12). Pure, so test/access-token.test.ts can drive it.
//
// The allowlist is this machine's names and addresses: localhost, 127.0.0.1, the OS host name, the Tailscale names
// and IPs, every address it listens on (PORTBOARD_HOSTS), and PORTBOARD_ALLOWED_HOSTS (comma list of extra names,
// e.g. devbox.lan for a LAN install). A wildcard listen address (0.0.0.0, ::) answers on every interface, so the
// interfaces' own addresses are added instead of the wildcard; a name that isn't listed still gets 421.

import { isIP } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { isTailnetAddr, LOOPBACK } from './access.ts';

export const WILDCARD = new Set(['0.0.0.0', '::', '[::]']);

export interface HostInput {
  bindHosts: string[];
  ts: { hostName: string | null; dnsName: string | null; ips: string[] };
  hostname: string;
  /** PORTBOARD_ALLOWED_HOSTS */
  extra?: string;
  /** os.networkInterfaces(), for a wildcard bind */
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

/** The lower-case names and addresses a request's Host may carry (port and IPv6 brackets off). */
export function hostAllowlist(o: HostInput): Set<string> {
  const wild = o.bindHosts.some((h) => WILDCARD.has(h));
  const ifaces = wild ? Object.values((o.interfaces ?? networkInterfaces)()).flatMap((l) => (l ?? []).map((i) => i.address.replace(/%.*$/, ''))) : [];
  const extra = (o.extra ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return new Set(
    ['localhost', '127.0.0.1', o.hostname, o.ts.hostName, o.ts.dnsName, ...o.ts.ips, ...o.bindHosts.filter((h) => !WILDCARD.has(h)), ...ifaces, ...extra]
      .filter((h): h is string => !!h)
      .map((h) => h.toLowerCase()),
  );
}

/** Listen addresses that are neither loopback nor the tailnet: the LAN, a wildcard, another network. */
export function outsideAddrs(bindHosts: string[]): string[] {
  return bindHosts.filter((h) => h !== 'localhost' && !LOOPBACK.has(h) && !/^127\./.test(h) && !(isIP(h) && isTailnetAddr(h)));
}
