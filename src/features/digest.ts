// 일간/주간 요약 알림 (c10dev/portboard#34): a short digest of the day or week, through the down alerts' channel.
// The text is built by src/core/digest.ts; this module gathers its inputs, keeps the schedule and the state file.
//
//   GET  /api/digest            settings, whether this process sends, next slot, last sent
//   POST /api/digest            {mode?: 'off'|'daily'|'weekly', time?: 'HH:MM'} (KST)   (X-Portboard)
//   GET  /api/digest/preview    ?mode=daily|weekly: the text over the period ending now (default: the setting's)
//   POST /api/digest/send       지금 보내기: the same text, sent now (X-Portboard). Doesn't change the schedule.
//   MCP  digest_preview (read), set_digest (write, local only)
//   job  digest: every minute, sends a due slot. Only where alerts may be sent (paths.alertsOn): never in a preview,
//        whose channel file doesn't exist either, so 지금 보내기 answers 알림 채널 없음 there.
//
// Scheduled and manual sends both go to alerts.jsonl (the 🔔 dialog's 최근 보낸 알림). State, so a restart neither
// re-sends nor skips: ~/.local/state/portboard/digest-state.json.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendPrivate, writePrivate } from '../core/atomic.ts';
import { snapshot } from '../core/index.ts';
import { defaultChecker, httpSender, loadChannel, redact, type Channel, type Sender, type Sent } from '../core/alerts.ts';
import {
  buildDigest,
  checkSettings,
  decide,
  digestMessage,
  emptyState,
  nextSlot,
  parseSettings,
  parseState,
  periodOf,
  type Digest,
  type DigestInput,
  type DigestSettings,
  type DigestState,
} from '../core/digest.ts';
import { loadKnown } from '../core/known.ts';
import { loadHistory } from '../core/history.ts';
import { PATHS } from '../core/paths.ts';
import { loadPrefs, setDigestPrefs } from '../core/prefs.ts';
import { savedStatus } from '../core/selfwatch.ts';
import { loadUptime } from '../core/uptime.ts';
import { text } from '../mcp/kit.ts';
import { adoptionForDigest } from './adoption.ts';
import { devhealthForDigest } from './devhealth.ts';
import { memoryForDigest } from './memory.ts';
import { connectorView } from '../remote/admin.ts';
import { HEALTH_LABEL, needsAttention } from '../remote/health.ts';
import { Store } from '../remote/store.ts';
import { ownersOf } from './owners.ts';
import { currentWorktrees, refreshWorktrees } from './worktrees.ts';
import { ok, reply } from './router.ts';
import type { ServerContext } from './context.ts';
import type { FeatureModule, Tool } from './types.ts';
import { t } from '../core/i18n.ts';

export interface DigestView {
  settings: DigestSettings;
  /** This process sends scheduled digests (production; a preview only with PORTBOARD_PREVIEW_ALERTS=1) */
  scheduled: boolean;
  channel: { configured: boolean };
  /** Next slot (ISO), null when off */
  nextAt: string | null;
  lastSent: string | null;
}

declare module '../mcp/kit.ts' {
  interface Core {
    /** 요약 알림 settings and state, with the text over the period ending now (mode: that period instead of the setting's) */
    digest?(mode?: 'daily' | 'weekly'): Promise<DigestView & { preview: Digest }>;
    setDigest?(patch: Partial<DigestSettings>): Promise<DigestSettings>;
  }
}

export const DIGEST_STATE_PATH = join(PATHS.stateDir, 'digest-state.json');

// ---------- inputs ----------

/** Where each part of the digest comes from; any of them may fail, which only drops its line. */
export interface Sources {
  watching(): Promise<DigestInput['watching']>;
  uptime(): Promise<DigestInput['uptime']>;
  known(): Promise<DigestInput['known']>;
  cleanup(): Promise<DigestInput['cleanup']>;
  worktrees(): Promise<DigestInput['worktrees']>;
  selfwatch(): Promise<DigestInput['selfwatch']>;
  history(): Promise<DigestInput['history']>;
  /** Claude sessions' port use (#40) over the period: a hook point, left out where there is none */
  adoption?(period: { from: number; to: number }): Promise<DigestInput['adoption']>;
  /** Remote connectors that need a look (커넥터 상태): left out where there is none */
  remote?(): Promise<DigestInput['remote']>;
  memory?(): Promise<DigestInput['memory']>;
  devhealth?(): Promise<DigestInput['devhealth']>;
}

