// Per-port user preferences (label, pinned, hidden), kept outside the repo:
//   ~/.config/portboard/prefs.json   (override with PORTBOARD_PREFS)

import { readFile } from 'node:fs/promises';
import { PATHS } from './paths.ts';
import { DEFAULT_TIME, parseSettings, type DigestSettings } from './digest.ts';
import { writePrivate } from './atomic.ts';

export interface PortPrefs {
  label?: string;
  pinned?: boolean;
  hidden?: boolean;
  /** Push a down/up alert for this port (src/core/alerts.ts) */
  alert?: boolean;
  /** What to do when this port starts listening (src/core/newports.ts); absent = from the port rules */
  onNew?: OnNew;
}

/** When a new listening port appears (src/core/newports.ts), after VS Code's onAutoForward */
export type OnNew = 'notify' | 'openBrowserOnce' | 'silent' | 'ignore';
export const ON_NEW: readonly OnNew[] = ['notify', 'openBrowserOnce', 'silent', 'ignore'];

/**
 * A port rule (src/core/portrules.ts): what a range (`3000-3010`), a `host:port` or a command-line regex sets for
 * every port it matches. Exact-port entries (Prefs.ports) always win, field by field.
 */
export interface PortRule {
  label?: string;
  pinned?: boolean;
  hidden?: boolean;
  onNew?: OnNew;
}

export interface Prefs {
  ports: Record<string, PortPrefs>;
  /** compute-pool host name → Tailscale device name, for pool hosts reached over the LAN ({"desktop": "desktop-pc"}) */
  deviceLinks?: Record<string, string>;
  /** Tailscale device id → true: push an alert when it goes offline (src/core/alerts.ts) */
  deviceAlerts?: Record<string, true>;
  /** New-device alerts (src/core/known.ts). Absent = default: connections on, neighbours (ip neigh) off */
  newDevices?: NewDevicePrefs;
  /** 일간/주간 요약 알림 (src/core/digest.ts). Absent = off at 09:00 KST */
  digest?: DigestSettings;
  /** Smart defaults the user dismissed (무시): suggestion id → when (src/core/suggest.ts) */
  suggestions?: { dismissed: Record<string, string> };
  /** SessionEnd 훅 정리 (src/features/claude-session.ts, #43). Absent = autoStop off */
  claudeCleanup?: ClaudeCleanupPrefs;
  /** Port rules by key: `3000-3010`, `localhost:5173`, or a regex on the command line (src/core/portrules.ts) */
  portRules?: Record<string, PortRule>;
  /** What applies to a port no rule in portRules matches (VS Code's otherPortsAttributes) */
  otherPorts?: PortRule;
}

export type AutoStop = 'off' | 'scratchpad' | 'all';
export const AUTO_STOP: readonly AutoStop[] = ['off', 'scratchpad', 'all'];

export interface ClaudeCleanupPrefs {
  /** Stop an ended session's servers on its SessionEnd hook: never, only scratchpad/transient ones, or all of them */
  autoStop: AutoStop;
}

export interface NewDevicePrefs {
  /** A device connects to a service on this server for the first time (default on) */
  connections?: boolean;
  /** A MAC shows up in this server's neighbour table (ARP/NDP) for the first time (default off) */
  neighbors?: boolean;
}

export function newDeviceSettings(p: Prefs): Required<NewDevicePrefs> {
  return { connections: p.newDevices?.connections ?? true, neighbors: p.newDevices?.neighbors ?? false };
}

export const PREFS_PATH = PATHS.prefs;

export async function loadPrefs(path = PREFS_PATH): Promise<Prefs> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const links = raw && typeof raw.deviceLinks === 'object' && raw.deviceLinks ? raw.deviceLinks : undefined;
    const devAlerts = raw && typeof raw.deviceAlerts === 'object' && raw.deviceAlerts ? raw.deviceAlerts : undefined;
    const nd = raw && typeof raw.newDevices === 'object' && raw.newDevices ? raw.newDevices : undefined;
    const newDevices: NewDevicePrefs = {};
    for (const k of ['connections', 'neighbors'] as const) if (typeof nd?.[k] === 'boolean') newDevices[k] = nd[k];
    const digest = raw && typeof raw.digest === 'object' && raw.digest ? parseSettings(raw.digest) : undefined;
    const dismissed: Record<string, string> = {};
    const rawDismissed = raw?.suggestions?.dismissed;
    if (rawDismissed && typeof rawDismissed === 'object') for (const [k, v] of Object.entries(rawDismissed)) if (typeof v === 'string') dismissed[k] = v;
    const autoStop = raw?.claudeCleanup?.autoStop;
    const { rules, other } = parseRules(raw?.portRules, raw?.otherPorts);
    return {
      ports: raw && typeof raw.ports === 'object' && raw.ports ? raw.ports : {},
      ...(links ? { deviceLinks: links } : {}),
      ...(devAlerts ? { deviceAlerts: devAlerts } : {}),
      ...(Object.keys(newDevices).length ? { newDevices } : {}),
      ...(digest ? { digest } : {}),
      ...(Object.keys(dismissed).length ? { suggestions: { dismissed } } : {}),
      ...(AUTO_STOP.includes(autoStop) && autoStop !== 'off' ? { claudeCleanup: { autoStop } } : {}),
      ...(Object.keys(rules).length ? { portRules: rules } : {}),
      ...(other ? { otherPorts: other } : {}),
    };
  } catch {
    return { ports: {} };
  }
}

