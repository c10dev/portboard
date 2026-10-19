// What the remote (internet-facing) server can reach, and the read-only Core it hands to shared tool code.
// Its own file so feature modules can declare remote tools without importing the remote dispatcher (no cycle).
//
// Changing RemoteCore changes what the internet-facing server can touch: review it with
// docs/remote-mcp/SECURITY-REVIEW.md. readOnlyCore() names every Core method on purpose, optional ones included: the
// object is typed Required<Core>, so any new Core method (required or optional) fails the typecheck here until
// someone decides what the remote server gets. test/remote-tools.test.ts checks at run time that every method but
// REMOTE_READS refuses (docs/security-review/v1.0.md I1).

import type { Snapshot } from '../core/index.ts';
import type { Devices } from '../core/devices.ts';
import type { Usage } from '../core/usage.ts';
import type { Core } from '../mcp/kit.ts';
import type { StatusExtras } from './redact.ts';

/** What the remote server can reach: reads only. */
export interface RemoteCore {
  snapshot(): Promise<Snapshot>;
  devices(): Promise<Devices>;
  freePorts(count: number, preferred?: number): Promise<number[]>;
  usage(): Promise<Usage>;
  /** For portboard://status: watched ports/devices that are down, and how many 새 기기 are pending */
  statusExtras?(): Promise<StatusExtras>;
}

const notRemote = async (): Promise<never> => {
  throw new Error('not available remotely');
};

/** The Core methods readOnlyCore() answers; every other one throws "not available remotely" */
export const REMOTE_READS: readonly string[] = ['snapshot', 'devices', 'freePorts'];

/** A full Core for the shared tool code, with every write (and logs) disabled. */
export function readOnlyCore(core: RemoteCore): Core {
  const ro: Required<Core> = {
    snapshot: () => core.snapshot(),
    devices: () => core.devices(),
    freePorts: (count, preferred) => core.freePorts(count, preferred),
    expose: notRemote,
    unexpose: notRemote,
    restart: notRemote,
    stop: notRemote,
    logs: notRemote,
    // Not offered remotely. list_ports treats a failing history() as "no history"; the remote
    // who_uses_what and portboard://status read usage from RemoteCore directly, with their own redaction.
    usage: notRemote,
    history: notRemote,
    setClientName: notRemote,
    owners: notRemote,
    cleanup: notRemote,
    worktrees: notRemote,
    removeWorktrees: notRemote,
    reservations: notRemote,
    reservePort: notRemote,
    releasePort: notRemote,
    devServers: notRemote,
    startDevServer: notRemote,
    stopDevServer: notRemote,
    // local setup files and commands: nothing for the internet
    setupStatus: notRemote,
    digest: notRemote,
    setDigest: notRemote,
    // LAN addresses and device names: local only
    suggestions: notRemote,
    // project names and Claude sessions' habits: local only
    adoption: notRemote,
    // alert settings are writes; alert state, 새 기기, the collection status and a service's detail are local only
    // (portboard://status gets what it shows through RemoteCore.statusExtras, redacted)
    setAlert: notRemote,
    alerts: notRemote,
    newDevices: notRemote,
    collection: notRemote,
    serviceDetail: notRemote,
    // port rules are prefs (labels, notices): local only
    portRules: notRemote,
    setPortRule: notRemote,
    // session titles, project dirs and process names: local only (portboard://status carries a numbers-only line)
    memory: notRemote,
  };
  return ro;
}