export async function gather(src: Sources, period?: { from: number; to: number }): Promise<DigestInput> {
  const safe = <T>(f: () => Promise<T>) => f().catch(() => null);
  const [watching, uptime, known, cleanup, worktrees, selfwatch, history, adoption, remote, memory, devhealth] = await Promise.all([
    safe(src.watching), safe(src.uptime), safe(src.known), safe(src.cleanup), safe(src.worktrees), safe(src.selfwatch), safe(src.history),
    src.adoption && period ? safe(() => src.adoption!(period)) : null,
    src.remote ? safe(src.remote) : null,
    src.memory ? safe(src.memory) : null,
    src.devhealth ? safe(src.devhealth) : null,
  ]);
  return { watching, uptime, known, cleanup, worktrees, selfwatch, history, adoption, remote, memory, devhealth };
}

/** remote.json → the clients whose 커넥터 상태 isn't 정상, by name and label only */
export async function remoteAttention(path: string, now = Date.now()): Promise<DigestInput['remote']> {
  const v = connectorView(await new Store(path).read(), now);
  return v.clients.filter((c) => needsAttention(c.health)).map((c) => ({ name: c.name, health: HEALTH_LABEL[c.health!] }));
}

const cleanupOf = async (snap: Parameters<typeof ownersOf>[0]) => (await ownersOf(snap)).ports.filter((p) => p.reasons.length).map((p) => ({ port: p.port, name: p.name }));

/** The server process: its live stores. */
function serverSources(ctx: ServerContext): Sources {
  return {
    watching: async () => (await ctx.alerts.status()).watching,
    uptime: async () => ctx.uptime.data,
    known: () => loadKnown(ctx.paths.known),
    cleanup: async () => cleanupOf(await ctx.snapshot()),
    worktrees: async () => {
      const w = currentWorktrees();
      return w.at ? w.totals : null;
    },
    selfwatch: () => ctx.selfwatch.status(),
    history: async () => ctx.history.data,
    adoption: (p) => adoptionForDigest(p),
    remote: () => remoteAttention(ctx.paths.remoteConfig),
    memory: () => memoryForDigest(ctx.paths),
    devhealth: () => devhealthForDigest(ctx.paths),
  };
}

/** The stdio MCP server: the files the dashboard writes, and its own snapshot / worktree scan. */
function fileSources(): Sources {
  return {
    watching: async () => (await defaultChecker(async () => []).status()).watching,
    uptime: () => loadUptime(),
    known: () => loadKnown(),
    cleanup: async () => cleanupOf(await snapshot()),
    worktrees: async () => {
      const w = currentWorktrees();
      return (w.at ? w : await refreshWorktrees()).totals;
    },
    selfwatch: () => savedStatus(),
    history: () => loadHistory(),
    adoption: (p) => adoptionForDigest(p),
    remote: () => remoteAttention(PATHS.remoteConfig),
    memory: () => memoryForDigest(),
    devhealth: () => devhealthForDigest(),
  };
}

// ---------- state, sending ----------

export interface DigesterDeps {
  sources: Sources;
  settings?(): Promise<DigestSettings>;
  channel?(): Promise<Channel | null>;
  send?: Sender;
  now?(): number;
  statePath?: string;
  logPath?: string;
}

