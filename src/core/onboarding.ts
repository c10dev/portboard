// 설정 체크리스트 (#32): what is set up and what is left, each with its next step. Two layers:
//
//   assess(facts)     pure: plain facts (booleans, counts, dates, status codes) → the checklist items
//   collectFacts()    (collectSetupFacts() adds the site values, site.ts) read-only IO, the same in the server and the stdio MCP process: config files, the self-watch
//                     view (collectors and token expiry; the server passes its live one, the MCP process reads
//                     selfwatch.json), compute-pool's hosts, ~/.claude.json, and when the menu bar last asked
//
// Never a secret: facts hold no tokens, topics, URLs, token ids, fingerprints or MCP args/env, only whether they
// exist. Setup facts are production's even in a preview: a preview's alert channel is a file that never exists
// (paths.ts) and its remote.json is its own empty copy, so reading those would always say "missing".

import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { channelKinds, loadChannel } from './alerts.ts';
import { loadNames } from './clients.ts';
import { PATHS } from './paths.ts';
import { poolStatus, type PoolStatus } from './pool.ts';
import { loadPrefs } from './prefs.ts';
import { loadConfig as loadProxmoxConfig } from './proxmox.ts';
import { SETUP_URL as PVE_SETUP_URL } from './pveports.ts';
import { RUNBOOKS } from './runbooks.ts';
import { savedStatus, type SelfWatchStatus } from './selfwatch.ts';
import { WIN_SETUP_URL } from './winports.ts';
import { writePrivate } from './atomic.ts';
import { loadWriteDevices, ownerFromStatus } from './access.ts';
import { runShared } from './exec.ts';
import { site, SITE, tildePath, type Site } from './site.ts';
import { connectorView } from '../remote/admin.ts';
import { t } from './i18n.ts';

const DAY = 86_400_000;
const DOCS = 'https://github.com/c10dev/portboard/blob/main/docs';
/** The main checkout production runs from (deploy/portboard.service), for commands to copy: portboard.json or the default (site.ts) */
export const MAIN_CHECKOUT = SITE.checkout;

// ---------- facts ----------

/** A collector as the self-watch shows it: view ok/failing/down/off/setup/pending, lastError a fixed code */
export interface CollectorFact {
  view: string;
  lastError: string | null;
}

export interface Facts {
  /** Which kinds compute-pool's alerts.json has (production's) */
  alertChannel: ('ntfy' | 'webhook')[];
  proxmox: {
    configured: boolean;
    /** proxmox.json exists but is invalid (the checker's message, which never holds the secret) */
    error: string | null;
    looseMode: boolean;
    /** the self-watch's proxmox collector, null before its first report */
    collector: CollectorFact | null;
    /** the self-watch's expiry check of the token, null before it ran */
    expiry: { status: string; expiresAt: string | null } | null;
  };
  pvePorts: CollectorFact | null;
  winPorts: CollectorFact | null;
  /** null: compute-pool's monitor didn't answer */
  macAgent: { present: boolean; connected: boolean; state: string | null } | null;
  /** ms when the Mac app or the menu bar plugin last asked the dashboard (null: never seen) */
  menubarSeenAt: number | null;
  /** attention: clients whose 커넥터 상태 isn't 정상 (src/remote/health.ts); absent counts as 0 */
  remote: { clients: number; liveTokens: number; publicUrl: boolean; unreadable: boolean; attention?: number };
  /** null: neither ~/.claude.json nor ~/.claude/settings.json could be read. plugin: portboard@portboard enabled (claude-plugin/) */
  claudeCode: { registered: boolean; plugin?: boolean } | null;
  usage: { pinned: number; labels: number; alerts: number; deviceAlerts: number; names: number };
  /** The write-device allowlist (security review v1.0, M1) and who can write without one */
  writeDevices: WriteDevicesFact;
  /** This server as the commands to copy name it (site.ts, runtime values first); absent: SITE (file or defaults) */
  site?: SiteFact;
}

/** The site values the checklist's commands use */
export type SiteFact = Pick<Site, 'host' | 'dnsName' | 'user' | 'checkout'>;

