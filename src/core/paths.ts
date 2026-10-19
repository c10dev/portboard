// Every config and state path Portboard reads or writes, resolved in one place for one of two profiles.
//
//   production   PORTBOARD_PORT unset or 8790 (and PORTBOARD_REMOTE_PORT unset or 8794), or PORTBOARD_PROFILE=production
//                config ~/.config/portboard, state ~/.local/state/portboard
//   preview      anything else (a dev server from a worktree on 879x/880x), or PORTBOARD_PROFILE=preview
//                config and state ~/.local/state/portboard/previews/<port>/
//                seeded once from production with a copy (never a symlink) of prefs.json, clients.json and
//                portboard.json (the site config, site.ts)
//                remote.json (OAuth state) is its own; secrets (proxmox.json, pveports/winports targets, the SSH key,
//                compute-pool's alerts.json) are read from production and never written
//                alerts are off unless PORTBOARD_PREVIEW_ALERTS=1: no checker, no 새 기기 messages, and the channel
//                points at a file that doesn't exist, so the test button can't send either
//
// A per-file env override (PORTBOARD_PREFS, PORTBOARD_STATE_DIR, …) always wins over the profile.
// This module has no side effects at import: seeding and the startup line are explicit calls (server.ts, remote.ts),
// because the stdio MCP server imports the same modules and its stdout is the JSON-RPC channel.