export function createDigester(deps: DigesterDeps) {
  const now = deps.now ?? Date.now;
  const settings = deps.settings ?? (async () => parseSettings((await loadPrefs()).digest));
  const channel = deps.channel ?? (() => loadChannel());
  const send = deps.send ?? httpSender();
  const statePath = deps.statePath ?? DIGEST_STATE_PATH;
  const logPath = deps.logPath ?? PATHS.alertsLog;
  // Scheduled and manual sends, and their state writes, one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const job = queue.then(f);
    queue = job.catch(() => {});
    return job;
  };

  async function loadState(): Promise<DigestState> {
    try {
      return parseState(await readFile(statePath, 'utf8'));
    } catch {
      return emptyState();
    }
  }

  async function saveState(st: DigestState): Promise<void> {
    await writePrivate(statePath, `${JSON.stringify(st, null, 2)}\n`);
  }

  async function preview(mode?: 'daily' | 'weekly', end = now()): Promise<Digest> {
    const s = await settings();
    const m = mode ?? (s.mode === 'weekly' ? 'weekly' : 'daily');
    const period = periodOf(m, end);
    return buildDigest(await gather(deps.sources, period), m, period, now());
  }

  async function deliver(c: Channel, d: Digest): Promise<Sent[]> {
    const m = digestMessage(d);
    const sent = await send(c, m).catch((err) => [{ channel: 'ntfy' as const, ok: false, error: redact(String(err), c) }]);
    const line = { t: new Date(now()).toISOString(), key: m.key, kind: m.kind, title: m.title, body: m.body, sent };
    await appendPrivate(logPath, `${JSON.stringify(line)}\n`).catch(() => {});
    return sent;
  }

  return {
    preview,

    async view(): Promise<DigestView> {
      const [s, st, c] = await Promise.all([settings(), loadState(), channel()]);
      const next = nextSlot(s, now());
      return {
        settings: s,
        scheduled: false,
        channel: { configured: !!c },
        nextAt: next === null ? null : new Date(next).toISOString(),
        lastSent: st.lastSent === null ? null : new Date(st.lastSent).toISOString(),
      };
    },

    /** 지금 보내기: the period ending now; the schedule is untouched. */
    sendNow(mode?: 'daily' | 'weekly'): Promise<{ ok: boolean; message: string; sent: Sent[]; digest: Digest | null }> {
      return serial(async () => {
        const c = await channel();
        if (!c) return { ok: false, message: t('alertsMsg.noChannel'), sent: [], digest: null };
        const d = await preview(mode);
        const sent = await deliver(c, d);
        const good = sent.length > 0 && sent.every((x) => x.ok);
        if (sent.some((x) => x.ok)) await saveState({ ...(await loadState()), lastSent: now() });
        return { ok: good, message: good ? t('digestApi.sent') : t('alertsMsg.sendFailed', { errors: sent.filter((x) => !x.ok).map((x) => `${x.channel} ${x.error}`).join(', ') }), sent, digest: d };
      });
    },

    /** One scheduler tick: arm, disarm, or send a due slot. Returns what it did (tests). */
    tick(): Promise<string> {
      return serial(async () => {
        const s = await settings();
        const st = await loadState();
        const t = now();
        const dec = decide(s, st, t);
        if (dec.action === 'none') return 'none';
        if (dec.action !== 'send') {
          await saveState(dec.state);
          return dec.action;
        }
        const c = await channel();
        if (!c) return 'no-channel'; // tried again next tick; the catch-up window still bounds it
        const period = periodOf(s.mode, dec.slot);
        const d = buildDigest(await gather(deps.sources, period), s.mode, period, t);
        const sent = await deliver(c, d);
        const got = sent.some((x) => x.ok);
        await saveState(got ? { ...st, lastSlot: dec.slot, lastSent: t, lastAttempt: null } : { ...st, lastAttempt: t });
        return got ? 'sent' : 'failed';
      });
    },
  };
}

export type Digester = ReturnType<typeof createDigester>;

let serverDigester: Digester | null = null;
const forServer = (ctx: ServerContext) => (serverDigester ??= createDigester({ sources: serverSources(ctx), channel: () => loadChannel(ctx.paths.alertChannel) }));
let mcpDigester: Digester | null = null;
const forMcp = () => (mcpDigester ??= createDigester({ sources: fileSources() }));

async function viewOf(ctx: ServerContext): Promise<DigestView> {
  return { ...(await forServer(ctx).view()), scheduled: ctx.paths.alertsOn };
}

