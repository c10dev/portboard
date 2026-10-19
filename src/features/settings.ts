// 설정 tab (settings.html): every setting and setup step in one place. Each section is its own dashboard script that
// reads its feature's API (시작하기 /api/onboarding, 원격 커넥터 /api/remote/*, 쓰기 허용 기기 /api/settings/write-devices,
// 알림 /api/alerts + /api/digest, Claude 세션 /api/claude/*); this module answers what no other feature owns:
//
//   GET /api/settings   {version, profile, port, running, deployed, addresses, site, docs, secrets}
//                       running: the commit this process runs; deployed: ~/.local/state/portboard/deployed.json
//                       addresses: the dashboard (tailscale serve https, tailnet only), the connector (remote.json
//                       publicUrl + /mcp, Funnel) and the direct read-only http address, all production's
//                       site: this server's resolved site values and where each came from (site.ts, portboard.json)
//                       secrets: Proxmox token, pve1/Windows read-only SSH key, ntfy, connector tokens: status, expiry
//                       and the rotation runbook. Never a secret value: only what the setup checklist and the
//                       self-watch already show.
//   ui  settings-modal.js: the 설정 modal over every page (#settings/<section>; settings.html only redirects there).
//       Its section scripts are declared with the page `#settings` (the modal imports them when it first opens):
//       here (the 시작하기, 비밀값, 정보, Claude 세션 ones) or by their own feature (remote-connector.js,
//       write-devices.js, digest.js, port-rules.js).

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../core/exec.ts';
import { assess, collectSetupFacts, setupFiles, type Item } from '../core/onboarding.ts';
import { PRODUCTION_PORT, PRODUCTION_REMOTE_PORT } from '../core/paths.ts';
import { RUNBOOKS } from '../core/runbooks.ts';
import type { SelfWatchStatus } from '../core/selfwatch.ts';
import { serveStatus, type ServeEntry } from '../core/tailscale.ts';
import { resolveDashboardUrl, site, SITE, tildePath, type Site } from '../core/site.ts';
import { VERSION } from '../version.ts';
import { connectorUrlOf } from './remote-connector.ts';
import { ok } from './router.ts';
import type { FeatureModule } from './types.ts';
import { t } from '../core/i18n.ts';