export interface WriteDevicesFact {
  /** access.json's writeDevices plus PORTBOARD_WRITE_DEVICES; null when neither is set */
  list: string[] | null;
  /** access.json is there but unusable: serve writes are refused until it's fixed */
  error: string | null;
  /** where this profile reads it, ~ for the home directory */
  path: string;
  /** Untagged devices logged in as the owner, other than this server: through serve they all count as the owner. null: tailscale didn't answer */
  ownerDevices: { name: string; os: string | null }[] | null;
}

// ---------- the checklist ----------

export type ItemStatus = 'ok' | 'missing' | 'warn';

export type Action = { kind: 'command'; text: string; label?: string } | { kind: 'link'; href: string; label: string };

export interface Item {
  key: string;
  title: string;
  status: ItemStatus;
  /** one line, in the language of the request (i18n.ts) */
  detail: string;
  /** the next step; null once it's ok */
  action: Action | null;
  /** further reading shown whatever the status: the secret's rotation runbook, the page that manages it */
  links?: { href: string; label: string }[];
}

export interface Checklist {
  items: Item[];
  ok: number;
  total: number;
  /** "설정 7/9" / "Setup 7/9" */
  summary: string;
}

const link = (href: string, label: string): Action => ({ kind: 'link', href, label });
const command = (text: string, label?: string): Action => ({ kind: 'command', text, ...(label ? { label } : {}) });

export const MENUBAR_FRESH_MS = 7 * DAY;

function alertItem(f: Facts): Item {
  const base = { key: 'alerts', title: t('setup.alerts.title') };
  if (f.alertChannel.length) return { ...base, status: 'ok', detail: t('setup.alerts.ok', { kinds: f.alertChannel.join(' · ') }), action: null };
  return {
    ...base,
    status: 'missing',
    detail: t('setup.alerts.missing'),
    action: command(
      `umask 077; t=$(openssl rand -hex 16); printf '{"ntfy":{"topic":"%s"}}\\n' "$t" > ~/.local/state/compute-pool/alerts.json; echo "${t('setup.alerts.topicEcho')}: $t"`,
      t('setup.alerts.action'),
    ),
  };
}

function proxmoxItem(f: Facts, now: number): Item {
  const base = { key: 'proxmox', title: t('setup.proxmox.title') };
  const p = f.proxmox;
  const doc = link(`${DOCS}/runbooks/proxmox-token.md`, t('setup.proxmox.doc'));
  if (!p.configured && !p.error) return { ...base, status: 'missing', detail: t('setup.proxmox.missing', { node: SITE.pve.node }), action: doc };
  if (p.error) return { ...base, status: 'warn', detail: t('setup.proxmox.unreadable', { error: p.error }), action: doc };
  if (p.looseMode) return { ...base, status: 'warn', detail: t('setup.proxmox.loose'), action: command('chmod 600 ~/.config/portboard/proxmox.json') };
  const c = p.collector;
  if (c && (c.view === 'failing' || c.view === 'down')) return { ...base, status: 'warn', detail: c.lastError ? t('setup.proxmox.failingWhy', { error: c.lastError }) : t('setup.proxmox.failing'), action: doc };
  const e = p.expiry;
  if (e?.status === 'expired') return { ...base, status: 'warn', detail: t('setup.proxmox.expired', { node: SITE.pve.node }), action: doc };
  if (e?.status === 'soon') {
    const left = e.expiresAt ? Math.max(0, Math.ceil((Date.parse(e.expiresAt) - now) / DAY)) : null;
    return { ...base, status: 'warn', detail: left !== null ? t('setup.proxmox.soonDays', { n: left }) : t('setup.proxmox.soon'), action: doc };
  }
  const expiry =
    e?.status === 'never' ? t('setup.proxmox.noExpiry')
    : e?.status === 'ok' && e.expiresAt ? t('setup.proxmox.daysLeft', { n: Math.ceil((Date.parse(e.expiresAt) - now) / DAY) })
    : e?.status === 'unknown' ? t('setup.proxmox.expiryUnknown')
    : '';
  return { ...base, status: 'ok', detail: `${t('setup.connected')}${expiry ? ` · ${expiry}` : ''}`, action: null };
}

