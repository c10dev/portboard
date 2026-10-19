// MCP resources over the core API: a compact status summary, one port, one device. Pure like tools.ts:
// the stdio server passes the real core, tests a fake one. The remote server builds its own (redacted) status
// from statusReport() and never reaches readResource().
//
//   portboard://status            devices online, pool health, services in use, watched ports down, 새 기기,
//                                 and (local only) Portboard's own collection health and expiring credentials
//   portboard://port/{port}       service_detail for one port
//   portboard://device/{id}       one device (list_devices) with what it uses (who_uses)

import { RpcError, type Core } from './kit.ts';
import { detailReport } from '../features/service-detail.ts';
import { usageReport } from '../features/usage.ts';
import { summarize } from './views.ts';
import { statusReport } from './status.ts';

export { collectionReport, statusReport, type StatusInput } from './status.ts';
import { t } from '../core/i18n.ts';

export const STATUS_URI = 'portboard://status';
const JSON_TYPE = 'application/json';

/** MCP "resource not found" (spec, resources/read) */
export const NOT_FOUND = -32002;

export const STATUS_RESOURCE = {
  uri: STATUS_URI,
  name: 'status',
  get title() {
    return t('resources.status.title');
  },
  description:
    'Portboard server status at a glance: devices online, compute-pool health, services in use (who uses what), ' +
    'watched (🔔) ports that are down, new devices not acknowledged yet, and collection: whether Portboard\'s own collectors ' +
    '(compute-pool, Proxmox, Proxmox/Windows SSH, …) work and which tokens expire soon, and memory: available %, swap %, PSI and whether the memory-pressure alert is on. Sections that could not be read are null and listed in unavailable.',
  mimeType: JSON_TYPE,
};

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'portboard://port/{port}',
    name: 'port',
    get title() {
      return t('resources.port.title');
    },
    description: 'One port in full (same as the service_detail tool): owner, scope, URLs, who uses it, uptime, alerts sent.',
    mimeType: JSON_TYPE,
  },
  {
    uriTemplate: 'portboard://device/{id}',
    name: 'device',
    get title() {
      return t('resources.device.title');
    },
    description:
      'One device by its id from list_devices (Tailscale name, pool:<name>) or who_uses (lan:<ip>): status, compute-pool load, ' +
      'its listening ports, and what it uses on this server now and in the last 7 days.',
    mimeType: JSON_TYPE,
  },
];

const settled = <T>(p: () => Promise<T> | undefined): Promise<T | null> =>
  Promise.resolve()
    .then(p)
    .then((v) => v ?? null)
    .catch(() => null);

/** portboard://status from the local core: every source on its own, so one that fails only nulls its section. */
export async function localStatus(core: Core, now = new Date()) {
  const [snap, devs, use, alerts, nd, coll, mem] = await Promise.all([
    settled(() => core.snapshot()),
    settled(() => core.devices()),
    settled(() => core.usage()),
    settled(() => core.alerts?.()),
    settled(() => core.newDevices?.()),
    settled(() => core.collection?.()),
    settled(() => core.memory?.()),
  ]);
  return statusReport({
    at: now.toISOString(),
    ports: snap
      ? { host: snap.host.hostname, tailnet: snap.tailscale.available ? snap.tailscale.dnsName : null, ports: snap.ports.map((p) => ({ port: p.port, name: p.name, listening: p.listening, visible: p.visible })) }
      : null,
    devices: devs,
    usage: use,
    watching: alerts?.watching ?? null,
    newDevices: nd?.pending ?? null,
    ...(core.collection ? { collection: coll } : {}),
    ...(core.memory
      ? { memory: mem ? { at: mem.at, pressure: mem.pressure.active, reasons: mem.pressure.reasons, availablePct: mem.mem.availablePct, swapPct: mem.mem.swapPct, psiSome60: mem.psi?.some.avg60 ?? null } : null }
      : {}),
  });
}

/** resources/list: the status, then this server's visible ports and the devices, so clients that only offer listed
 * resources (Claude Code's @ menu) can pick one. A source that fails just leaves its entries out. */
export async function listResources(core: Core) {
  const [snap, devs] = await Promise.all([settled(() => core.snapshot()), settled(() => core.devices())]);
  const ports = (snap ? summarize(snap).ports : [])
    .filter((p) => p.listening)
    .map((p) => ({ uri: `portboard://port/${p.port}`, name: `port-${p.port}`, title: `:${p.port} ${p.name}`, mimeType: JSON_TYPE }));
  const devices = (devs?.devices ?? []).map((d) => ({
    uri: `portboard://device/${encodeURIComponent(d.id)}`,
    name: `device-${d.id}`,
    title: `${d.name}${d.online ? '' : ' (offline)'}`,
    mimeType: JSON_TYPE,
  }));
  return { resources: [STATUS_RESOURCE, ...ports, ...devices] };
}

export type ParsedUri = { kind: 'status' } | { kind: 'port'; port: number } | { kind: 'device'; id: string };

/** Throws RpcError: -32602 for a malformed URI or argument, NOT_FOUND for a URI that names nothing we serve. */
export function parseResourceUri(uri: unknown): ParsedUri {
  if (typeof uri !== 'string' || !uri) throw new RpcError(-32602, 'params.uri must be a string');
  if (uri === STATUS_URI) return { kind: 'status' };
  const m = /^portboard:\/\/(port|device)\/([^/?#]+)$/.exec(uri);
  if (!m) throw new RpcError(NOT_FOUND, `resource not found: ${uri.slice(0, 200)}`);
  if (m[1] === 'port') {
    const port = /^\d{1,5}$/.test(m[2]) ? Number(m[2]) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RpcError(-32602, `port must be an integer between 1 and 65535 (got ${m[2].slice(0, 20)})`);
    return { kind: 'port', port };
  }
  let id: string;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    throw new RpcError(-32602, 'device id is not valid percent-encoding');
  }
  if (!/^[\w.:@~-]{1,120}$/.test(id)) throw new RpcError(-32602, 'device id has characters no device id uses');
  return { kind: 'device', id };
}

const contents = (uri: string, value: unknown) => ({ contents: [{ uri, mimeType: JSON_TYPE, text: JSON.stringify(value) }] });

export async function readResource(uri: unknown, core: Core) {
  const r = parseResourceUri(uri);
  const u = uri as string;
  switch (r.kind) {
    case 'status':
      return contents(u, await localStatus(core));
    case 'port': {
      if (!core.serviceDetail) throw new RpcError(NOT_FOUND, `resource not found: ${u}`);
      const d = await core.serviceDetail(r.port);
      if (!d) throw new RpcError(NOT_FOUND, `nothing is known about port ${r.port}: not listening, not watched, no usage history`);
      return contents(u, detailReport(d));
    }
    case 'device': {
      const [devs, use] = await Promise.all([settled(() => core.devices()), settled(() => core.usage())]);
      const device = devs?.devices.find((d) => d.id === r.id || d.name === r.id) ?? null;
      const usage = use ? (usageReport(use).devices.find((d) => d.id === (device?.id ?? r.id)) ?? null) : null;
      if (!device && !usage) {
        if (!devs && !use) throw new Error('devices and usage could not be read');
        throw new RpcError(NOT_FOUND, `no device with id ${r.id} (ids are in list_devices and who_uses)`);
      }
      return contents(u, { at: devs?.at ?? use?.at ?? new Date().toISOString(), device, usage });
    }
  }
}