export interface PrefsPatch {
  /** Empty string or null clears the label */
  label?: string | null;
  pinned?: boolean;
  hidden?: boolean;
  alert?: boolean;
  /** null clears it (the port rules decide again) */
  onNew?: OnNew | null;
}

/** Validates a patch from a client; returns an error message or null. */
export function checkPatch(patch: unknown): string | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'body must be an object';
  const p = patch as Record<string, unknown>;
  for (const key of Object.keys(p)) if (!['label', 'pinned', 'hidden', 'alert', 'onNew'].includes(key)) return `unknown field: ${key}`;
  if (p.onNew !== undefined && p.onNew !== null && !ON_NEW.includes(p.onNew as OnNew)) return `onNew must be one of ${ON_NEW.join(', ')} or null`;
  if (p.label !== undefined && p.label !== null && typeof p.label !== 'string') return 'label must be a string or null';
  if (typeof p.label === 'string' && p.label.length > 80) return 'label is longer than 80 characters';
  for (const key of ['pinned', 'hidden', 'alert']) {
    if (p[key] !== undefined && typeof p[key] !== 'boolean') return `${key} must be a boolean`;
  }
  return null;
}

export function applyPatch(current: PortPrefs, patch: PrefsPatch): PortPrefs {
  const next: PortPrefs = { ...current };
  if (patch.label !== undefined) {
    const label = patch.label?.trim();
    if (label) next.label = label;
    else delete next.label;
  }
  for (const key of ['pinned', 'hidden', 'alert'] as const) {
    if (patch[key] === true) next[key] = true;
    else if (patch[key] === false) delete next[key];
  }
  if (patch.onNew === null) delete next.onNew;
  else if (patch.onNew) next.onNew = patch.onNew;
  return next;
}

// Serialise writes so two quick clicks can't interleave read-modify-write.
let queue: Promise<unknown> = Promise.resolve();

export function setPortPrefs(port: number, patch: PrefsPatch, path = PREFS_PATH): Promise<PortPrefs> {
  return update(path, (prefs) => {
    const next = applyPatch(prefs.ports[port] ?? {}, patch);
    // With port rules, an unpin or un-hide has to be stored, or a rule that pins or hides the port wins again
    if (prefs.portRules || prefs.otherPorts) for (const key of ['pinned', 'hidden'] as const) if (patch[key] === false) next[key] = false;
    if (Object.keys(next).length) prefs.ports[port] = next;
    else delete prefs.ports[port];
    return next;
  });
}

/** Offline alert for a tailnet device (id = Tailscale DNS label) */
export function setDeviceAlert(id: string, on: boolean, path = PREFS_PATH): Promise<boolean> {
  return update(path, (prefs) => {
    const next = { ...prefs.deviceAlerts };
    if (on) next[id] = true;
    else delete next[id];
    if (Object.keys(next).length) prefs.deviceAlerts = next;
    else delete prefs.deviceAlerts;
    return on;
  });
}

/** Only explicit choices are stored; a value equal to the default is removed. */
export function setNewDevicePrefs(patch: NewDevicePrefs, path = PREFS_PATH): Promise<Required<NewDevicePrefs>> {
  return update(path, (prefs) => {
    const next: NewDevicePrefs = { ...prefs.newDevices };
    for (const k of ['connections', 'neighbors'] as const) if (typeof patch[k] === 'boolean') next[k] = patch[k];
    if (next.connections === true) delete next.connections;
    if (next.neighbors === false) delete next.neighbors;
    if (Object.keys(next).length) prefs.newDevices = next;
    else delete prefs.newDevices;
    return newDeviceSettings(prefs);
  });
}

/** 요약 알림: merges {mode?, time?} (checked by digest.ts checkSettings); off at the default time is removed. */
export function setDigestPrefs(patch: Partial<DigestSettings>, path = PREFS_PATH): Promise<DigestSettings> {
  return update(path, (prefs) => {
    const next = parseSettings({ ...prefs.digest, ...patch });
    if (next.mode === 'off' && next.time === DEFAULT_TIME) delete prefs.digest;
    else prefs.digest = next;
    return next;
  });
}

