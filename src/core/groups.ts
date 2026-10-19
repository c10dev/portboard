// Ports owned by the same thing, shown as one row with sub-ports: the same docker compose project
// (com.docker.compose.project), the same container, the same systemd unit, the same process, or tailscaled.
//
//   groupKey(port) → 'compose:webapp' | 'container:…' | 'unit:syncthing.service' | 'pid:1234' | 'sys:tailscaled' | null
//   assignGroups(ports) → sets group (only when two or more ports share a key) and role on each entry

export interface PortGroup {
  key: string;
  name: string;
  /** Every port in the group, ascending */
  ports: number[];
}

export interface Groupable {
  port: number;
  listening: boolean;
  owned: boolean;
  container: string | null;
  /** docker compose project of the container */
  composeProject?: string | null;
  processes: { pid: number; unit: string | null; unitDescription?: string | null }[];
  detectedName: string;
  probe: { http: boolean; title: string | null } | null;
  /** Owner of a system port known from the port itself (sshd, tailscaled…); its process isn't visible */
  systemOwner?: string | null;
  group?: PortGroup | null;
  role?: string | null;
}

/** Namespaced so a compose project and a unit or project folder of the same name never merge. */
export function groupKey(p: Groupable): string | null {
  if (!p.listening) return null;
  if (p.container) return p.composeProject ? `compose:${p.composeProject}` : `container:${p.container}`;
  if (p.systemOwner) return `sys:${p.systemOwner}`;
  const proc = p.processes[0];
  if (!proc) return null;
  if (proc.unit) return `unit:${proc.unit}`;
  return `pid:${proc.pid}`;
}

export function assignGroups<T extends Groupable>(ports: T[]): T[] {
  const byKey = new Map<string, T[]>();
  for (const p of ports) {
    p.group = null;
    p.role = null;
    const k = groupKey(p);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.port - b.port);
    const name = groupName(key, members);
    const group: PortGroup = { key, name, ports: members.map((m) => m.port) };
    const project = key.startsWith('compose:') ? key.slice(8) : null;
    const prefix = project ? commonPrefix(members.map((m) => stripProject(m.container!, project))) : '';
    for (const m of members) {
      m.group = group;
      m.role = roleOf(m, name, project, prefix);
    }
  }
  return ports;
}

function groupName(key: string, members: Groupable[]): string {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'compose') {
    const prefix = commonPrefix(members.map((m) => stripProject(m.container!, id)));
    return prefix && prefix !== id ? `${prefix} (${id})` : id;
  }
  if (kind === 'container') return `docker: ${id}`;
  if (kind === 'sys') return id;
  if (kind === 'unit') return shortName(members[0].processes[0]?.unitDescription ?? id);
  return shortName(members[0].detectedName);
}

/** Same rule as usage.ts displayName: "Syncthing - Open Source …" → "Syncthing" */
function shortName(name: string): string {
  return name.split(/\s+\(|\s+[—–|]\s+|\s+-\s+/)[0].trim() || name;
}

/** supabase_kong_webapp in project webapp → supabase_kong */
function stripProject(container: string, project: string): string {
  for (const sep of ['_', '-', '.']) {
    if (container.endsWith(`${sep}${project}`)) return container.slice(0, -project.length - 1);
    if (container.startsWith(`${project}${sep}`)) return container.slice(project.length + 1);
  }
  return container;
}

/** Longest shared leading word: supabase_kong, supabase_db → supabase */
export function commonPrefix(names: string[]): string {
  if (!names.length) return '';
  const words = names.map((n) => n.split(/[_\-.]/));
  const out: string[] = [];
  for (let i = 0; i < words[0].length; i++) {
    const w = words[0][i];
    if (words.every((x) => x[i] === w) && words.every((x) => x.length > i + 1)) out.push(w);
    else break;
  }
  return out.join('_');
}

/** What this port is within its group: the container's own part, tailscaled's listener, the page title, or HTTP/TCP. */
function roleOf(p: Groupable, groupName: string, project: string | null, prefix: string): string {
  if (p.container && project) {
    const own = stripProject(p.container, project);
    return (prefix && own.startsWith(`${prefix}_`) ? own.slice(prefix.length + 1) : own) || p.container;
  }
  if (p.container) return p.probe?.http ? 'HTTP' : 'TCP';
  if (p.systemOwner) return p.detectedName.replace(/\s*\([^)]*\)$/, '');
  if (p.probe?.http) return p.probe.title && shortName(p.probe.title) !== groupName ? p.probe.title : '웹 (HTTP)';
  return 'TCP';
}
