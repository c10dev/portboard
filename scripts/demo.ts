// The public demo (#13): a static, read-only copy of the dashboard on example data, and a landing page, for GitHub
// Pages. Nothing runs on a server and nothing is read from this machine: the pages come from public/ with the shell
// expanded as the server would (src/core/shell.ts, the features' scripts), and every GET /api/… they make is answered
// from a JSON file of example data.
//
//   npm run demo                  → demo/ (gitignored)
//   node scripts/demo.ts --out DIR   (with PORTBOARD_SITE=portboard.example.json)
//
// The site it writes:
//
//   index.html                 the landing page (scripts/demo/landing.html)
//   images/                    the README's screenshots
//   app/                       the dashboard: public/ with each page expanded and scripts/demo/shim.js inlined first
//   app/api/…json              the answers: scripts/demo/data/api/ as they are, plus what is computed from them
//                              below (history, uptime, each port's detail and audit lines), all at the capture time
//
// The data is example data only: the menu bar's fixtures (devbox on example.ts.net, menubar/fixtures/) cleaned to
// English, and hand-written answers for the rest. The shim (in the browser) maps fetch('/api/…') to these files with
// apiFile(), moves their timestamps to now and answers every write with "read-only demo" without sending anything.
//
// Two guards keep real data out:
//   - it refuses to run unless the site config is the repo's portboard.example.json and the data is that example
//     host's (demoRefusal); the shell it renders reads the site config, the data never does
//   - it builds into a staging folder, scans that with scripts/public-scan.mjs (plus private/denylist.txt when there
//     is one), and only then replaces the output folder; a finding leaves the old output as it was

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from '../src/core/site.ts';
import { expandShell } from '../src/core/shell.ts';
import { uiTags } from '../src/features/registry.ts';
import { serviceDetail } from '../src/core/detail.ts';
import { assignGroups } from '../src/core/groups.ts';
import { buildNetTree } from '../src/core/nettree.ts';
import { withLocale } from '../src/core/i18n.ts';
import type { Device } from '../src/core/devices.ts';
import type { ProxmoxStatus } from '../src/core/proxmox.ts';
import { emptyHistory, withHistory, type History } from '../src/core/history.ts';
import { detail as uptimeDetail, emptyUptime, recordCheck, summary as uptimeSummary, CHECK_MS, type Uptime } from '../src/core/uptime.ts';
import type { PortEntry } from '../src/core/index.ts';
import type { Usage } from '../src/core/usage.ts';
import type { WatchStatus } from '../src/core/alerts.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The example identity everything in the demo must carry (portboard.example.json, menubar/fixtures/) */
export const EXAMPLE = { host: 'devbox', tailnet: 'example.ts.net', siteFile: join(ROOT, 'portboard.example.json') } as const;

/**
 * The file that answers a GET to the API: "/api/ports?fresh" → "api/ports.json", "/api/health?detail" →
 * "api/health.detail.json", "/api/proxmox/trends?timeframe=hour" → "api/proxmox/trends.timeframe-hour.json". Only
 * the query keys that pick different data count (detail, mode, port, timeframe); the rest (fresh, rescan, limit,
 * since…) don't. null for anything that isn't a plain /api path.
 *
 * The shim runs this very function in the browser (scripts/demo.ts inlines its source), so it must stay
 * self-contained: no outside names, nothing but plain JavaScript once the types are stripped.
 */
export function apiFile(pathAndQuery: string): string | null {
  const KEPT = ['detail', 'mode', 'port', 'timeframe'];
  const q = pathAndQuery.indexOf('?');
  const path = q < 0 ? pathAndQuery : pathAndQuery.slice(0, q);
  if (!/^\/api(\/[A-Za-z0-9_-]+)+$/.test(path)) return null;
  const params = new URLSearchParams(q < 0 ? '' : pathAndQuery.slice(q + 1));
  let suffix = '';
  for (const k of KEPT) {
    const v = params.get(k);
    if (v === null) continue;
    if (!/^[A-Za-z0-9_-]{0,40}$/.test(v)) return null;
    suffix += v ? `.${k}-${v}` : `.${k}`;
  }
  return `${path.slice(1)}${suffix}.json`;
}

