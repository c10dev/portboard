// The `portboard` command (bin/portboard; c10dev/portboard#9): run the dashboard, the remote MCP server or the stdio
// MCP server, and write systemd user units that run them with this node and this install.
//
//   portboard start                          the dashboard (src/server.ts)
//   portboard remote [approve|status|revoke] the read-only remote MCP server (src/remote.ts)
//   portboard mcp                            the stdio MCP server (src/mcp.ts)
//   portboard agent                          this machine's read-only agent for a board elsewhere (src/agent.ts, #10)
//   portboard install-service [--remote | --agent] [--enable] [--dry-run]
//   portboard uninstall-service [--dry-run]
//   portboard token                          make (or replace) the owner token for token mode (#12)
//
// The unit text and the argument parsing are pure (test/cli.test.ts); main() takes its paths and systemctl from deps.
// On macOS install-service writes launchd agents instead (src/core/platform/launchd.ts, #11; launchctl from deps).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.ts';
import { bootoutCommands, bootstrapCommands, launchAgentsDir, launchdLogDir, PLIST_MARKER, plistPath, plistText, LAUNCHD_LABELS } from './core/platform/launchd.ts';

export const USAGE = `portboard ${VERSION}: dashboard of the ports listening on this server (Linux; macOS read-mostly)

Usage:
  portboard start                       run the dashboard on :8790 (loopback + tailnet)
  portboard remote [approve|status|revoke [id]]
                                        run the read-only remote MCP server on :8794, or manage its clients
  portboard mcp                         run the stdio MCP server (for claude mcp add / Claude Desktop)
  portboard agent                       serve this machine's ports read-only on :8797 to a board on another machine
  portboard install-service [--remote | --agent] [--enable] [--dry-run]
                                        write systemd user units (macOS: launchd agents) for this node
                                        and this install (--remote also the remote MCP unit; --agent only
                                        the agent unit; --enable runs systemctl / launchctl for you)
  portboard uninstall-service [--dry-run]
                                        disable and remove the units install-service wrote
  portboard token                       make the owner token for token mode (printed once; running it
                                        again replaces it, and the old one stops working)
  portboard --version | --help

Docs: https://github.com/c10dev/portboard/blob/main/docs/setup.md`;

export type Command = 'start' | 'remote' | 'mcp' | 'agent' | 'install-service' | 'uninstall-service' | 'token' | 'version' | 'help';
const COMMANDS: readonly string[] = ['start', 'remote', 'mcp', 'agent', 'install-service', 'uninstall-service', 'token'];
const FLAGS: Record<string, readonly string[]> = {
  'install-service': ['--remote', '--agent', '--enable', '--dry-run'],
  'uninstall-service': ['--dry-run'],
  token: [],
};

export interface Parsed {
  cmd: Command;
  /** what follows the command, for remote (approve, status, revoke <id>) */
  rest: string[];
  remote: boolean;
  /** install-service --agent: the agent unit alone (a machine the board reads, with no dashboard of its own) */
  agent: boolean;
  enable: boolean;
  dryRun: boolean;
}