/** A collector's lastError code → its catalog key */
const SSH_ERROR: Record<string, string> = {
  'no-key': 'setup.ssh.noKey',
  'not-installed': 'setup.ssh.notInstalled',
  'no-user': 'setup.ssh.noUser',
  'host-key': 'setup.ssh.hostKey',
  'bad-config': 'setup.ssh.badConfig',
};

function sshItem(key: string, title: string, what: string, c: CollectorFact | null, setupUrl: string): Item {
  const base = { key, title };
  const setup = link(setupUrl, t('setup.ssh.howTo'));
  if (!c || c.view === 'pending') return { ...base, status: 'warn', detail: t('setup.ssh.pending'), action: null };
  if (c.view === 'ok') return { ...base, status: 'ok', detail: t('setup.ssh.ok', { what }), action: null };
  if (c.view === 'off') return { ...base, status: 'ok', detail: t('setup.ssh.off'), action: null };
  const code = c.lastError && SSH_ERROR[c.lastError];
  const why = code ? t(code) : c.lastError ? t('setup.ssh.failedCode', { code: c.lastError }) : t('setup.ssh.failed');
  if (c.view === 'setup') return { ...base, status: 'missing', detail: t('setup.ssh.setup', { what, why }), action: setup };
  return { ...base, status: 'warn', detail: t('setup.ssh.failing', { what, why }), action: setup };
}

function macItem(f: Facts): Item {
  const base = { key: 'mac-agent', title: t('setup.mac.title') };
  const doc = link(`${DOCS}/integrations/compute-pool.md#mac-agent`, t('setup.mac.doc'));
  const m = f.macAgent;
  if (!m) return { ...base, status: 'warn', detail: t('setup.mac.noMonitor'), action: command('systemctl --user status compute-pool-monitor') };
  if (!m.present) return { ...base, status: 'missing', detail: t('setup.mac.missing'), action: doc };
  if (!m.connected) return { ...base, status: 'warn', detail: m.state ? t('setup.mac.disconnectedState', { state: m.state }) : t('setup.mac.disconnected'), action: command(`cpool agent --coordinator ${(f.site ?? SITE).host} --host mac`, t('setup.mac.run')) };
  return { ...base, status: 'ok', detail: t('setup.connected'), action: null };
}

