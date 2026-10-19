// Overview: the MCP resources and prompts that summarize across features. portboard://status (devices, pool,
// services in use, watched ports down, 새 기기, collection health), portboard://port/{port} (service_detail) and
// portboard://device/{id}; the ready-made prompts. The remote server gets the status resource only, redacted, and
// prompt texts that name only the tools it has.
//
// The data shaping stays in src/mcp/resources.ts, status.ts and prompts.ts; this module says what is offered where.

import { listResources, readResource, RESOURCE_TEMPLATES, STATUS_RESOURCE, STATUS_URI } from '../mcp/resources.ts';
import { PROMPTS, type PromptDef } from '../mcp/prompts.ts';
import { redactStatus, type RedactPolicy } from '../remote/redact.ts';
import type { RemoteCore } from '../remote/core.ts';
import type { FeatureModule } from './types.ts';
import { SITE } from '../core/site.ts';
import { t } from '../core/i18n.ts';

const REMOTE_RESOURCES = [
  {
    ...STATUS_RESOURCE,
    description:
      `Portboard server (${SITE.host}) status at a glance: devices online, compute-pool health, services in use (who uses what), ` +
      'watched (🔔) ports that are down, how many new devices are not acknowledged yet, and memory pressure (available %, swap %, PSI). ' +
      'Read-only; addresses are left out.',
  },
];

const STATUS_SUMMARY = PROMPTS.find((p) => p.name === 'server_status_summary')!;
const PORT_CLEANUP = PROMPTS.find((p) => p.name === 'port_cleanup')!;

// Same names and titles as the local server; the text only names what this connection has. Getters, not a spread of
// the local definitions: the text is read when a client asks, in the server's language.
const REMOTE_PROMPTS: PromptDef[] = [
  {
    name: STATUS_SUMMARY.name,
    get title() {
      return STATUS_SUMMARY.title;
    },
    get description() {
      return STATUS_SUMMARY.description;
    },
    arguments: [],
    text: () => t('overview.remote.status.text', { host: SITE.host }),
  },
  {
    name: PORT_CLEANUP.name,
    get title() {
      return PORT_CLEANUP.title;
    },
    get description() {
      return t('overview.remote.cleanup.desc');
    },
    arguments: [],
    text: () => t('overview.remote.cleanup.text'),
  },
];

const settled = <T>(fn: (() => Promise<T>) | undefined): Promise<T | null> =>
  fn ? Promise.resolve().then(fn).catch(() => null) : Promise.resolve(null);

/** Remote portboard://status: the same summary from RemoteCore, redacted (addresses, processes, LAN names). */
async function remoteStatus(core: RemoteCore, policy: RedactPolicy) {
  const [snap, devices, usage, extras] = await Promise.all([
    settled(() => core.snapshot()),
    settled(() => core.devices()),
    settled(() => core.usage()),
    settled(core.statusExtras && (() => core.statusExtras!())),
  ]);
  const status = redactStatus({ at: new Date().toISOString(), snap, devices, usage, extras }, policy);
  return { contents: [{ uri: STATUS_URI, mimeType: 'application/json', text: JSON.stringify(status) }] };
}

export const overviewFeature: FeatureModule = {
  name: 'overview',
  order: 1200,
  resources: {
    templates: RESOURCE_TEMPLATES,
    list: async (core) => (await listResources(core)).resources,
    // portboard://status, portboard://port/<x>, portboard://device/<x>: resources.ts answers (and says what's wrong)
    claims: (uri) => uri === STATUS_URI || /^portboard:\/\/(port|device)\/[^/?#]+$/.test(uri),
    read: (uri, core) => readResource(uri, core),
  },
  remoteResources: { resources: REMOTE_RESOURCES, read: (_uri, core, policy) => remoteStatus(core, policy) },
  prompts: PROMPTS,
  remotePrompts: REMOTE_PROMPTS,
};