/** 무시 on a suggestion: it isn't shown again. */
export function dismissSuggestion(id: string, now = Date.now(), path = PREFS_PATH): Promise<string[]> {
  return update(path, (prefs) => {
    prefs.suggestions = { dismissed: { ...prefs.suggestions?.dismissed, [id]: new Date(now).toISOString() } };
    return Object.keys(prefs.suggestions.dismissed);
  });
}

/** SessionEnd 훅 자동 정리 mode; 'off' (the default) is removed. */
export function setClaudeCleanup(autoStop: AutoStop, path = PREFS_PATH): Promise<ClaudeCleanupPrefs> {
  return update(path, (prefs) => {
    if (autoStop === 'off') delete prefs.claudeCleanup;
    else prefs.claudeCleanup = { autoStop };
    return { autoStop };
  });
}

// ---------- port rules (src/core/portrules.ts matches them) ----------

export const MAX_RULES = 100;
export const MAX_RULE_KEY = 200;

export type RuleKind = 'port' | 'range' | 'host' | 'command';

export type ParsedKey =
  | { kind: 'port'; port: number }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'host'; host: string; port: number }
  | { kind: 'command'; re: RegExp };

const isPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

/**
 * What a rule key is, the way VS Code reads `remote.portsAttributes` keys: a port (`3000`), an inclusive range
 * (`3000-3010`), `host:port` (`localhost:5173`, `127.0.0.1:5173`, `*:3000`), otherwise a regex on the command line
 * (case-insensitive). Returns an error message for a key that is none of these.
 */
export function parseRuleKey(key: string): ParsedKey | string {
  const k = key.trim();
  if (!k) return 'rule key is empty';
  if (k.length > MAX_RULE_KEY) return `rule key is longer than ${MAX_RULE_KEY} characters`;
  if (/^\d+$/.test(k)) return isPort(Number(k)) ? { kind: 'port', port: Number(k) } : `port ${k} is outside 1–65535`;
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(k);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (!isPort(from) || !isPort(to)) return `range ${k} is outside 1–65535`;
    if (from > to) return `range ${k} runs backwards`;
    return { kind: 'range', from, to };
  }
  const host = /^([a-z0-9.*-]+|\[[0-9a-f:]+\]):(\d{1,5})$/i.exec(k);
  if (host) {
    const port = Number(host[2]);
    if (!isPort(port)) return `port in ${k} is outside 1–65535`;
    return { kind: 'host', host: host[1].toLowerCase().replace(/^\[|\]$/g, ''), port };
  }
  try {
    return { kind: 'command', re: new RegExp(k, 'i') };
  } catch (err) {
    return `not a port, range, host:port or valid regex: ${(err as Error).message}`;
  }
}

/** Validates one rule's fields; returns an error message or null. An empty rule is allowed (it removes the key). */
export function checkRule(rule: unknown): string | null {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return 'rule must be an object';
  const r = rule as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!['label', 'pinned', 'hidden', 'onNew'].includes(key)) return `unknown field: ${key}`;
  if (r.label !== undefined && r.label !== null && typeof r.label !== 'string') return 'label must be a string or null';
  if (typeof r.label === 'string' && r.label.length > 80) return 'label is longer than 80 characters';
  for (const key of ['pinned', 'hidden']) if (r[key] !== undefined && r[key] !== null && typeof r[key] !== 'boolean') return `${key} must be a boolean or null`;
  if (r.onNew !== undefined && r.onNew !== null && !ON_NEW.includes(r.onNew as OnNew)) return `onNew must be one of ${ON_NEW.join(', ')} or null`;
  return null;
}

/** The fields of a checked rule that set something (null, empty labels and unknown values dropped) */
export function cleanRule(rule: Record<string, unknown>): PortRule {
  const out: PortRule = {};
  if (typeof rule.label === 'string' && rule.label.trim()) out.label = rule.label.trim().slice(0, 80);
  if (typeof rule.pinned === 'boolean') out.pinned = rule.pinned;
  if (typeof rule.hidden === 'boolean') out.hidden = rule.hidden;
  if (ON_NEW.includes(rule.onNew as OnNew)) out.onNew = rule.onNew as OnNew;
  return out;
}