function menubarItem(f: Facts, now: number): Item {
  const base = { key: 'menubar', title: t('setup.menubar.title') };
  // The native Mac app (mac-app/, docs/mac-app/) replaces the SwiftBar plugin: build it from the main checkout
  const s = f.site ?? SITE;
  // rsync's remote path is relative to the remote home when it starts there (~/x → x)
  const from = tildePath(s.checkout).replace(/^~\//, '');
  const install = command(
    `rsync -a --exclude node_modules --exclude .git ${s.user}@${s.dnsName}:${from}/ ~/portboard/ && ~/portboard/mac-app/build.sh --install`,
    t('setup.menubar.install'),
  );
  if (f.menubarSeenAt !== null && now - f.menubarSeenAt < MENUBAR_FRESH_MS) return { ...base, status: 'ok', detail: t('setup.menubar.ok'), action: null };
  if (f.menubarSeenAt !== null) return { ...base, status: 'warn', detail: t('setup.menubar.stale', { n: Math.floor((now - f.menubarSeenAt) / DAY) }), action: install };
  return { ...base, status: 'missing', detail: t('setup.menubar.missing'), action: install };
}

/** 승인 코드 만들기 is on the 설정 tab (POST /api/remote/approval-code); `node src/remote.ts approve` still works on the server. */
const approve = () => link('settings.html#remote', t('setup.remote.approve'));

function remoteItem(f: Facts): Item {
  const base = { key: 'remote', title: t('setup.remote.title') };
  const r = f.remote;
  const doc = link(`${DOCS}/remote-mcp/README.md#going-public-not-done`, t('setup.remote.doc'));
  if (r.unreadable) return { ...base, status: 'warn', detail: t('setup.remote.unreadable'), action: doc };
  if (r.attention) return { ...base, status: 'warn', detail: t('setup.remote.attention', { n: r.attention }), action: approve() };
  if (r.liveTokens > 0) return { ...base, status: 'ok', detail: t('setup.remote.ok', { n: r.clients }), action: null };
  if (r.clients > 0) return { ...base, status: 'warn', detail: t('setup.remote.noToken'), action: approve() };
  // Public already: what is left is the approval code and adding the connector in claude.ai
  if (r.publicUrl) {
    return {
      ...base,
      status: 'missing',
      detail: t('setup.remote.public'),
      action: approve(),
    };
  }
  return { ...base, status: 'missing', detail: t('setup.remote.missing'), action: doc };
}

function claudeCodeItem(f: Facts): Item {
  const base = { key: 'claude-code', title: 'Claude Code MCP' };
  const add = command(`claude plugin marketplace add ${(f.site ?? SITE).checkout} && claude plugin install portboard@portboard`);
  if (!f.claudeCode) return { ...base, status: 'warn', detail: t('setup.claude.unknown'), action: add };
  if (f.claudeCode.plugin) return { ...base, status: 'ok', detail: t('setup.claude.plugin'), action: null };
  if (f.claudeCode.registered) return { ...base, status: 'ok', detail: t('setup.claude.registered'), action: null };
  return { ...base, status: 'missing', detail: t('setup.claude.missing'), action: add };
}

function usageItem(f: Facts): Item {
  const base = { key: 'usage', title: t('setup.usage.title') };
  const u = f.usage;
  const parts = [
    u.pinned && t('setup.usage.pinned', { n: u.pinned }),
    u.labels && t('setup.usage.labels', { n: u.labels }),
    u.alerts + u.deviceAlerts && t('setup.usage.alerts', { n: u.alerts + u.deviceAlerts }),
    u.names && t('setup.usage.lanNames', { n: u.names }),
  ].filter(Boolean);
  if (parts.length) return { ...base, status: 'ok', detail: parts.join(' · '), action: null };
  return {
    ...base,
    status: 'missing',
    detail: t('setup.usage.missing'),
    action: link(`${DOCS}/dashboard.md`, t('setup.usage.doc')),
  };
}

const PERSONAL_OS = /^(macos|ios|android|windows)$/i;

function writeDevicesItem(f: Facts): Item {
  const base = { key: 'write-devices', title: t('setup.write.title') };
  const w = f.writeDevices;
  const doc = link(`${DOCS}/security.md#write-devices`, t('setup.write.title'));
  if (w.error) {
    return {
      ...base,
      status: 'warn',
      detail: t('setup.write.error', { path: w.path, error: w.error }),
      action: /600/.test(w.error) ? command(`chmod 600 ${w.path}`) : doc,
    };
  }
  const devices = w.ownerDevices ?? [];
  if (w.list) {
    const others = devices.filter((d) => !w.list!.some((e) => e.toLowerCase().split('.')[0] === d.name.toLowerCase())).length;
    const list = w.list.join(', ');
    return { ...base, status: 'ok', detail: others ? t('setup.write.okOthers', { list, n: others }) : t('setup.write.ok', { list }), action: null };
  }
  const names = devices.map((d) => d.name);
  const who = w.ownerDevices === null ? t('setup.write.whoAll') : t('setup.write.whoSome', { n: names.length, names: names.join(', ') });
  const picks = devices.filter((d) => d.os && PERSONAL_OS.test(d.os)).map((d) => d.name.replace(/[^A-Za-z0-9-]/g, ''));
  const json = JSON.stringify({ writeDevices: picks.length ? picks : [t('setup.write.laptop'), t('setup.write.phone')] });
  return {
    ...base,
    status: 'warn',
    detail: t('setup.write.open', { who }),
    action: command(`umask 077; printf '%s\\n' '${json}' > ${w.path}`, picks.length ? t('setup.write.personal') : t('setup.write.choose')),
  };
}

/** The items that hold a secret link to its rotation runbook (#31); the connector also to where its tokens are managed. */
const links = (): Record<string, { href: string; label: string }[]> => ({
  alerts: [{ href: RUNBOOKS.ntfy, label: t('setup.links.ntfy') }],
  proxmox: [{ href: RUNBOOKS.proxmox, label: t('setup.links.token') }],
  'pve-ports': [{ href: RUNBOOKS.ssh, label: t('setup.links.key') }],
  'win-ports': [{ href: RUNBOOKS.ssh, label: t('setup.links.key') }],
  'write-devices': [
    { href: 'settings.html#write-devices', label: t('setup.links.pick') },
    { href: `${DOCS}/security.md#write-devices`, label: t('setup.links.writeDoc') },
  ],
  remote: [
    { href: 'settings.html#remote', label: t('setup.links.remote') },
    { href: RUNBOOKS.remote, label: t('setup.links.token') },
  ],
});

export function assess(f: Facts, now = Date.now()): Checklist {
  const LINKS = links();
  const node = SITE.pve.node;
  const items = [
    alertItem(f),
    proxmoxItem(f, now),
    sshItem('pve-ports', t('setup.pvePorts.title', { node }), t('setup.pvePorts.what', { node }), f.pvePorts, PVE_SETUP_URL),
    sshItem('win-ports', t('setup.winPorts.title'), t('setup.winPorts.what'), f.winPorts, WIN_SETUP_URL),
    macItem(f),
    menubarItem(f, now),
    remoteItem(f),
    claudeCodeItem(f),
    writeDevicesItem(f),
    usageItem(f),
  ].map((i) => (LINKS[i.key] ? { ...i, links: LINKS[i.key] } : i));
  const ok = items.filter((i) => i.status === 'ok').length;
  return { items, ok, total: items.length, summary: t('setup.summary', { ok, total: items.length }) };
}

// ---------- reading the facts ----------

const readJson = async (path: string): Promise<{ value: any } | null> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { value: undefined };
  }
};

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** remote.json → counts only (hashes and client names stay here) */
export function remoteFacts(raw: { value: any } | null, now: number): Facts['remote'] {
  if (!raw) return { clients: 0, liveTokens: 0, publicUrl: false, unreadable: false };
  if (raw.value === undefined) return { clients: 0, liveTokens: 0, publicUrl: false, unreadable: true };
  const s = obj(raw.value);
  const live = Object.values(obj(s.tokens)).filter((t: any) => (t?.kind === 'access' || t?.kind === 'refresh') && typeof t.expiresAt === 'number' && t.expiresAt > now).length;
  let attention = 0;
  try {
    attention = connectorView({ ...s, clients: obj(s.clients), tokens: obj(s.tokens) } as any, now).attention;
  } catch {
    // a malformed entry: the counts above still stand
  }
  return { clients: Object.keys(obj(s.clients)).length, liveTokens: live, publicUrl: typeof s.publicUrl === 'string' && !!s.publicUrl, unreadable: false, attention };
}