export interface DemoCheck {
  /** The site config file the shell was rendered with (SITE.file) and what it resolved to */
  site: { file: string; host: string; tailnet: string; dnsName: string };
  /** The host the data describes (ports.json host and tailscale) */
  data: { hostname: string | null; dnsName: string | null };
  exampleFile?: string;
}

/** Why the demo must not be built from this, or null when it is the example. */
export function demoRefusal(c: DemoCheck): string | null {
  const example = c.exampleFile ?? EXAMPLE.siteFile;
  const dns = `${EXAMPLE.host}.${EXAMPLE.tailnet}`;
  if (resolve(c.site.file) !== resolve(example)) {
    return `the site config is ${c.site.file}, not the example (${example}): run it as \`npm run demo\` (PORTBOARD_SITE=portboard.example.json)`;
  }
  if (c.site.host !== EXAMPLE.host || c.site.tailnet !== EXAMPLE.tailnet || c.site.dnsName !== dns) {
    return `the site config resolves to ${c.site.dnsName} (host ${c.site.host}, tailnet ${c.site.tailnet || 'none'}), not the example ${dns}: unset the PORTBOARD_* variables that override it`;
  }
  if (c.data.hostname !== EXAMPLE.host || c.data.dnsName !== dns) {
    return `the demo data describes ${c.data.dnsName ?? c.data.hostname ?? 'an unknown host'}, not the example ${dns}`;
  }
  return null;
}

/** A page of public/ as the demo serves it: the shell expanded in English, the features' scripts, the shim first. */
export function demoPage(html: string, page: string, opts: { shim: string; hostname: string }): string {
  let out = expandShell(html, { hostname: opts.hostname, locale: 'en' });
  const tags = uiTags(page);
  if (tags) out = out.replace('</body>', `${tags}</body>`);
  // Auto follows the visitor's browser, not the server's locale: the demo has no server
  out = out.replace('"explicit":true', '"explicit":false');
  // right after the charset (which must stay in the first 1024 bytes), before the boot script and every module
  const META = '<meta charset="utf-8">';
  if (out.split(META).length !== 2) throw new Error(`${page}: expected one ${META} to put the demo shim after`);
  return out.replace(META, () => `${META}\n<script>${opts.shim.replace(/<\/script/gi, '<\\/script')}</script>`);
}

/** The shim with the mapping and the capture time filled in */
export function demoShim(source: string, capturedAt: number): string {
  const fill: [string, string][] = [['const apiFile = __API_FILE__;', `const apiFile = ${apiFile.toString()};`], ['const CAPTURED = __CAPTURED_AT__;', `const CAPTURED = ${capturedAt};`]];
  for (const [from, to] of fill) {
    if (source.split(from).length !== 2) throw new Error(`scripts/demo/shim.js: expected "${from}" once`);
    source = source.replace(from, () => to);
  }
  return source;
}

// ---- the computed answers ----

/** A small deterministic hash, so the made-up minutes are the same on every build */
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Who used what: every use in the data as a history entry (in use now), plus a few idle ones from earlier days */
export function exampleHistory(u: Usage, now: number): History {
  const h = emptyHistory();
  h.startedAt = now - 21 * DAY;
  const add = (device: string, name: string, kind: string, port: number, service: string, o: { lastSeen: number; activeSince: number; peak: number; days: number }) => {
    const seed = hash(`${device}|${port}`);
    const days: Record<string, number> = {};
    for (let i = 0; i < o.days; i++) {
      const m = (seed >> (i % 16)) % 97;
      if (m > 12) days[dayOf(o.lastSeen - i * DAY)] = m + (i === 0 ? 0 : 20);
    }
    h.entries[`${device}|${port}`] = {
      device, port, name, service, kind, nameKey: null, firstSeen: o.lastSeen - (o.days + (seed % 5)) * DAY, lastSeen: o.lastSeen,
      activeSince: o.activeSince, samples: 40 + (seed % 900), peak: o.peak, days,
    };
  };
  for (const c of u.cards) {
    for (const r of c.uses) {
      const since = Date.parse(r.since);
      add(r.routed ? `${c.id}~routed` : c.id, c.name, r.routed ? 'routed' : c.kind, r.port, r.service, { lastSeen: now, activeSince: since - 40 * MIN, peak: r.connections + 1, days: 12 });
    }
  }
  for (const r of u.local.uses) add('local', 'This server', 'local', r.port, r.service, { lastSeen: now, activeSince: Date.parse(r.since), peak: r.connections, days: 3 });
  // used before, idle now
  add('iphone', 'iphone', 'tailnet', 3000, 'webapp', { lastSeen: now - 3 * HOUR, activeSince: now - 4 * HOUR, peak: 2, days: 9 });
  add('dev-mac', 'dev-mac', 'tailnet', 5281, 'ShopSim', { lastSeen: now - 26 * HOUR, activeSince: now - 28 * HOUR, peak: 3, days: 6 });
  add('dev-mac', 'dev-mac', 'tailnet', 8790, 'Portboard', { lastSeen: now - 25 * MIN, activeSince: now - 2 * HOUR, peak: 2, days: 14 });
  add('desktop-pc', 'desktop-pc', 'tailnet', 8384, 'Syncthing', { lastSeen: now - 2 * DAY, activeSince: now - 2 * DAY - HOUR, peak: 1, days: 5 });
  return h;
}