import { chmod, constants, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PRODUCTION_PORT = 8790;
export const PRODUCTION_REMOTE_PORT = 8794;

export type Profile = 'production' | 'preview';

export interface Paths {
  profile: Profile;
  /** The port this process serves (PORTBOARD_PORT, else PORTBOARD_REMOTE_PORT for the remote server) */
  port: number;
  /** Where this profile's own config lives (prefs, clients, remote) */
  configDir: string;
  /** Where this profile's own state lives (alerts, quiet windows, uptime, known devices) */
  stateDir: string;
  /** Preview only: the production files it was seeded from */
  seedFrom: { prefs: string; clients: string } | null;

  // written by Portboard
  prefs: string;
  clients: string;
  /** Port reservations per project/worktree (#27) */
  reservations: string;
  remoteConfig: string;

  // read only (the owner edits it)
  /** portboard.json: host, tailnet, checkout, repos root and other site values (site.ts, docs/config.md) */
  site: string;
  /** access.json: writeDevices, the devices that may write through tailscale serve (security review v1.0, M1) */
  access: string;
  /** owner-token.json: the sha256 of the owner token for token mode (#12), written by `portboard token`, never the token */
  token: string;
  /** devhealth.json: thresholds of the device health alerts (devhealth.ts, docs/config.md) */
  devhealth: string;
  history: string;
  uptime: string;
  alertsState: string;
  quiet: string;
  alertsLog: string;
  known: string;
  /** 기록: every write, allowed or denied (#30) */
  audit: string;

  // read only (secrets and other programs' files)
  proxmox: string;
  pveports: string;
  winports: string;
  alertChannel: string;
  poolDir: string;

  /** Down alerts and 새 기기 messages may be sent */
  alertsOn: boolean;
}

type Env = Record<string, string | undefined>;

const portOf = (v: string | undefined, fallback: number) => (v === undefined || v === '' ? fallback : Number(v));

export function resolveProfile(env: Env = process.env): { profile: Profile; port: number } {
  const port = portOf(env.PORTBOARD_PORT, PRODUCTION_PORT);
  const remotePort = portOf(env.PORTBOARD_REMOTE_PORT, PRODUCTION_REMOTE_PORT);
  // The remote server only knows PORTBOARD_REMOTE_PORT, so a remote preview is keyed by that.
  const own = port === PRODUCTION_PORT && remotePort !== PRODUCTION_REMOTE_PORT ? remotePort : port;
  if (env.PORTBOARD_PROFILE === 'production') return { profile: 'production', port: own };
  if (env.PORTBOARD_PROFILE === 'preview') return { profile: 'preview', port: own };
  return { profile: own === PRODUCTION_PORT ? 'production' : 'preview', port: own };
}

export function resolvePaths(env: Env = process.env, home = homedir()): Paths {
  const { profile, port } = resolveProfile(env);
  const prodConfig = join(home, '.config', 'portboard');
  const prodState = join(home, '.local', 'state', 'portboard');
  const preview = profile === 'preview';
  const previewDir = join(prodState, 'previews', String(port));
  const configDir = preview ? previewDir : prodConfig;
  const stateDir = env.PORTBOARD_STATE_DIR ?? (preview ? previewDir : prodState);
  const alertsOn = env.PORTBOARD_ALERTS !== 'off' && (!preview || env.PORTBOARD_PREVIEW_ALERTS === '1');
  const prodChannel = join(home, '.local', 'state', 'compute-pool', 'alerts.json');
  return {
    profile,
    port,
    configDir,
    stateDir,
    seedFrom: preview ? { prefs: join(prodConfig, 'prefs.json'), clients: join(prodConfig, 'clients.json') } : null,

    prefs: env.PORTBOARD_PREFS ?? join(configDir, 'prefs.json'),
    clients: env.PORTBOARD_CLIENTS ?? join(configDir, 'clients.json'),
    reservations: env.PORTBOARD_RESERVATIONS ?? join(configDir, 'reservations.json'),
    remoteConfig: env.PORTBOARD_REMOTE_CONFIG ?? join(configDir, 'remote.json'),
    site: env.PORTBOARD_SITE ?? join(configDir, 'portboard.json'),
    // A preview's own (it starts without one: no allowlist), never production's.
    access: env.PORTBOARD_ACCESS ?? join(configDir, 'access.json'),
    // The same for the owner token's hash (#12): a preview needs its own `portboard token`.
    token: env.PORTBOARD_TOKEN_FILE ?? join(configDir, 'owner-token.json'),
    devhealth: env.PORTBOARD_DEVHEALTH ?? join(configDir, 'devhealth.json'),
    // Not under PORTBOARD_STATE_DIR in production (as before); a preview keeps its own.
    history: env.PORTBOARD_HISTORY ?? join(preview ? previewDir : prodState, 'usage-history.json'),
    uptime: env.PORTBOARD_UPTIME ?? join(stateDir, 'uptime.json'),
    alertsState: join(stateDir, 'alerts-state.json'),
    quiet: join(stateDir, 'quiet.json'),
    alertsLog: join(stateDir, 'alerts.jsonl'),
    known: join(stateDir, 'known-devices.json'),
    audit: env.PORTBOARD_AUDIT ?? join(stateDir, 'audit.jsonl'),

    proxmox: env.PORTBOARD_PROXMOX ?? join(prodConfig, 'proxmox.json'),
    pveports: env.PORTBOARD_PVEPORTS ?? join(prodConfig, 'pveports.json'),
    winports: env.PORTBOARD_WINPORTS ?? join(prodConfig, 'winports.json'),
    // A preview without PORTBOARD_PREVIEW_ALERTS=1 gets a channel file that is never created: 알림 채널 없음.
    alertChannel: env.PORTBOARD_ALERT_CHANNEL ?? (preview && !alertsOn ? join(previewDir, 'alerts-channel.disabled.json') : prodChannel),
    poolDir: env.COMPUTE_POOL_DIR ?? join(home, '.local', 'state', 'compute-pool'),

    alertsOn,
  };
}

/** This process's paths, from its environment. */
export const PATHS = resolvePaths();

/**
 * Preview only, once per preview dir: create it and copy production's prefs.json, clients.json and portboard.json into
 * it, so the preview shows the same labels, pins, device links, names and site values. Copies, not links: the preview's writes stay its own.
 * Files production doesn't have, and files moved by an env override, are skipped. Returns the files copied (empty when already seeded or in production).
 */
export async function seedPreview(p: Paths = PATHS): Promise<string[]> {
  if (p.profile !== 'preview' || !p.seedFrom) return [];
  await mkdir(join(p.configDir, '..'), { recursive: true });
  try {
    await mkdir(p.configDir, { mode: 0o700 });
  } catch (err: any) {
    if (err?.code === 'EEXIST') return [];
    throw err;
  }
  const copied: string[] = [];
  for (const [from, to] of [
    [p.seedFrom.prefs, p.prefs],
    [p.seedFrom.clients, p.clients],
    [join(dirname(p.seedFrom.prefs), 'portboard.json'), p.site],
  ]) {
    // An env override points elsewhere on purpose: leave that file alone.
    if (dirname(to) !== p.configDir) continue;
    try {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await chmod(to, 0o600); // a copy keeps the source mode (production files may still be 0664)
      copied.push(to);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return copied;
}

/** The startup line: profile and directories. */
export function describe(p: Paths = PATHS): string {
  const alerts = p.alertsOn ? 'alerts on' : 'alerts off';
  return p.profile === 'production'
    ? `[portboard] profile production (port ${p.port}): config ${p.configDir}, state ${p.stateDir}, ${alerts}`
    : `[portboard] profile preview (port ${p.port}): config+state ${p.configDir}${p.stateDir !== p.configDir ? `, state ${p.stateDir}` : ''}, secrets read-only from production, ${alerts}`;
}