/** ~/.claude.json → whether a server named portboard is registered, user scope or any project's (nothing else read out) */
export function claudeCodeFacts(raw: { value: any } | null, settings: { value: any } | null = null): Facts['claudeCode'] {
  const plugin = obj(obj(settings?.value).enabledPlugins)['portboard@portboard'] === true;
  if (!raw || raw.value === undefined) return plugin ? { registered: false, plugin } : null;
  const c = obj(raw.value);
  const has = (m: unknown) => Object.prototype.hasOwnProperty.call(obj(m), 'portboard');
  return { registered: has(c.mcpServers) || Object.values(obj(c.projects)).some((p) => has(obj(p).mcpServers)), plugin };
}

/** compute-pool hosts → the Mac's agent (kind agent, or a host named mac) */
export function macFacts(pool: PoolStatus): Facts['macAgent'] {
  if (!pool.available) return null;
  const h = pool.hosts.find((x) => x.kind === 'agent') ?? pool.hosts.find((x) => /mac/i.test(x.name));
  if (!h) return { present: false, connected: false, state: null };
  return { present: true, connected: h.kind === 'agent' ? !!h.agent?.connected : h.state === 'ok', state: h.state ?? null };
}

export function usageFacts(prefs: Awaited<ReturnType<typeof loadPrefs>>, names: Record<string, string>): Facts['usage'] {
  const ports = Object.values(prefs.ports ?? {});
  return {
    pinned: ports.filter((p) => p?.pinned).length,
    labels: ports.filter((p) => typeof p?.label === 'string' && p.label).length,
    alerts: ports.filter((p) => p?.alert).length,
    deviceAlerts: Object.keys(prefs.deviceAlerts ?? {}).length,
    names: Object.keys(names).length,
  };
}