const periodArg = (v: unknown): 'daily' | 'weekly' | undefined => (v === 'daily' || v === 'weekly' ? v : undefined);

// ---------- MCP ----------

const previewTool: Tool = {
  def: {
    name: 'digest_preview',
    title: 'Daily/weekly digest preview',
    description:
      "The daily/weekly digest text as it would be sent now (period ending now): watched ports' uptime and outages, what is " +
      'down, new devices, leftover servers, removable worktrees, self-watch problems, most used services. Also the ' +
      'setting (off/daily/weekly at HH:MM in the server time zone (utcOffset, default KST), Monday for weekly), the next slot and when one was last sent. Sends nothing.',
    inputSchema: {
      type: 'object',
      properties: { period: { type: 'string', enum: ['daily', 'weekly'], description: 'Default: the configured mode (daily when off)' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async call(args, core) {
    if (!core.digest) return text('digest_preview is not available here', true);
    const v = await core.digest(periodArg((args as { period?: unknown } | null)?.period));
    return text({ settings: v.settings, nextAt: v.nextAt, lastSent: v.lastSent, channel: v.channel, title: v.preview.title, body: v.preview.body, empty: v.preview.empty, period: v.preview.period });
  },
};

const setTool: Tool = {
  def: {
    name: 'set_digest',
    title: 'Daily/weekly digest setting',
    description:
      'Turn the digest off, daily or weekly (Monday), at a time in the server time zone (utcOffset, default KST; default 09:00). It goes out through the same ' +
      "channel as the down alerts. The first digest is the next slot after it's switched on. Use digest_preview to show " +
      'the user what it would say.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['off', 'daily', 'weekly'] },
        time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'HH:MM, 24 h, server time zone (utcOffset, default KST)' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const err = checkSettings(args);
    if (err) return text(err, true);
    if (!core.setDigest) return text('set_digest is not available here', true);
    const a = args as Partial<DigestSettings>;
    if (!a.mode) return text('mode is required', true);
    const settings = await core.setDigest(a);
    const next = nextSlot(settings, Date.now());
    return text({ ok: true, settings, nextAt: next === null ? null : new Date(next).toISOString() });
  },
};

// ---------- module ----------

export const digestFeature: FeatureModule = {
  name: 'digest',
  order: 1800,
  routes: [
    { method: 'GET', path: '/api/digest', handler: async (_r, ctx) => ok(await viewOf(ctx)) },
    {
      method: 'POST',
      path: '/api/digest',
      write: true,
      body: { limit: 1024 },
      async handler({ body }, ctx) {
        const err = checkSettings(body);
        if (err) return reply(400, { error: err });
        await setDigestPrefs(body);
        return ok(await viewOf(ctx));
      },
    },
    { method: 'GET', path: '/api/digest/preview', handler: async ({ url }, ctx) => ok(await forServer(ctx).preview(periodArg(url.searchParams.get('mode')))) },
    {
      method: 'POST',
      path: '/api/digest/send',
      write: true,
      body: { limit: 1024 },
      async handler({ body }, ctx) {
        const r = await forServer(ctx).sendNow(periodArg(body?.mode));
        return reply(r.ok ? 200 : 409, r);
      },
    },
  ],
  tools: [previewTool, setTool],
  mcpCore: () => ({
    digest: async (mode?: 'daily' | 'weekly') => {
      const d = forMcp();
      const [view, preview] = await Promise.all([d.view(), d.preview(mode)]);
      return { ...view, scheduled: PATHS.alertsOn, preview };
    },
    setDigest: (patch: Partial<DigestSettings>) => setDigestPrefs(patch),
  }),
  jobs: [{ name: 'digest', everyMs: 60_000, runAtStart: true, enabled: (paths) => paths.alertsOn, run: (ctx) => forServer(ctx).tick() }],
  // the 🔔 dialog's 요약 알림 section, and the 설정 tab's 알림 section (settings.html#notify)
  ui: [{ pages: ['index.html', '#settings'], script: 'features/digest.js' }],
};
