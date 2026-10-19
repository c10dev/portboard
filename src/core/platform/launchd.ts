// launchd user agents for `portboard install-service` on macOS (#11): the counterpart of the systemd user units in
// src/cli.ts, written to ~/Library/LaunchAgents and loaded with `launchctl bootstrap gui/<uid>`.
//
// The text is pure (test/platform.test.ts). Output goes to ~/Library/Logs/portboard/<label>.log, since a Mac has no
// journal; the running server does not drive launchd itself (a port's owner on a Mac is a plain process).

import { dirname, join } from 'node:path';

export type AgentKind = 'dashboard' | 'remote' | 'agent';

export const LAUNCHD_LABELS: Record<AgentKind, string> = {
  dashboard: 'io.github.c10dev.portboard',
  remote: 'io.github.c10dev.portboard-remote',
  agent: 'io.github.c10dev.portboard-agent',
};

/** First comment of every plist install-service writes; uninstall-service removes only files that carry it */
export const PLIST_MARKER = '<!-- Written by `portboard install-service`';

export const launchAgentsDir = (home: string) => join(home, 'Library', 'LaunchAgents');
export const launchdLogDir = (home: string) => join(home, 'Library', 'Logs', 'portboard');
export const plistPath = (home: string, kind: AgentKind) => join(launchAgentsDir(home), `${LAUNCHD_LABELS[kind]}.plist`);

function checkPath(p: string): string {
  if (/[\0]/.test(p)) throw new Error(`path with a NUL can't go in a plist: ${JSON.stringify(p)}`);
  return p;
}

/** Text for a plist <string>: XML-escaped */
export function xmlString(s: string): string {
  return `<string>${checkPath(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`;
}

export interface PlistInput {
  node: string;
  root: string;
  version: string;
  home: string;
}

export function plistText(kind: AgentKind, o: PlistInput): string {
  const bin = join(o.root, 'bin', 'portboard');
  const args = kind === 'dashboard' ? [o.node, '--max-semi-space-size=16', bin, 'start'] : [o.node, bin, kind];
  // lsof lives in /usr/sbin on macOS; Homebrew's prefix for tailscale and docker
  const path = [dirname(o.node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((d, i, a) => a.indexOf(d) === i).join(':');
  const env: [string, string][] = [['PATH', path], ...(kind === 'remote' ? ([['PORTBOARD_REMOTE_PORT', '8794']] as [string, string][]) : [])];
  const label = LAUNCHD_LABELS[kind];
  const log = join(launchdLogDir(o.home), `${label}.log`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `${PLIST_MARKER} (portboard ${o.version}). Edits here are overwritten: rerun it after moving node or Portboard. -->`,
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${xmlString(label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => `    ${xmlString(a)}`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${xmlString(o.root)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.flatMap(([k, v]) => [`    <key>${k}</key>`, `    ${xmlString(v)}`]),
    '  </dict>',
    '  <!-- state and config private to this user (0077), as the systemd units -->',
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>StandardOutPath</key>',
    `  ${xmlString(log)}`,
    '  <key>StandardErrorPath</key>',
    `  ${xmlString(log)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** launchctl arguments that load these agents now and at every login */
export function bootstrapCommands(kinds: readonly AgentKind[], uid: number, home: string): string[][] {
  return kinds.map((k) => ['launchctl', 'bootstrap', `gui/${uid}`, plistPath(home, k)]);
}

export function bootoutCommands(kinds: readonly AgentKind[], uid: number): string[][] {
  return kinds.map((k) => ['launchctl', 'bootout', `gui/${uid}/${LAUNCHD_LABELS[k]}`]);
}