const collectorFact = (sw: SelfWatchStatus | null, name: string): CollectorFact | null => {
  const c = sw?.collectors.find((x) => x.name === name);
  return c ? { view: c.view, lastError: c.lastError } : null;
};

export interface FactSources {
  /** The self-watch view: the server's live one, or (default) what it last wrote to selfwatch.json */
  selfwatch?(): Promise<SelfWatchStatus | null>;
  pool?(): Promise<PoolStatus>;
  now?: number;
  /** files, for tests; defaults are production's setup files (see the top) and this profile's prefs/clients */
  files?: Partial<Record<'alertChannel' | 'remote' | 'claude' | 'prefs' | 'clients' | 'proxmox' | 'menubar' | 'access', string>>;
  /** `tailscale status --json` (default: the shared cached run), null when it fails */
  tailscaleStatus?(): Promise<string | null>;
  /** env for PORTBOARD_WRITE_DEVICES / PORTBOARD_OWNER_LOGIN (default process.env) */
  env?: Record<string, string | undefined>;
  /** the resolved site values (default: site(), runtime sources first) */
  site?(): Promise<SiteFact>;
}

/**
 * `tailscale status --json` → the untagged devices logged in as the owner, other than this server. The owner is
 * `ownerLogin` (PORTBOARD_OWNER_LOGIN) when given, else this node's user. null when the JSON can't be read.
 */
