// 메모리 (src/core/memory.ts): the sparkline history and memory-state.json (pressure state, history, the last view
// for the stdio MCP and remote servers), and portboard://status's memory line.

import { readFile } from 'node:fs/promises';
import { emptyPressure, type PressureReason, type PressureState } from './pressure.ts';
import { HISTORY, SAMPLE_EVERY, type GroupKey, type MemorySample } from './sample.ts';

const MIN = 60_000;

const readText = (path: string): Promise<string | null> => readFile(path, 'utf8').catch(() => null);

// ---------- history ----------

export interface HistoryPoint {
  t: number;
  availablePct: number;
  swapPct: number;
  psi60: number | null;
  claudeMb: number;
  mcpMb: number;
}

export function historyPoint(s: MemorySample): HistoryPoint {
  const g = (k: GroupKey) => s.groups.find((x) => x.key === k)?.mb ?? 0;
  return { t: Date.parse(s.at), availablePct: s.mem.availablePct, swapPct: s.mem.swapPct, psi60: s.psi?.some.avg60 ?? null, claudeMb: g('claude'), mcpMb: g('mcp') };
}

export function pushHistory(h: HistoryPoint[], p: HistoryPoint, max = HISTORY): HistoryPoint[] {
  const next = [...h.filter((x) => x.t < p.t && p.t - x.t <= max * SAMPLE_EVERY * 1.5), p];
  return next.slice(-max);
}

// ---------- state file ----------

/** What the server keeps across restarts (stateDir/memory-state.json), and the last view for other processes */
export interface MemoryStateFile {
  version: 1;
  pressure: PressureState;
  history: HistoryPoint[];
  /** the last sample without its CPU ticks: the stdio MCP server and the remote server read it */
  view: Omit<MemorySample, 'cpu'> | null;
}

/** Its file name in the state dir */
export const MEMORY_STATE = 'memory-state.json';

export const emptyState = (): MemoryStateFile => ({ version: 1, pressure: emptyPressure(), history: [], view: null });

export function parseState(text: string): MemoryStateFile {
  try {
    const raw = JSON.parse(text);
    if (raw?.version !== 1) return emptyState();
    return {
      version: 1,
      pressure: { ...emptyPressure(), ...(raw.pressure && typeof raw.pressure === 'object' ? raw.pressure : {}) },
      history: Array.isArray(raw.history) ? raw.history.filter((h: any) => typeof h?.t === 'number').slice(-HISTORY) : [],
      view: raw.view && typeof raw.view === 'object' && raw.view.mem ? raw.view : null,
    };
  } catch {
    return emptyState();
  }
}

export async function loadState(path: string): Promise<MemoryStateFile> {
  const text = await readText(path);
  return text ? parseState(text) : emptyState();
}

/** A view this old is not "now" any more (the server stopped sampling) */
export const VIEW_STALE_MS = 5 * MIN;

/** portboard://status's memory line: numbers and reason codes only (the remote server shows it too) */
export interface MemoryStatus {
  at: string;
  pressure: boolean;
  reasons: PressureReason[];
  availablePct: number;
  swapPct: number;
  psiSome60: number | null;
}

export function statusLine(f: MemoryStateFile, now = Date.now()): MemoryStatus | null {
  const v = f.view;
  if (!v || now - Date.parse(v.at) > VIEW_STALE_MS) return null;
  return {
    at: v.at,
    pressure: f.pressure.active,
    reasons: f.pressure.active ? f.pressure.reasons : [],
    availablePct: v.mem.availablePct,
    swapPct: v.mem.swapPct,
    psiSome60: v.psi?.some.avg60 ?? null,
  };
}
