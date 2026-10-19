// 기기 상태 알림 (c10dev/portboard#2): compute-pool job failures, a Proxmox guest running but off the tailnet, and
// sustained high load on a pool host, alerted through the down alerts' channel (src/core/devhealth.ts).
//
//   GET /api/devhealth   conditions now (alerted ones, and breaches still within their sustain) with the thresholds
//   job devhealth        every 60 s on the scheduler: one devices read, the condition steps, devhealth-state.json
//   digest               one line while a condition is alerted (devhealthForDigest)
//
// Config: devhealth.json in the config dir (paths.devhealth, PORTBOARD_DEVHEALTH moves it), read on every check, never
// written: {"failMinRuns": 5, "failPct": 50, "offlineMin": 30, "loadPerCore": 2, "loadMin": 15, "recoverMin": 5,
// "reminderHours": 6}. Alerts go out only where paths.alertsOn (production; never a preview by default); the state is
// tracked either way. Read-only: nothing here touches a device.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { httpSender, loadChannel, redact, type Message, type Sent } from '../core/alerts.ts';
import { appendPrivate, writePrivate } from '../core/atomic.ts';
import { devices } from '../core/devices.ts';
import {
  conditionsView,
  devhealthMessage,
  digestLine,
  emptyState,
  observe,
  parseState,
  parseThresholds,
  stepAll,
  DEVHEALTH_STATE,
  type ConditionView,
  type DevHealthStateFile,
  type DevHealthThresholds,
  type HealthInput,
} from '../core/devhealth.ts';
import { PATHS, type Paths } from '../core/paths.ts';
import { ok } from './router.ts';
import type { FeatureModule } from './types.ts';

export const CHECK_EVERY = 60_000;

export const statePath = (paths: Paths = PATHS) => join(paths.stateDir, DEVHEALTH_STATE);

export async function loadThresholds(path = PATHS.devhealth): Promise<DevHealthThresholds> {
  try {
    return parseThresholds(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return parseThresholds(null);
  }
}

export async function loadState(path = statePath()): Promise<DevHealthStateFile> {
  const text = await readFile(path, 'utf8').catch(() => null);
  return text ? parseState(text) : emptyState();
}

async function deliver(paths: Paths, m: Message): Promise<boolean> {
  const c = await loadChannel(paths.alertChannel).catch(() => null);
  // no channel: nothing to retry
  if (!c) return true;
  const sent: Sent[] = await httpSender()(c, m).catch((err) => [{ channel: 'ntfy' as const, ok: false, error: redact(String(err), c) }]);
  await appendPrivate(paths.alertsLog, `${JSON.stringify({ t: new Date().toISOString(), key: m.key, kind: m.kind, title: m.title, body: m.body, sent })}\n`).catch(() => {});
  return sent.some((x) => x.ok);
}

export interface CheckDeps {
  /** the devices data (default: src/core/devices.ts, as /api/devices reads it) */
  read?: () => Promise<HealthInput>;
  /** default: the alert channel; true when something got through (or there is no channel) */
  send?: (paths: Paths, m: Message) => Promise<boolean>;
}

let file: DevHealthStateFile | null = null;
let running: Promise<DevHealthStateFile> | null = null;

/** One check: the devices, every condition's step (and its alerts), the state file. */
export function checkOnce(paths: Paths, deps: CheckDeps = {}, now = Date.now()): Promise<DevHealthStateFile> {
  running ??= (async () => {
    try {
      const th = await loadThresholds(paths.devhealth);
      const input = await (deps.read ?? (() => devices()))();
      const prev = (file ??= await loadState(statePath(paths)));
      const { next, events } = stepAll(prev, observe(input, now, th), now, th);
      for (const e of events) {
        console.error(`[portboard] devhealth: ${e.event} ${e.key}`);
        // Previews and PORTBOARD_ALERTS=off track the state and send nothing (paths.alertsOn)
        if (!paths.alertsOn) continue;
        if (await (deps.send ?? deliver)(paths, devhealthMessage(e.key, e.event, e.cond, e.since, now))) continue;
        // nothing got through: try again next minute
        const c = next.conditions[e.key];
        if (e.event === 'warn' && c) next.conditions[e.key] = { ...c, active: false };
        if (e.event === 'remind' && c) next.conditions[e.key] = { ...c, lastSent: prev.conditions[e.key]?.lastSent ?? null };
      }
      file = next;
      await writePrivate(statePath(paths), `${JSON.stringify(next)}\n`).catch((err) => console.error(`[portboard] devhealth state: ${(err as Error).message}`));
      return next;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Forget the in-process state (tests) */
export function resetForTest() {
  file = null;
}

export interface DevHealthView {
  /** ISO time of the last check, null before the first */
  at: string | null;
  /** this process sends the alerts (paths.alertsOn) */
  alertsOn: boolean;
  thresholds: DevHealthThresholds;
  conditions: ConditionView[];
}

export async function viewOf(paths: Paths): Promise<DevHealthView> {
  const f = file ?? (await loadState(statePath(paths)));
  return { at: f.at, alertsOn: paths.alertsOn, thresholds: await loadThresholds(paths.devhealth), conditions: conditionsView(f) };
}

/** The digest's 🖥️ line, from the state file (the server or the stdio MCP server) */
export async function devhealthForDigest(paths: Paths = PATHS): Promise<{ problem: boolean; text: string } | null> {
  return digestLine(await loadState(statePath(paths)));
}

export const devhealthFeature: FeatureModule = {
  name: 'devhealth',
  order: 2550,
  routes: [{ method: 'GET', path: '/api/devhealth', handler: async (_r, ctx) => ok(await viewOf(ctx.paths)) }],
  jobs: [{ name: 'devhealth', everyMs: CHECK_EVERY, run: (ctx) => checkOnce(ctx.paths).catch((err) => console.error(`[portboard] devhealth: ${(err as Error).message}`)) }],
};
