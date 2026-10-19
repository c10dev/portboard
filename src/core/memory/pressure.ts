// 메모리 (src/core/memory.ts): the memory-pressure state machine (stepPressure) and its alert text.

import { dur, type Message } from '../alerts.ts';
import { t } from '../i18n.ts';
import type { MemorySample, Thresholds } from './sample.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface PressureState {
  /** a warning went out and it hasn't recovered yet */
  active: boolean;
  /** ms: when the current breach began (the first sample over a threshold) */
  breachSince: number | null;
  /** ms: when it began to look clear again (while active) */
  clearSince: number | null;
  /** ms: the last warning or reminder sent */
  lastSent: number | null;
  /** ms: the last sample this state saw */
  lastSample: number | null;
  reasons: PressureReason[];
}

export type PressureReason = 'available' | 'psi' | 'swap';

export const emptyPressure = (): PressureState => ({ active: false, breachSince: null, clearSince: null, lastSent: null, lastSample: null, reasons: [] });

/** Margins a recovery needs past the threshold, so a value hovering at it doesn't flap */
export const RECOVER_MARGIN = { availablePct: 2, psiFactor: 0.6, swapPct: 5 };

export interface PressureInput {
  availablePct: number;
  swapPct: number;
  swapTotalMb: number;
  psiSome60: number | null;
}

export function pressureReasons(s: PressureInput, th: Thresholds): PressureReason[] {
  const out: PressureReason[] = [];
  if (s.availablePct < th.availablePct) out.push('available');
  if (s.psiSome60 !== null && s.psiSome60 > th.psiSome60) out.push('psi');
  if (s.swapTotalMb > 0 && s.swapPct > th.swapPct) out.push('swap');
  return out;
}

function clearOf(s: PressureInput, th: Thresholds): boolean {
  return (
    s.availablePct >= th.availablePct + RECOVER_MARGIN.availablePct &&
    (s.psiSome60 === null || s.psiSome60 <= th.psiSome60 * RECOVER_MARGIN.psiFactor) &&
    (s.swapTotalMb === 0 || s.swapPct <= th.swapPct - RECOVER_MARGIN.swapPct)
  );
}

export type PressureEvent = 'warn' | 'remind' | 'recover';

/**
 * One sample. A breach must last `sustainMin` (samples more than 3 minutes apart break the run: the server was
 * down); while active, a reminder every `reminderHours`; recovery once clear, with margins, for `sustainMin`.
 */
export function stepPressure(prev: PressureState | undefined, s: PressureInput, now: number, th: Thresholds): { next: PressureState; event: PressureEvent | null } {
  const st: PressureState = { ...emptyPressure(), ...prev };
  const gap = st.lastSample !== null && now - st.lastSample > 3 * MIN;
  st.lastSample = now;
  const reasons = pressureReasons(s, th);
  const sustain = th.sustainMin * MIN;
  if (!st.active) {
    if (!reasons.length) return { next: { ...st, breachSince: null, reasons: [] }, event: null };
    if (st.breachSince === null || gap) st.breachSince = now;
    st.reasons = reasons;
    if (now - st.breachSince < sustain) return { next: st, event: null };
    return { next: { ...st, active: true, clearSince: null, lastSent: now }, event: 'warn' };
  }
  if (reasons.length) st.reasons = reasons;
  if (clearOf(s, th)) {
    if (st.clearSince === null || gap) st.clearSince = now;
    if (now - st.clearSince >= sustain) return { next: { ...emptyPressure(), lastSample: now }, event: 'recover' };
    return { next: st, event: null };
  }
  st.clearSince = null;
  if (st.lastSent === null || now - st.lastSent >= th.reminderHours * HOUR) return { next: { ...st, lastSent: now }, event: 'remind' };
  return { next: st, event: null };
}

export const REASON_TEXT: Record<PressureReason, string> = {
  get available() {
    return t('memoryMsg.reason.available');
  },
  get psi() {
    return t('memoryMsg.reason.psi');
  },
  get swap() {
    return t('memoryMsg.reason.swap');
  },
};

/** MB as GB with one decimal ("7.5 GB") */
export const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

/** Who uses the most, for the alert: "Claude CLIs 16.7 GB (73) · rea 7.5 GB ×30 · @playwright/mcp 6.0 GB ×72" */
export function topLine(s: MemorySample): string {
  const cli = s.groups.find((g) => g.key === 'claude');
  const parts = [...(cli && cli.mb ? [`Claude CLIs ${gb(cli.mb)} (${s.sessions.length})`] : []), ...s.mcp.slice(0, 3).map((m) => `${m.label} ${gb(m.mb)} ×${m.instances}`)];
  return parts.join(' · ');
}

/**
 * The alert text (English titles like the other alerts; names and sizes only, no paths). `since`: when the breach
 * began (for a recovery, the state before the step).
 */
export function pressureMessage(event: PressureEvent, s: MemorySample, since: number | null, now: number, host: string): Message {
  const m = s.mem;
  const facts = `available ${gb(m.availableMb)} of ${gb(m.totalMb)} (${m.availablePct}%), swap ${m.swapPct}% used${s.psi ? `, PSI some avg60 ${s.psi.some.avg60}` : ''}`;
  if (event === 'recover') {
    const lasted = since !== null ? ` after ${dur(now - since)}` : '';
    return { key: 'memory:pressure', kind: 'recovered', title: `portboard: ${host} memory is back to normal`, body: `Memory pressure is over${lasted}: ${facts}.`, high: false };
  }
  const idle = s.sessions.filter((x) => x.idle);
  const idleMb = idle.reduce((a, x) => a + x.mb, 0);
  const hint = idle.length ? ` ${idle.length} idle Claude sessions hold ${gb(idleMb)}: archive them in the Claude app.` : '';
  const forText = since !== null ? ` for ${dur(now - since)}` : '';
  return {
    key: 'memory:pressure',
    kind: 'warning',
    title: `portboard: ${host} is low on memory${event === 'remind' ? ' (still)' : ''}`,
    body: `Memory pressure${forText}: ${facts}. Biggest: ${topLine(s)}.${hint}`,
    high: event === 'warn',
  };
}