/** argv after `portboard`; throws with a readable message on an unknown command or flag */
export function parseArgs(argv: readonly string[]): Parsed {
  const base = { rest: [], remote: false, agent: false, enable: false, dryRun: false };
  const [first, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') return { cmd: 'help', ...base };
  if (first === '--version' || first === '-v' || first === 'version') return { cmd: 'version', ...base };
  if (!COMMANDS.includes(first)) throw new Error(`unknown command "${first}" (portboard --help)`);
  const cmd = first as Command;
  // the servers keep their own arguments (src/remote.ts reads approve/status/revoke)
  if (cmd === 'start' || cmd === 'remote' || cmd === 'mcp' || cmd === 'agent') return { ...base, cmd, rest };
  const allowed = FLAGS[cmd] ?? [];
  for (const a of rest) if (!allowed.includes(a)) throw new Error(`${cmd}: unknown option "${a}" (allowed: ${allowed.join(' ')})`);
  const remote = rest.includes('--remote');
  const agent = rest.includes('--agent');
  if (remote && agent) throw new Error(`${cmd}: --remote and --agent don't go together (the agent unit is for a machine without the dashboard)`);
  return { ...base, cmd, remote, agent, enable: rest.includes('--enable'), dryRun: rest.includes('--dry-run') };
}

// ---- systemd units ----

export type UnitKind = 'dashboard' | 'remote' | 'agent';
export const UNIT_NAMES: Record<UnitKind, string> = { dashboard: 'portboard', remote: 'portboard-remote', agent: 'portboard-agent' };
const DESCRIPTIONS: Record<UnitKind, string> = {
  dashboard: 'Description=Portboard — listening ports dashboard on :8790 (loopback + tailnet)',
  remote: 'Description=Portboard remote MCP (read-only) on :8794 (loopback + tailnet)',
  agent: 'Description=Portboard agent (read-only, for a board on another machine) on :8797 (loopback + tailnet)',
};
/** First line of every unit install-service writes; uninstall-service removes only files that start with it */
export const UNIT_MARKER = '# Written by `portboard install-service`';

export interface UnitInput {
  /** the node binary (process.execPath when installing) */
  node: string;
  /** the package root: a checkout or <prefix>/lib/node_modules/portboard */
  root: string;
  version: string;
}

function checkPath(p: string): string {
  if (/[\n\r\0]/.test(p)) throw new Error(`path with a newline or NUL can't go in a unit file: ${JSON.stringify(p)}`);
  return p;
}

/** One argument of ExecStart=: % is a specifier and $ a variable to systemd, whitespace and quotes need quoting */
export function systemdArg(arg: string): string {
  const s = checkPath(arg).replace(/%/g, '%%').replace(/\$/g, '$$$$');
  return /[\s"'\\;]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;
}

/** A value of WorkingDirectory= or Environment= (specifiers expand there too; Environment quotes the whole assignment) */
const systemdPath = (p: string) => checkPath(p).replace(/%/g, '%%');
const envLine = (assignment: string) => {
  const s = systemdPath(assignment);
  return `Environment=${/[\s"\\]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s}`;
};

/** The text of portboard.service or portboard-remote.service, with the hardening of deploy/portboard.service */
export function unitText(kind: UnitKind, o: UnitInput): string {
  const bin = join(o.root, 'bin', 'portboard');
  // The node binary's folder first: an nvm node isn't on the system PATH, and the dashboard starts npm dev servers.
  const path = [dirname(o.node), '/usr/local/bin', '/usr/bin', '/bin'].filter((d, i, a) => a.indexOf(d) === i).join(':');
  const dashboard = kind === 'dashboard';
  const exec = dashboard
    ? // RSS: V8 otherwise keeps a 2 × 64 MB young generation after every worktree scan (deploy/portboard.service)
      [o.node, '--max-semi-space-size=16', bin, 'start']
    : [o.node, bin, kind];
  return [
    `${UNIT_MARKER} (portboard ${o.version}). Edits here are overwritten:`,
    '# rerun it after moving node (a new nvm version) or Portboard, then `systemctl --user daemon-reload`.',
    '',
    '[Unit]',
    DESCRIPTIONS[kind],
    '',
    '[Service]',
    `WorkingDirectory=${systemdPath(o.root)}`,
    `ExecStart=${exec.map(systemdArg).join(' ')}`,
    envLine(`PATH=${path}`),
    ...(kind === 'remote' ? ['Environment=PORTBOARD_REMOTE_PORT=8794'] : []),
    // State and config files private to this user (0600 files, 0700 dirs): security review v1.0, L6
    'NoNewPrivileges=yes',
    'UMask=0077',
    '# The Tailscale IP may not exist yet right after boot; the server exits and we retry.',
    'Restart=always',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export const unitDir = (home: string, env: Record<string, string | undefined> = {}) =>
  join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user');

export const unitsFor = (remote: boolean, agent = false): UnitKind[] => (agent ? ['agent'] : remote ? ['dashboard', 'remote'] : ['dashboard']);

/** The commands install-service prints (or runs with --enable) */
export function enableCommands(kinds: readonly UnitKind[]): string[][] {
  return [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', ...kinds.map((k) => UNIT_NAMES[k])],
  ];
}

// ---- main ----

export interface Deps {
  out: (s: string) => void;
  err: (s: string) => void;
  node: string;
  root: string;
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** runs systemctl with these arguments; resolves false (after printing why) on failure */
  systemctl: (args: string[]) => Promise<boolean>;
  /** macOS: runs launchctl with these arguments, the same way (#11) */
  launchctl?: (args: string[]) => Promise<boolean>;
  /** macOS: the user id for launchctl's gui/<uid> domain */
  uid?: number;
  /** owner-token.json and access.json of this profile (paths.ts; PORTBOARD_PORT picks a preview's); read when needed */
  accessFiles?: () => Promise<{ token: string; access: string }>;
}

const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/+$/, '');

function defaultDeps(): Deps {
  return {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    node: process.execPath,
    root: ROOT,
    home: homedir(),
    env: process.env,
    platform: process.platform,
    systemctl: execTool('systemctl'),
    launchctl: execTool('launchctl'),
  };
}

const shown = (cmd: readonly string[]) => cmd.join(' ');

/** Runs `cmd args` without a shell; resolves false (after printing why) on failure */
function execTool(cmd: string) {
  return (args: string[]) =>
    new Promise<boolean>((resolve) =>
      execFile(cmd, args, { timeout: 60_000 }, (e, _out, stderr) => {
        if (e) process.stderr.write(`${cmd} ${args.join(' ')}: ${(stderr || e.message).trim()}\n`);
        resolve(!e);
      }),
    );
}

const uidOf = (d: Deps) => d.uid ?? (typeof process.getuid === 'function' ? process.getuid() : userInfo().uid);

/** macOS (#11): launchd agents in ~/Library/LaunchAgents, loaded with `launchctl bootstrap` when --enable */
async function installLaunchd(p: Parsed, d: Deps): Promise<number> {
  const kinds = unitsFor(p.remote, p.agent);
  const input = { node: d.node, root: d.root, version: VERSION, home: d.home };
  if (d.root.split('/').includes('_npx')) {
    d.err('warning: this is an npx cache copy, which npm may delete. Install for good first: npm i -g portboard');
  }
  for (const k of kinds) {
    const file = plistPath(d.home, k);
    const text = plistText(k, input);
    if (p.dryRun) {
      d.out(`# ${file}\n${text}`);
      continue;
    }
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    mkdirSync(launchAgentsDir(d.home), { recursive: true });
    // launchd won't make the log folder itself
    mkdirSync(launchdLogDir(d.home), { recursive: true, mode: 0o700 });
    writeFileSync(file, text, { mode: 0o644 });
    d.out(`${before === null ? 'wrote' : before === text ? 'unchanged' : 'updated'} ${file}`);
  }
  const cmds = bootstrapCommands(kinds, uidOf(d), d.home);
  if (p.enable && !p.dryRun) {
    const launchctl = d.launchctl ?? execTool('launchctl');
    for (const c of cmds) if (!(await launchctl(c.slice(1)))) return 1;
    d.out(`started: ${kinds.map((k) => LAUNCHD_LABELS[k]).join(', ')}. ${p.agent ? 'Agent: http://127.0.0.1:8797/agent/v1/info' : 'Dashboard: http://127.0.0.1:8790'}`);
  } else {
    d.out(`\n${p.dryRun ? 'Would write the above. Then load' : 'Load'} ${kinds.length > 1 ? 'them' : 'it'} (launchd starts ${kinds.length > 1 ? 'them' : 'it'} again at every login):\n  ${cmds.map(shown).join(' && ')}`);
  }
  d.out(`Logs: ${launchdLogDir(d.home)}. On macOS restart, dev servers and the memory view are not available (docs/platforms.md).`);
  if (p.remote) d.out('The remote server is public only after `tailscale funnel`: docs/remote-mcp/README.md.');
  if (p.agent) d.out('Say who may read it (agent.allow or agent.token in portboard.json), then list it in the board\'s agents: docs/multi-host.md.');
  return 0;
}

async function uninstallLaunchd(p: Parsed, d: Deps): Promise<number> {
  const ours = (['dashboard', 'remote', 'agent'] as const).map((k) => ({ kind: k, file: plistPath(d.home, k) })).filter((u) => existsSync(u.file));
  const foreign = ours.filter((u) => !readFileSync(u.file, 'utf8').includes(PLIST_MARKER));
  for (const u of foreign) d.err(`left alone: ${u.file} was not written by install-service (remove it by hand)`);
  const mine = ours.filter((u) => !foreign.includes(u));
  if (!mine.length) {
    d.out(`nothing to remove in ${launchAgentsDir(d.home)}`);
    return foreign.length ? 1 : 0;
  }
  const cmds = bootoutCommands(mine.map((u) => u.kind), uidOf(d));
  if (p.dryRun) {
    for (const c of cmds) d.out(`would run: ${shown(c)}`);
    for (const u of mine) d.out(`would remove ${u.file}`);
    return 0;
  }
  const launchctl = d.launchctl ?? execTool('launchctl');
  // an agent that isn't loaded makes bootout fail: the file goes anyway
  for (const c of cmds) if (!(await launchctl(c.slice(1)))) d.err(`continuing: ${shown(c)} failed (not loaded?)`);
  for (const u of mine) {
    rmSync(u.file);
    d.out(`removed ${u.file}`);
  }
  d.out('State and config stay in ~/.local/state/portboard and ~/.config/portboard.');
  return foreign.length ? 1 : 0;
}

async function installService(p: Parsed, d: Deps): Promise<number> {
  if (d.platform === 'darwin') return installLaunchd(p, d);
  if (d.platform !== 'linux') {
    d.err(`install-service writes systemd user units (Linux) or launchd agents (macOS), not for ${d.platform}. Run \`portboard start\` under your own service manager, or use the Docker image (docs/platforms.md).`);
    return 1;
  }
  const dir = unitDir(d.home, d.env);
  const kinds = unitsFor(p.remote, p.agent);
  const input: UnitInput = { node: d.node, root: d.root, version: VERSION };
  if (d.root.split('/').includes('_npx')) {
    d.err('warning: this is an npx cache copy, which npm may delete. Install for good first: npm i -g portboard');
  }
  for (const k of kinds) {
    const file = join(dir, `${UNIT_NAMES[k]}.service`);
    const text = unitText(k, input);
    if (p.dryRun) {
      d.out(`# ${file}\n${text}`);
      continue;
    }
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, { mode: 0o644 });
    d.out(`${before === null ? 'wrote' : before === text ? 'unchanged' : 'updated'} ${file}`);
  }
  const cmds = enableCommands(kinds);
  if (p.enable && !p.dryRun) {
    for (const c of cmds) if (!(await d.systemctl(c.slice(1)))) return 1;
    d.out(`started: ${kinds.map((k) => UNIT_NAMES[k]).join(', ')}. ${p.agent ? 'Agent: http://127.0.0.1:8797/agent/v1/info' : 'Dashboard: http://127.0.0.1:8790'}`);
  } else {
    d.out(`\n${p.dryRun ? 'Would write the above. Then start' : 'Start'} ${kinds.length > 1 ? 'them' : 'it'} (and at every login):\n  ${cmds.map(shown).join(' && ')}`);
  }
  d.out('Keep it running after logout: sudo loginctl enable-linger $USER');
  if (p.remote) d.out('The remote server is public only after `tailscale funnel`: docs/remote-mcp/README.md.');
  if (p.agent) d.out('Say who may read it (agent.allow or agent.token in portboard.json), then list it in the board\'s agents: docs/multi-host.md.');
  return 0;
}

async function uninstallService(p: Parsed, d: Deps): Promise<number> {
  if (d.platform === 'darwin') return uninstallLaunchd(p, d);
  const dir = unitDir(d.home, d.env);
  const ours = (['dashboard', 'remote', 'agent'] as const)
    .map((k) => ({ name: UNIT_NAMES[k], file: join(dir, `${UNIT_NAMES[k]}.service`) }))
    .filter((u) => existsSync(u.file));
  const foreign = ours.filter((u) => !readFileSync(u.file, 'utf8').startsWith(UNIT_MARKER));
  for (const u of foreign) d.err(`left alone: ${u.file} was not written by install-service (remove it by hand)`);
  const mine = ours.filter((u) => !foreign.includes(u));
  if (!mine.length) {
    d.out(`nothing to remove in ${dir}`);
    return foreign.length ? 1 : 0;
  }
  const disable = ['--user', 'disable', '--now', ...mine.map((u) => u.name)];
  if (p.dryRun) {
    d.out(`would run: systemctl ${disable.join(' ')}`);
    for (const u of mine) d.out(`would remove ${u.file}`);
    d.out('would run: systemctl --user daemon-reload');
    return 0;
  }
  // disable before removing, so no dangling default.target.wants link is left behind
  if (!(await d.systemctl(disable))) d.err('continuing: removing the unit files anyway');
  for (const u of mine) {
    rmSync(u.file);
    d.out(`removed ${u.file}`);
  }
  await d.systemctl(['--user', 'daemon-reload']);
  d.out('State and config stay in ~/.local/state/portboard and ~/.config/portboard.');
  return foreign.length ? 1 : 0;
}

/**
 * `portboard token` (#12): a new owner token, its sha256 written to owner-token.json (0600, atomically), the token
 * printed once on stdout and nowhere else. Running it again is the rotation: the old token stops working at the next
 * request (the server reads the file on every write).
 */
async function ownerToken(d: Deps): Promise<number> {
  const { generateToken, loadAccessPolicy, loadTokenHash, saveTokenHash } = await import('./core/access.ts');
  const files = await (d.accessFiles ?? (async () => (await import('./core/paths.ts')).PATHS))();
  const before = await loadTokenHash(files.token);
  const { token, hash } = generateToken();
  await saveTokenHash(files.token, hash);
  d.out(token);
  d.err(`${before.hash ? 'Replaced the owner token (the old one no longer works)' : 'Owner token made'}; its hash is in ${files.token}.`);
  d.err('It is shown only now. Paste it in the dashboard (Settings > Display > Owner token) or send it as "Authorization: Bearer <token>".');
  const policy = await loadAccessPolicy(files.access, files.token, d.env);
  if (policy.mode !== 'token') d.err('Token mode is off: set "mode": "token" in access.json or PORTBOARD_ACCESS_MODE=token (docs/setup.md#without-tailscale).');
  return 0;
}

/** Runs one server module as if it were started with `node <entry> ...rest` (they read process.argv themselves) */
function asEntry(entry: string, rest: readonly string[]) {
  process.argv = [process.argv[0], join(ROOT, entry), ...rest];
}

export async function main(argv: readonly string[], deps: Partial<Deps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (e) {
    d.err(`portboard: ${(e as Error).message}`);
    return 2;
  }
  switch (p.cmd) {
    case 'help':
      d.out(USAGE);
      return 0;
    case 'version':
      d.out(VERSION);
      return 0;
    case 'install-service':
      return installService(p, d);
    case 'uninstall-service':
      return uninstallService(p, d);
    case 'token':
      return ownerToken(d);
    // The servers keep running after these imports resolve (listeners, readline); main's exit code is not used.
    case 'start':
      asEntry('src/server.ts', p.rest);
      await import('./server.ts');
      return 0;
    case 'remote':
      asEntry('src/remote.ts', p.rest);
      await import('./remote.ts');
      return 0;
    case 'agent':
      asEntry('src/agent.ts', p.rest);
      await import('./agent.ts');
      return 0;
    case 'mcp':
      asEntry('src/mcp.ts', p.rest);
      await import('./mcp.ts');
      return 0;
  }
}