const REPO = 'https://github.com/c10dev/portboard/blob/main';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** scripts/deploy.ts writes it on every successful deploy (production's state dir, whatever this profile is) */
export const DEPLOYED_PATH = join(homedir(), '.local', 'state', 'portboard', 'deployed.json');

/** A link whose label is a catalog key, read in the language of the request it's sent in */
const doc = (key: string, href: string) => ({
  get label() {
    return t(key);
  },
  href,
});

export const DOC_LINKS = [
  { label: 'README', href: `${REPO}/README.md` },
  doc('settingsApi.docs.dashboard', `${REPO}/docs/dashboard.md`),
  { label: 'REST API', href: `${REPO}/docs/api.md` },
  doc('settingsApi.docs.security', `${REPO}/docs/security.md`),
  doc('settingsApi.docs.remoteMcp', `${REPO}/docs/remote-mcp/README.md`),
  doc('settingsApi.docs.runbooks', `${REPO}/docs/runbooks/README.md`),
  doc('settingsApi.docs.operations', `${REPO}/docs/operations.md`),
  doc('settingsApi.docs.changelog', `${REPO}/CHANGELOG.md`),
];

export interface Deployed {
  commit: string;
  at: string | null;
}

export function parseDeployed(text: string | null): Deployed | null {
  if (!text) return null;
  try {
    const d = JSON.parse(text);
    if (typeof d?.commit !== 'string' || !/^[0-9a-f]{40}$/.test(d.commit)) return null;
    return { commit: d.commit, at: typeof d.at === 'string' ? d.at.slice(0, 40) : null };
  } catch {
    return null;
  }
}

export interface Addresses {
  /** https://<node>:8443, tailscale serve → the production dashboard; null when serve doesn't publish it */
  dashboard: string | null;
  /** https://<node>/mcp: what claude.ai and ChatGPT connect to; null when remote.json has no publicUrl */
  connector: string | null;
  /** the serve/Funnel https port in front of the remote server (443), null when none */
  connectorPort: number | null;
  /** http://<node>:8790: any tailnet device, read-only */
  direct: string | null;
}

export function addressesOf(dnsName: string | null, serve: ServeEntry[], publicUrl: unknown): Addresses {
  return {
    dashboard: resolveDashboardUrl(dnsName, serve, PRODUCTION_PORT),
    connector: connectorUrlOf(publicUrl),
    connectorPort: serve.find((e) => e.upstreamPort === PRODUCTION_REMOTE_PORT)?.httpsPort ?? null,
    direct: dnsName ? `http://${dnsName}:${PRODUCTION_PORT}` : null,
  };
}

/** The 정보 section's 이 서버 rows: resolved values (paths with ~), each value's source, and the config file's state. */
export interface SiteView {
  host: string;
  dnsName: string;
  checkout: string;
  reposRoots: string[];
  poolUrl: string;
  sources: Site['sources'];
  file: string;
  fileFound: boolean;
  fileError: string | null;
  /** the checkout's portboard.json (~ path) when it was used under the user file, else null */
  checkoutFile: string | null;
}

export function siteView(s: Site): SiteView {
  return {
    host: s.host,
    dnsName: s.dnsName,
    checkout: tildePath(s.checkout),
    reposRoots: s.reposRoots.map((r) => tildePath(r)),
    poolUrl: s.poolUrl,
    sources: s.sources,
    file: tildePath(s.file),
    fileFound: s.fileFound,
    fileError: s.fileError,
    checkoutFile: s.checkoutFile ? tildePath(s.checkoutFile) : null,
  };
}

export interface Secret {
  key: 'proxmox' | 'pve-ssh' | 'win-ssh' | 'ntfy' | 'connector';
  title: string;
  status: Item['status'];
  detail: string;
  /** the soonest known expiry (ISO), null when it has none or it isn't known */
  expiresAt: string | null;
  runbook: string;
}

const SECRETS: { key: Secret['key']; item: string; title: () => string; runbook: string; expiry: (k: string) => boolean }[] = [
  { key: 'proxmox', item: 'proxmox', title: () => t('settingsApi.secret.proxmox'), runbook: RUNBOOKS.proxmox, expiry: (k) => k === 'proxmox-token' },
  { key: 'pve-ssh', item: 'pve-ports', title: () => t('settingsApi.secret.pveSsh', { node: SITE.pve.node }), runbook: RUNBOOKS.ssh, expiry: () => false },
  { key: 'win-ssh', item: 'win-ports', title: () => t('settingsApi.secret.winSsh'), runbook: RUNBOOKS.ssh, expiry: () => false },
  { key: 'ntfy', item: 'alerts', title: () => t('settingsApi.secret.ntfy'), runbook: RUNBOOKS.ntfy, expiry: () => false },
  { key: 'connector', item: 'remote', title: () => t('settingsApi.secret.connector'), runbook: RUNBOOKS.remote, expiry: (k) => k.startsWith('remote:') },
];

/** The checklist items that are secrets, with the self-watch's expiry dates. Only statuses and dates: no values. */
export function secretsOf(items: Item[], sw: SelfWatchStatus | null): Secret[] {
  return SECRETS.map((s) => {
    const it = items.find((i) => i.key === s.item);
    const dates = (sw?.expiry.items ?? []).filter((e) => s.expiry(e.key) && e.expiresAt).map((e) => e.expiresAt!).sort();
    return { key: s.key, title: s.title(), status: it?.status ?? 'warn', detail: it?.detail ?? t('settingsApi.secret.unchecked'), expiresAt: dates[0] ?? null, runbook: s.runbook };
  });
}

let running: Promise<string | null> | null = null;
/** The commit this process runs (its checkout's HEAD), once per process */
const runningCommit = () =>
  (running ??= run('git', ['-C', ROOT, 'rev-parse', 'HEAD'], 3_000).then(
    (r) => (r.ok && /^[0-9a-f]{40}$/.test(r.stdout.trim()) ? r.stdout.trim() : null),
    () => null,
  ));

const readText = (p: string) => readFile(p, 'utf8').catch(() => null);

export const settingsFeature: FeatureModule = {
  name: 'settings',
  order: 2900,
  routes: [
    {
      method: 'GET',
      path: '/api/settings',
      async handler(_r, ctx) {
        const sw = () => ctx.selfwatch.status();
        const [facts, status, serve, remote, deployed, commit, here] = await Promise.all([
          collectSetupFacts({ selfwatch: sw }),
          sw().catch(() => null),
          serveStatus().catch((): ServeEntry[] => []),
          // production's remote.json, whatever this profile is: the address is the deployment's, not the preview's
          readText(setupFiles().remote).then((t) => (t ? JSON.parse(t) : null)).catch(() => null),
          readText(DEPLOYED_PATH).then(parseDeployed),
          runningCommit(),
          site(PRODUCTION_PORT).catch(() => SITE),
        ]);
        return ok({
          version: VERSION,
          profile: ctx.paths.profile,
          port: ctx.paths.port,
          running: commit,
          deployed,
          addresses: addressesOf(ctx.ts.dnsName, serve, remote?.publicUrl),
          site: siteView(here),
          docs: DOC_LINKS.map((d) => ({ ...d })),
          secrets: secretsOf(assess(facts).items, status),
        });
      },
    },
  ],
  ui: [
    { pages: ['index.html', 'devices.html', 'dev.html', 'service.html'], script: 'features/settings-modal.js' },
    { pages: ['#settings'], script: 'features/settings-start.js' },
    { pages: ['#settings'], script: 'features/claude-autostop.js' },
    { pages: ['#settings'], script: 'features/secrets.js' },
    { pages: ['#settings'], script: 'features/about.js' },
  ],
};