export function ownerDevicesFromStatus(json: string | null, ownerLogin?: string | null): WriteDevicesFact['ownerDevices'] {
  if (!json) return null;
  let st: any;
  try {
    st = JSON.parse(json);
  } catch {
    return null;
  }
  const users = obj(st?.User);
  const want = (ownerLogin ?? ownerFromStatus(json) ?? '').trim().toLowerCase();
  if (!want) return [];
  const ids = new Set(Object.entries(users).filter(([, u]) => String(obj(u).LoginName ?? '').toLowerCase() === want).map(([id]) => id));
  const selfId = String(obj(st?.Self).ID ?? '');
  const out: { name: string; os: string | null }[] = [];
  for (const p of Object.values(obj(st?.Peer))) {
    const n = obj(p);
    if (!ids.has(String(n.UserID)) || (Array.isArray(n.Tags) && n.Tags.length) || String(n.ID ?? '') === selfId) continue;
    const name = String(n.DNSName || n.HostName || '').replace(/\.$/, '').split('.')[0].slice(0, 80);
    if (name) out.push({ name, os: typeof n.OS === 'string' && n.OS ? n.OS : null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** ~/… for a path under the home directory (for commands to copy) */
const tilde = tildePath;

/** Production's alert channel and remote.json, whatever profile this is (env overrides still win). */
export function setupFiles(env: Record<string, string | undefined> = process.env, home = homedir()) {
  return {
    alertChannel: env.PORTBOARD_ALERT_CHANNEL ?? join(home, '.local', 'state', 'compute-pool', 'alerts.json'),
    remote: env.PORTBOARD_REMOTE_CONFIG ?? join(home, '.config', 'portboard', 'remote.json'),
    claude: join(home, '.claude.json'),
    claudeSettings: join(home, '.claude', 'settings.json'),
  };
}

export async function collectFacts(src: FactSources = {}): Promise<Facts> {
  const now = src.now ?? Date.now();
  const files = { ...setupFiles(), prefs: PATHS.prefs, clients: PATHS.clients, proxmox: PATHS.proxmox, menubar: MENUBAR_SEEN_PATH, access: PATHS.access, ...src.files };
  const env = src.env ?? process.env;
  const [channel, pmx, sw, pool, remote, claude, claudeSettings, prefs, names, menubar, allow, status] = await Promise.all([
    loadChannel(files.alertChannel),
    loadProxmoxConfig(files.proxmox).catch(() => ({ cfg: null, error: 'unreadable', looseMode: false })),
    (src.selfwatch ?? (() => savedStatus()))().catch(() => null),
    (src.pool ?? poolStatus)().catch((): PoolStatus => ({ available: false, source: null, url: '', healthAt: null, hosts: [] })),
    readJson(files.remote),
    readJson(files.claude),
    readJson(files.claudeSettings),
    loadPrefs(files.prefs),
    loadNames(files.clients),
    loadMenubarSeen(files.menubar),
    loadWriteDevices(files.access, env),
    (src.tailscaleStatus ?? (async () => {
      const r = await runShared('tailscale', ['status', '--json']);
      return r.ok ? r.stdout : null;
    }))().catch(() => null),
  ]);
  const exp = sw?.expiry.items.find((i) => i.key === 'proxmox-token');
  return {
    alertChannel: channelKinds(channel),
    proxmox: {
      configured: !!pmx.cfg,
      error: pmx.error ?? null,
      looseMode: !!pmx.looseMode,
      collector: collectorFact(sw, 'proxmox'),
      expiry: exp ? { status: exp.status, expiresAt: exp.expiresAt } : null,
    },
    pvePorts: collectorFact(sw, 'pve-ports'),
    winPorts: collectorFact(sw, 'win-ports'),
    macAgent: macFacts(pool),
    menubarSeenAt: menubar,
    remote: remoteFacts(remote, now),
    claudeCode: claudeCodeFacts(claude, claudeSettings),
    usage: usageFacts(prefs, names),
    writeDevices: {
      list: allow && !allow.error ? allow.list : null,
      error: allow?.error ?? null,
      path: tilde(files.access),
      ownerDevices: ownerDevicesFromStatus(status, env.PORTBOARD_OWNER_LOGIN?.trim() || null),
    },
  };
}

/** collectFacts plus this server's site values (runtime sources first), for the checklist's commands. */
export async function collectSetupFacts(src: FactSources = {}): Promise<Facts> {
  const [facts, here] = await Promise.all([collectFacts(src), (src.site ?? (() => site()))().catch((): SiteFact => SITE)]);
  return { ...facts, site: { host: here.host, dnsName: here.dnsName, user: here.user, checkout: here.checkout } };
}

// ---------- the menu bar's requests ----------

// The Mac app (mac-app/) polls with User-Agent portboard-mac/<version>, the legacy SwiftBar plugin
// (menubar/portboard.30s.mjs) with portboard-menubar/1; either counts as the menu bar being installed. The server notes
// when it last saw one in a small state file (at most every 10 minutes), so the MCP process and a restart know it too.
export const MENUBAR_SEEN_PATH = join(PATHS.stateDir, 'menubar-seen.json');
export const MENUBAR_UA = /^portboard-(?:menubar|mac)\b/;
const NOTE_EVERY_MS = 10 * 60_000;

export async function loadMenubarSeen(path = MENUBAR_SEEN_PATH): Promise<number | null> {
  const raw = await readJson(path);
  const at = obj(raw?.value).lastSeen;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

export function menubarNoter(path = MENUBAR_SEEN_PATH, now: () => number = Date.now) {
  let noted = 0;
  return (req: Pick<IncomingMessage, 'headers'>): Promise<void> | null => {
    if (!MENUBAR_UA.test(String(req.headers['user-agent'] ?? ''))) return null;
    const t = now();
    if (t - noted < NOTE_EVERY_MS) return null;
    noted = t;
    return writePrivate(path, `${JSON.stringify({ lastSeen: t })}\n`)
      .catch(() => {});
  };
}

/** The server's: called for every request, writes only for the menu bar's and only every 10 minutes. */
export const noteMenubar = menubarNoter();