/** 21 days of 30 s checks for each watched port; compute-pool had one 6-minute outage yesterday */
export function exampleUptime(ports: number[], now: number): Uptime {
  const u = emptyUptime();
  const from = now - 21 * DAY;
  const outage: [number, number] = [now - 26 * HOUR - 47 * MIN, now - 26 * HOUR - 41 * MIN];
  const restart: [number, number] = [now - 3 * DAY - 2 * HOUR, now - 3 * DAY - 2 * HOUR + 2 * MIN];
  for (const port of ports) {
    for (let t = from; t <= now; t += CHECK_MS) {
      const down = port === 7720 && t >= outage[0] && t < outage[1];
      const quiet = t >= restart[0] && t < restart[1];
      recordCheck(u, port, t, down ? 'd' : quiet ? 'q' : 'u');
    }
  }
  return u;
}

type Json = Record<string, unknown>;

/**
 * Every answer the demo has: the data files, with groups, history and uptime joined in, plus each port's detail and
 * audit lines. In English, like the data (the server's text in them, "This server", "via pve1", follows its locale).
 */
export function demoAnswers(data: Map<string, unknown>): { files: Map<string, unknown>; capturedAt: number } {
  return withLocale('en', () => answers(data));
}

function answers(data: Map<string, unknown>): { files: Map<string, unknown>; capturedAt: number } {
  const need = (f: string) => {
    const v = data.get(f);
    if (!v) throw new Error(`scripts/demo/data/${f} is missing`);
    return v as Json;
  };
  const ports = structuredClone(need('api/ports.json')) as { at: string; ports: PortEntry[] };
  // the server groups ports that share an owner (a compose project, a unit) as it reads them
  assignGroups(ports.ports);
  const capturedAt = Date.parse(ports.at);
  const usage = need('api/usage.json') as unknown as Usage;
  const devices = need('api/devices.json') as { devices: Device[]; proxmox: ProxmoxStatus | null };
  const alerts = need('api/alerts.json') as { watching: WatchStatus[]; recent: { t: string; title: string; ok: boolean }[] };
  const audit = need('api/audit.json') as { entries: { target: { port?: number } }[] };

  // the network map (기기 › 구조): the server builds it from the devices, the Proxmox guests and the LAN clients
  const lanHosts = usage.cards.filter((c) => c.kind === 'lan').map((c) => ({ ip: c.lanIps[0], mac: null, name: c.name, seen: 'client' as const }));
  const tree = buildNetTree({ devices: devices.devices, proxmox: devices.proxmox, lanHosts, selfLanIps: usage.selfLanIps ?? [] });
  const history = exampleHistory(usage, capturedAt);
  const withHist = { ...withHistory(usage, history, capturedAt), tree };
  const watched = alerts.watching.filter((w) => w.kind === 'port').map((w) => w.port!);
  const uptime = exampleUptime(watched, capturedAt);
  const files = new Map(data);
  files.set('api/ports.json', ports);
  files.set('api/devices.json', { ...devices, tree });
  files.set('api/usage.json', withHist);
  files.set('api/alerts.json', { ...alerts, watching: alerts.watching.map((w) => (w.kind === 'port' ? { ...w, uptime: uptimeSummary(uptime, w.port!, capturedAt) } : w)) });

  const all = [...new Set([...ports.ports.map((p) => p.port), ...watched])];
  for (const port of all) {
    const events = port === 7720 ? alerts.recent.map((r) => ({ t: r.t, kind: r.ok ? 'recovered' : 'down', title: r.title, ok: true })) : [];
    const d = serviceDetail({
      port, now: capturedAt, ports: ports.ports, usage: withHist, history,
      watch: alerts.watching.find((w) => w.key === `port:${port}`) ?? null,
      uptime: uptimeDetail(uptime, port, capturedAt),
      events,
    });
    if (d) files.set(apiFile(`/api/ports/${port}/detail`)!, d);
    files.set(apiFile(`/api/audit?port=${port}`)!, { entries: audit.entries.filter((e) => e.target.port === port) });
  }
  return { files, capturedAt };
}

