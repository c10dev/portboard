// 메모리 (src/core/memory.ts): the /proc parsers. Pure apart from PAGE_KB, worked out once at import.

import { readFileSync } from 'node:fs';

/** USER_HZ: /proc times are in these ticks on every Linux this runs on */
export const CLK_TCK = 100;
/** /proc/<pid>/stat rss is in pages */
export const PAGE_KB = pageKb();

/**
 * The kernel's page size in kB: 4 on x86-64, 16 or 64 on some arm64 kernels. Node has no API for it, so it is
 * worked out from this process's own RSS, which /proc reports both in kB (status) and in pages (statm); 4 when
 * /proc can't be read (not Linux, tests on another OS).
 */
export function pageKb(): number {
  try {
    const kb = Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]);
    const pages = Number(readFileSync('/proc/self/statm', 'utf8').split(' ')[1]);
    return pageKbFrom(kb, pages);
  } catch {
    return 4;
  }
}

/** The page size that best explains `kb` over `pages` (the two reads are a moment apart): 4, 16 or 64 */
export function pageKbFrom(kb: number, pages: number): number {
  if (!(kb > 0) || !(pages > 0)) return 4;
  const ratio = kb / pages;
  return [4, 16, 64].reduce((best, s) => (Math.abs(Math.log2(ratio / s)) < Math.abs(Math.log2(ratio / best)) ? s : best), 4);
}

// ---------- /proc parsers ----------

export interface MemInfo {
  totalKb: number;
  freeKb: number;
  availableKb: number;
  buffersKb: number;
  cachedKb: number;
  sReclaimableKb: number;
  shmemKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
}

export function parseMeminfo(text: string): MemInfo {
  const v = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
    if (m) v.set(m[1], Number(m[2]));
  }
  const g = (k: string) => v.get(k) ?? 0;
  return {
    totalKb: g('MemTotal'),
    freeKb: g('MemFree'),
    // Kernels before 3.14 have no MemAvailable: free + page cache is the old estimate
    availableKb: v.get('MemAvailable') ?? g('MemFree') + g('Buffers') + g('Cached'),
    buffersKb: g('Buffers'),
    cachedKb: g('Cached'),
    sReclaimableKb: g('SReclaimable'),
    shmemKb: g('Shmem'),
    swapTotalKb: g('SwapTotal'),
    swapFreeKb: g('SwapFree'),
  };
}

export interface PsiLine {
  avg10: number;
  avg60: number;
  avg300: number;
}

export interface Psi {
  some: PsiLine;
  full: PsiLine | null;
}

/** /proc/pressure/memory; null when the kernel has no PSI */
export function parsePsi(text: string): Psi | null {
  const line = (kind: string): PsiLine | null => {
    const m = new RegExp(`^${kind}\\s+avg10=([\\d.]+)\\s+avg60=([\\d.]+)\\s+avg300=([\\d.]+)`, 'm').exec(text);
    return m ? { avg10: Number(m[1]), avg60: Number(m[2]), avg300: Number(m[3]) } : null;
  };
  const some = line('some');
  return some ? { some, full: line('full') } : null;
}

/** /proc/stat btime: boot time in epoch seconds */
export function parseBtime(text: string): number | null {
  const m = /^btime\s+(\d+)/m.exec(text);
  return m ? Number(m[1]) : null;
}

export interface StatLine {
  pid: number;
  comm: string;
  ppid: number;
  /** utime + stime, ticks */
  cpuTicks: number;
  /** ticks after boot */
  startTicks: number;
  rssKb: number;
}

/** /proc/<pid>/stat. comm may hold spaces and parentheses ("(next-server (v1)"), so the fields start after the last ")". */
export function parseStat(text: string): StatLine | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const f = text.slice(close + 2).trim().split(/\s+/);
  // f[0] is field 3 (state): field n is f[n - 3]
  const n = (i: number) => Number(f[i - 3]);
  if (!Number.isFinite(pid) || f.length < 22) return null;
  return { pid, comm: text.slice(open + 1, close), ppid: n(4), cpuTicks: n(14) + n(15), startTicks: n(22), rssKb: n(24) * PAGE_KB };
}

/** Only the session id: a CLI's environment also holds its OAuth token, which never leaves this function. */
export function sessionIdFromEnviron(raw: string): string | null {
  for (const kv of raw.split('\0')) {
    if (kv.startsWith('CLAUDE_CODE_SESSION_ID=')) {
      const id = kv.slice('CLAUDE_CODE_SESSION_ID='.length);
      return UUID.test(id) ? id : null;
    }
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
