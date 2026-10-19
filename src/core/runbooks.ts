// Rotation runbooks (docs/runbooks/, #31): one per secret Portboard holds. The setup checklist, the self-watch's
// expiry view and its alerts link to them wherever they mention that secret.

const BASE = 'https://github.com/c10dev/portboard/blob/main/docs/runbooks';

export const RUNBOOKS = {
  proxmox: `${BASE}/proxmox-token.md`,
  ssh: `${BASE}/ssh-readonly-keys.md`,
  ntfy: `${BASE}/ntfy-topic.md`,
  remote: `${BASE}/remote-connector.md`,
  /** not a rotation runbook: installing the read-only Proxmox and Windows port readers */
  sshSetup: `${BASE}/ssh-readonly-setup.md`,
} as const;

/** The runbook for a self-watch expiry key (proxmox-token, remote:<hash>, ssh-key, ntfy), null for anything else */
export function runbookForExpiry(key: string): string | null {
  if (key === 'proxmox-token') return RUNBOOKS.proxmox;
  if (key === 'remote' || key.startsWith('remote:')) return RUNBOOKS.remote;
  if (key === 'ssh-key') return RUNBOOKS.ssh;
  if (key === 'ntfy' || key === 'webhook') return RUNBOOKS.ntfy;
  return null;
}

/** The runbook for a collector whose failure can mean its credential was rotated or revoked */
export function runbookForCollector(name: string): string | null {
  if (name === 'proxmox') return RUNBOOKS.proxmox;
  if (name === 'pve-ports' || name === 'win-ports') return RUNBOOKS.ssh;
  return null;
}