// ---- building the site ----

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p)];
  });
}

function readData(dir: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const f of walk(dir)) {
    if (!f.endsWith('.json')) continue;
    out.set(f.split('\\').join('/'), JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
  return out;
}

function put(path: string, body: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** Writes the whole site into dir (which must not exist). Returns how many pages and answers it wrote. */
export function buildDemo(dir: string, root = ROOT): { pages: number; answers: number } {
  const data = readData(join(root, 'scripts/demo/data'));
  const ports = data.get('api/ports.json') as { host?: { hostname?: string }; tailscale?: { dnsName?: string | null } } | undefined;
  const refusal = demoRefusal({
    site: { file: SITE.file, host: SITE.host, tailnet: SITE.tailnet, dnsName: SITE.dnsName },
    data: { hostname: ports?.host?.hostname ?? null, dnsName: ports?.tailscale?.dnsName ?? null },
  });
  if (refusal) throw new Error(`refusing to build the demo: ${refusal}`);

  const { files, capturedAt } = demoAnswers(data);
  const shim = demoShim(readFileSync(join(root, 'scripts/demo/shim.js'), 'utf8'), capturedAt);
  const app = join(dir, 'app');
  const pub = join(root, 'public');
  let pages = 0;
  for (const f of walk(pub)) {
    const src = join(pub, f);
    const to = join(app, f);
    if (f.endsWith('.html')) {
      put(to, demoPage(readFileSync(src, 'utf8'), f.split('\\').join('/'), { shim, hostname: EXAMPLE.host }));
      pages++;
    } else if (f === 'manifest.webmanifest') {
      // installed from the demo, it opens the demo
      put(to, readFileSync(src, 'utf8').replace('"start_url": "/"', '"start_url": "./"'));
    } else {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(src, to);
    }
  }
  for (const [f, body] of files) put(join(app, f), JSON.stringify(body));

  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  put(join(dir, 'index.html'), readFileSync(join(root, 'scripts/demo/landing.html'), 'utf8').replace('{{VERSION}}', version));
  for (const img of ['services-1200.png', 'devices-1200.png', 'service-1200-dark.png']) {
    mkdirSync(join(dir, 'images'), { recursive: true });
    copyFileSync(join(root, 'docs/images', img), join(dir, 'images', img));
  }
  // GitHub Pages: serve the files as they are
  put(join(dir, '.nojekyll'), '');
  return { pages, answers: files.size };
}

function main(argv: string[]) {
  const at = argv.indexOf('--out');
  const out = resolve(at >= 0 ? argv[at + 1] : join(ROOT, 'demo'));
  const staging = `${out}.staging`;
  rmSync(staging, { recursive: true, force: true });
  try {
    const { pages, answers } = buildDemo(staging);
    const deny = join(ROOT, 'private/denylist.txt');
    const scan = [join(ROOT, 'scripts/public-scan.mjs'), staging, '--allow-images', 'app/,images/', ...(existsSync(deny) ? ['--denylist', deny] : [])];
    try {
      execFileSync(process.execPath, scan, { stdio: 'inherit' });
    } catch {
      throw new Error(`the scan found something that must not be published (above); ${out} was left as it was`);
    }
    rmSync(out, { recursive: true, force: true });
    renameSync(staging, out);
    console.log(`demo: ${pages} pages, ${answers} API answers → ${relative(process.cwd(), out) || '.'}/ (landing page index.html, dashboard app/)`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`demo: ${(err as Error).message}`);
    process.exit(1);
  }
}
