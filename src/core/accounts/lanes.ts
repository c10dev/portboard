// The GPT lane and the desktop route as the owner set them in Settings (docs/accounts.md#settings): accounts-lanes.json in the
// config folder (PATHS.accountsLanes, 0600). Each top key is optional; a key the file lacks falls back to portboard.json
// (`accounts.proxy.gpt`, `accounts.proxy.desktop`). The file never turns the proxy itself on: that stays in portboard.json.
// A file that others can read or write, that is not a regular file, or that is not JSON is not used (both keys fall back) and
// the report says so. Writes go through writePrivate.

import { readFile, stat } from 'node:fs/promises';
import { writePrivate } from '../atomic.ts';
import { PATHS } from '../paths.ts';
import { GPT_MAX_MODELS, GPT_NAME, parseDesktopConfig, parseGptConfig, SITE } from '../site.ts';
import { MODEL_ID, type GptConfig } from './gpt.ts';

export interface Lanes {
  gpt: GptConfig;
  desktop: { enabled: boolean };
}

export type LaneSource = { gpt: 'file' | 'config'; desktop: 'file' | 'config' };

export type LanesRead = Lanes & { source: LaneSource; unreadable?: true };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The lanes in effect: the file's values where the file has them, else portboard.json's; `source` says which file each came from */
export async function readLanes(o: { path?: string; site?: Pick<typeof SITE, 'accounts'> } = {}): Promise<LanesRead> {
  const site = o.site ?? SITE;
  const fallback: LanesRead = {
    gpt: { enabled: site.accounts.proxy.gpt.enabled, models: { ...site.accounts.proxy.gpt.models } },
    desktop: { enabled: site.accounts.proxy.desktop.enabled },
    source: { gpt: 'config', desktop: 'config' },
  };
  const path = o.path ?? PATHS.accountsLanes;
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    // no file: nothing to say; any other failure is a file we cannot use
    return (err as { code?: unknown } | null)?.code === 'ENOENT' ? fallback : { ...fallback, unreadable: true };
  }
  if (!st.isFile() || (st.mode & 0o077) !== 0) return { ...fallback, unreadable: true };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { ...fallback, unreadable: true };
  }
  if (!isObj(raw)) return { ...fallback, unreadable: true };
  const out: LanesRead = { ...fallback };
  if (isObj(raw.gpt)) {
    out.gpt = parseGptConfig(raw.gpt);
    out.source = { ...out.source, gpt: 'file' };
  }
  if (isObj(raw.desktop)) {
    out.desktop = parseDesktopConfig(raw.desktop);
    out.source = { ...out.source, desktop: 'file' };
  }
  return out;
}

/** Write the whole file (0600) */
export async function writeLanes(next: Lanes, o: { path?: string } = {}): Promise<void> {
  const body = { gpt: { enabled: next.gpt.enabled, models: next.gpt.models }, desktop: { enabled: next.desktop.enabled } };
  await writePrivate(o.path ?? PATHS.accountsLanes, `${JSON.stringify(body, null, 2)}\n`);
}

/** What the lanes route accepts */
export interface LanesPatch {
  gpt?: { enabled?: boolean; models?: Record<string, string> };
  desktop?: { enabled?: boolean };
}

/** The body of the lanes route, or null for any other shape: unknown keys, a non-boolean `enabled`, more than 32 models, a bad name or model id */
export function parseLanesPatch(body: unknown): LanesPatch | null {
  if (!isObj(body)) return null;
  const patch: LanesPatch = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'desktop') {
      if (!isObj(v) || Object.keys(v).some((x) => x !== 'enabled')) return null;
      if ('enabled' in v && typeof v.enabled !== 'boolean') return null;
      patch.desktop = 'enabled' in v ? { enabled: v.enabled as boolean } : {};
    } else if (k === 'gpt') {
      if (!isObj(v) || Object.keys(v).some((x) => x !== 'enabled' && x !== 'models')) return null;
      const g: NonNullable<LanesPatch['gpt']> = {};
      if ('enabled' in v) {
        if (typeof v.enabled !== 'boolean') return null;
        g.enabled = v.enabled;
      }
      if ('models' in v) {
        if (!isObj(v.models)) return null;
        const entries = Object.entries(v.models);
        if (entries.length > GPT_MAX_MODELS) return null;
        // `__proto__` would not be a plain entry of the map: refused
        if (entries.some(([name, id]) => name === '__proto__' || !GPT_NAME.test(name) || typeof id !== 'string' || !MODEL_ID.test(id))) return null;
        g.models = Object.fromEntries(entries) as Record<string, string>;
      }
      patch.gpt = g;
    } else return null;
  }
  return patch;
}

/** `patch` over `base`: a field not sent keeps its value; `models` sent replaces the whole map */
export function applyLanesPatch(base: Lanes, patch: LanesPatch): Lanes {
  return {
    gpt: { enabled: patch.gpt?.enabled ?? base.gpt.enabled, models: patch.gpt?.models ?? { ...base.gpt.models } },
    desktop: { enabled: patch.desktop?.enabled ?? base.desktop.enabled },
  };
}
