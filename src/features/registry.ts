// The feature module registry: the one list of features, and the views the servers iterate (routes, local and
// remote MCP tools, resources, prompts, jobs, collectors, dashboard scripts). Adding a feature is a new file in
// src/features/ plus one line in FEATURES; see docs/architecture.md "How to add a feature".
//
// FEATURES order is the order of tools/list (and of the remote list), so keep new features at the end unless a
// client-visible order is meant to change.
//
// buildRegistry() refuses a registry that would weaken a security property:
//   - a tool offered remotely must be read-only (annotations.readOnlyHint), and every remote tool is listed with
//     read-only annotations whatever the module says
//   - a route that isn't GET must be a write route (the router checks the X-Portboard guard on all of them anyway)
//   - names are unique: tools, remote tools, routes, jobs, collectors

import type { PromptDef } from '../mcp/prompts.ts';
import type { FeatureModule, Job, RemoteCall, RemoteResources, Resources, Route, Tool, ToolDef } from './types.ts';
import { READ_ONLY_ANNOTATIONS } from '../mcp/kit.ts';
import { ports } from './ports.ts';
import { ownersFeature } from './owners.ts';
import { worktreesFeature } from './worktrees.ts';
import { reservationsFeature } from './reservations.ts';
import { devServersFeature } from './devservers.ts';
import { onboardingFeature } from './onboarding.ts';
import { control } from './control.ts';
import { devicesFeature } from './devices.ts';
import { usageFeature } from './usage.ts';
import { freePortsFeature } from './free-ports.ts';
import { alertsFeature } from './alerts.ts';
import { knownFeature } from './known.ts';
import { serviceDetailFeature } from './service-detail.ts';
import { proxmoxFeature } from './proxmox.ts';
import { hostPortsFeature } from './host-ports.ts';
import { selfWatchFeature } from './selfwatch.ts';
import { overviewFeature } from './overview.ts';
import { digestFeature } from './digest.ts';
import { suggestionsFeature } from './suggestions.ts';
import { adoptionFeature } from './adoption.ts';
import { claudeFeature } from './claude.ts';
import { claudeSessionFeature } from './claude-session.ts';
import { accessFeature } from './access.ts';
import { remoteConnectorFeature } from './remote-connector.ts';
import { writeDevicesFeature } from './write-devices.ts';
import { settingsFeature } from './settings.ts';
import { portRulesFeature } from './port-rules.ts';
import { newPortsFeature } from './newports.ts';
import { memoryFeature } from './memory.ts';

export const FEATURES: FeatureModule[] = [
  ports,
  control,
  devicesFeature,
  usageFeature,
  freePortsFeature,
  alertsFeature,
  knownFeature,
  serviceDetailFeature,
  proxmoxFeature,
  hostPortsFeature,
  selfWatchFeature,
  overviewFeature,
  ownersFeature,
  worktreesFeature,
  reservationsFeature,
  devServersFeature,
  onboardingFeature,
  digestFeature,
  suggestionsFeature,
  adoptionFeature,
  claudeFeature,
  claudeSessionFeature,
  portRulesFeature,
  newPortsFeature,
  memoryFeature,
  remoteConnectorFeature,
  accessFeature,
  writeDevicesFeature,
  settingsFeature,
];

export const READ_ONLY = READ_ONLY_ANNOTATIONS;

export interface Registry {
  features: FeatureModule[];
  routes: Route[];
  tools: Tool[];
  toolByName: Map<string, Tool>;
  /** tools/list on the remote server: shared tools in local order, then remote-only tools */
  remoteTools: ToolDef[];
  remoteCalls: Map<string, RemoteCall>;
  resources: Resources[];
  remoteResources: RemoteResources[];
  prompts: PromptDef[];
  remotePrompts: PromptDef[];
  jobs: Job[];
  collectors: string[];
  ui: { pages: string[]; script: string; feature: string }[];
}

function unique(kind: string, names: string[]) {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) throw new Error(`feature registry: duplicate ${kind} ${n}`);
    seen.add(n);
  }
}

export function buildRegistry(features: FeatureModule[]): Registry {
  unique('feature', features.map((f) => f.name));
  const routes = features.flatMap((f) => f.routes ?? []);
  for (const r of routes) {
    if (r.method !== 'GET' && (r as { write?: unknown }).write !== true) throw new Error(`feature registry: ${r.method} ${r.path} must be declared write: true`);
  }
  unique('route', routes.map((r) => `${r.method} ${r.path}`));

  const tools = features.flatMap((f) => f.tools ?? []);
  unique('tool', tools.map((t) => t.def.name));
  const remoteCalls = new Map<string, RemoteCall>();
  const remoteTools: ToolDef[] = [];
  for (const t of tools) {
    if (!t.remote) continue;
    if (t.def.annotations.readOnlyHint !== true) throw new Error(`feature registry: ${t.def.name} changes things and can't be offered remotely`);
    remoteTools.push({ ...t.def, description: t.remote.description ?? t.def.description, annotations: READ_ONLY });
    remoteCalls.set(t.def.name, t.remote.call);
  }
  for (const t of features.flatMap((f) => f.remoteTools ?? [])) {
    if (t.def.annotations.readOnlyHint !== true) throw new Error(`feature registry: remote tool ${t.def.name} must be read-only`);
    if (remoteCalls.has(t.def.name)) throw new Error(`feature registry: duplicate remote tool ${t.def.name}`);
    remoteTools.push({ ...t.def, annotations: READ_ONLY });
    remoteCalls.set(t.def.name, t.call);
  }

  const jobs = features.flatMap((f) => f.jobs ?? []);
  unique('job', jobs.map((j) => j.name));
  const collectors = features.flatMap((f) => f.collectors ?? []);
  unique('collector', collectors);
  const prompts = features.flatMap((f) => f.prompts ?? []);
  unique('prompt', prompts.map((p) => p.name));
  const remotePrompts = features.flatMap((f) => f.remotePrompts ?? []);
  unique('remote prompt', remotePrompts.map((p) => p.name));

  return {
    features,
    routes,
    tools,
    toolByName: new Map(tools.map((t) => [t.def.name, t])),
    remoteTools,
    remoteCalls,
    resources: features.flatMap((f) => (f.resources ? [f.resources] : [])),
    remoteResources: features.flatMap((f) => (f.remoteResources ? [f.remoteResources] : [])),
    prompts,
    remotePrompts,
    jobs,
    collectors,
    ui: features.flatMap((f) => (f.ui ?? []).map((u) => ({ ...u, feature: f.name }))),
  };
}

export const REGISTRY = buildRegistry(FEATURES);

/** `<script>` tags the features add to a page, in registry order (same markup the pages used to carry). */
export function uiTags(page: string, reg: Registry = REGISTRY): string {
  return reg.ui
    .filter((u) => u.pages.includes(page))
    .map((u) => `  <script src="${u.script}" type="module"></script>\n`)
    .join('');
}