/** portRules / otherPorts as read from the file: invalid keys and rules are dropped (list_port_rules names them). */
export function parseRules(rawRules: unknown, rawOther: unknown): { rules: Record<string, PortRule>; other: PortRule | null; problems: string[] } {
  const rules: Record<string, PortRule> = {};
  const problems: string[] = [];
  if (rawRules && typeof rawRules === 'object' && !Array.isArray(rawRules)) {
    for (const [key, rule] of Object.entries(rawRules)) {
      if (Object.keys(rules).length >= MAX_RULES) {
        problems.push(`more than ${MAX_RULES} rules: the rest are ignored`);
        break;
      }
      const k = parseRuleKey(key);
      const bad = typeof k === 'string' ? k : checkRule(rule);
      if (bad) problems.push(`${key}: ${bad}`);
      else rules[key.trim()] = cleanRule(rule as Record<string, unknown>);
    }
  } else if (rawRules !== undefined) problems.push('portRules must be an object');
  let other: PortRule | null = null;
  if (rawOther !== undefined) {
    const bad = checkRule(rawOther);
    if (bad) problems.push(`otherPorts: ${bad}`);
    else other = cleanRule(rawOther as Record<string, unknown>);
    if (other && !Object.keys(other).length) other = null;
  }
  return { rules, other, problems };
}

/** Problems with portRules / otherPorts in the file as it is (what loadPrefs dropped) */
export async function ruleProblems(path = PREFS_PATH): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return parseRules(raw?.portRules, raw?.otherPorts).problems;
  } catch {
    return [];
  }
}

export const OTHER_PORTS = 'otherPorts';

/**
 * Set (or with an empty rule, remove) one rule. `otherPorts` sets the default; a single port is written as an exact
 * entry in `ports`, like a rename in the UI, and only label and onNew are taken from the rule for it then (pinned and
 * hidden too). Fields set to null are removed. Resolves to where it was written and what is stored there now.
 */
export function setPortRule(key: string, rule: Record<string, unknown>, path = PREFS_PATH): Promise<{ key: string; where: 'ports' | 'portRules' | 'otherPorts'; rule: PortRule | null }> {
  const bad = checkRule(rule);
  if (bad) return Promise.reject(new Error(bad));
  const k = key.trim();
  if (k === OTHER_PORTS) {
    return update(path, (prefs) => {
      const next = mergeRule(prefs.otherPorts ?? {}, rule);
      if (Object.keys(next).length) prefs.otherPorts = next;
      else delete prefs.otherPorts;
      return { key: k, where: 'otherPorts' as const, rule: Object.keys(next).length ? next : null };
    });
  }
  const parsed = parseRuleKey(k);
  if (typeof parsed === 'string') return Promise.reject(new Error(parsed));
  if (parsed.kind === 'port') {
    const patch: PrefsPatch = {};
    if ('label' in rule) patch.label = (rule.label as string | null) ?? null;
    if ('onNew' in rule) patch.onNew = (rule.onNew as OnNew | null) ?? null;
    // null leaves a port's own pin and hide alone (the dashboard's buttons change those)
    for (const f of ['pinned', 'hidden'] as const) if (typeof rule[f] === 'boolean') patch[f] = rule[f] as boolean;
    return setPortPrefs(parsed.port, patch, path).then((p) => ({ key: String(parsed.port), where: 'ports' as const, rule: Object.keys(p).length ? p : null }));
  }
  return update(path, (prefs) => {
    const rules = { ...prefs.portRules };
    const next = mergeRule(rules[k] ?? {}, rule);
    if (Object.keys(next).length) rules[k] = next;
    else delete rules[k];
    if (!(k in (prefs.portRules ?? {})) && Object.keys(rules).length > MAX_RULES) throw new Error(`at most ${MAX_RULES} rules`);
    if (Object.keys(rules).length) prefs.portRules = rules;
    else delete prefs.portRules;
    return { key: k, where: 'portRules' as const, rule: Object.keys(next).length ? next : null };
  });
}

/** Remove a rule (or otherPorts) as a whole */
export function removePortRule(key: string, path = PREFS_PATH): Promise<boolean> {
  const k = key.trim();
  return update(path, (prefs) => {
    if (k === OTHER_PORTS) {
      const had = !!prefs.otherPorts;
      delete prefs.otherPorts;
      return had;
    }
    if (!prefs.portRules || !(k in prefs.portRules)) return false;
    const rules = { ...prefs.portRules };
    delete rules[k];
    if (Object.keys(rules).length) prefs.portRules = rules;
    else delete prefs.portRules;
    return true;
  });
}

function mergeRule(current: PortRule, patch: Record<string, unknown>): PortRule {
  const next: Record<string, unknown> = { ...current };
  for (const [f, v] of Object.entries(patch)) {
    if (v === null || v === undefined || (f === 'label' && typeof v === 'string' && !v.trim())) delete next[f];
    else next[f] = v;
  }
  return cleanRule(next);
}

function update<T>(path: string, change: (prefs: Prefs) => T): Promise<T> {
  const job = queue.then(async () => {
    const prefs = await loadPrefs(path);
    const result = change(prefs);
    await writePrivate(path, `${JSON.stringify(prefs, null, 2)}\n`);
    return result;
  });
  queue = job.catch(() => {});
  return job;
}
