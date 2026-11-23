// The proxy's usage log (docs/accounts.md#usage-log): one JSON line per request the proxy sent on, in accounts-usage.jsonl
// (0600, PATHS.accountsUsage). A line holds the time, the provider, the account id, the model name from the request body (128
// characters), the status, four token counts and the duration. It holds no body, no token, no key, no header value and no email.
// A write that fails is dropped without a word: the log never changes an answer. A file that group or others can touch is
// neither read nor written. Lines older than 30 days are not counted, and the file is rewritten without them once a day.

import { readFile, stat } from 'node:fs/promises';
import { appendPrivate, writePrivate } from '../atomic.ts';
import { PATHS } from '../paths.ts';

export interface UsageLine {
  /** ISO */
  at: string;
  provider: 'claude' | 'codex';
  /** account id (acc-...), never an email */
  account: string;
  /** from the request body, clipped to 128 */
  model: string | null;
  /** upstream status, or 0 when no answer reached the caller */
  status: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  ms: number;
}

export interface UsageRow {
  /** UTC date, YYYY-MM-DD */
  day: string;
  provider: 'claude' | 'codex';
  account: string;
  model: string | null;
  requests: number;
  /** the sum over the requests that had the count; null when none had it */
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface UsageSummary {
  days: number;
  totals: Record<'claude' | 'codex', { requests: number; recorded: number }>;
  rows: UsageRow[];
  /** true when the log file exists but cannot be read (loose mode, not a regular file, read error): the zeros then mean "unknown" */
  unavailable?: boolean;
}

/** Lines older than this are not counted and are removed by the daily rewrite */
export const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;
/** The model name of a line is cut to this many characters (here and in the proxy) */
export const MODEL_CLIP = 128;

/** A count: a finite number of 0 or more, else null */
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const providerOf = (v: unknown): 'claude' | 'codex' | null => (v === 'claude' || v === 'codex' ? v : null);

/** One line as the file may hold it: only the allowed keys, each checked; null for a line that is not one */
function parseLine(raw: string): UsageLine | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const provider = providerOf(o.provider);
  const ms = num(o.ms);
  const status = num(o.status);
  if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at)) || !provider || typeof o.account !== 'string' || ms === null || status === null) return null;
  return {
    at: o.at,
    provider,
    account: o.account,
    model: typeof o.model === 'string' ? o.model.slice(0, MODEL_CLIP) : null,
    status,
    input: num(o.input),
    output: num(o.output),
    cacheRead: num(o.cacheRead),
    cacheWrite: num(o.cacheWrite),
    ms,
  };
}

/** The file's text when it is a regular file that only its owner can touch; null when it is missing, odd or loose */
async function readPrivate(path: string): Promise<string | null> {
  try {
    const st = await stat(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Like readPrivate, but says why there is no text: `missing` (no file: an empty log) or `unavailable` */
async function readUsage(path: string): Promise<string | 'missing' | 'unavailable'> {
  try {
    const st = await stat(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return 'unavailable';
    return await readFile(path, 'utf8');
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'ENOENT' ? 'missing' : 'unavailable';
  }
}

/** The same rule for a write: a missing file is fine (it is made 0600), a loose or odd one is not */
async function writable(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isFile() && (st.mode & 0o077) === 0;
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'ENOENT';
  }
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** the UTC day of the last rewrite, per file (in memory: a restart rewrites once more) */
const pruned = new Map<string, string>();
/** appends and rewrites of one process run one after the other, so a rewrite never drops a line that was just added */
let chain: Promise<unknown> = Promise.resolve();

async function prune(path: string, nowMs: number): Promise<void> {
  const text = await readPrivate(path);
  // the file was just appended to: if it cannot be read now, the rewrite failed and is tried again with the next line
  if (text === null) throw new Error('usage log unreadable');
  const from = nowMs - KEEP_DAYS * DAY_MS;
  const keep: string[] = [];
  for (const raw of text.split('\n')) {
    const line = parseLine(raw);
    if (line && Date.parse(line.at) >= from) keep.push(JSON.stringify(line));
  }
  await writePrivate(path, keep.length ? `${keep.join('\n')}\n` : '');
}

/** Add one line. It never throws and writes nothing to the console. */
export function appendUsage(line: UsageLine, path: string = PATHS.accountsUsage): Promise<void> {
  const job = chain.then(async () => {
    try {
      const provider = providerOf(line.provider);
      if (!provider || !(await writable(path))) return;
      // only the contract's keys, built one by one
      const clean: UsageLine = {
        at: String(line.at),
        provider,
        account: String(line.account),
        model: typeof line.model === 'string' ? line.model.slice(0, MODEL_CLIP) : null,
        status: num(line.status) ?? 0,
        input: num(line.input),
        output: num(line.output),
        cacheRead: num(line.cacheRead),
        cacheWrite: num(line.cacheWrite),
        ms: num(line.ms) ?? 0,
      };
      await appendPrivate(path, `${JSON.stringify(clean)}\n`);
      const at = Date.parse(clean.at);
      const nowMs = Number.isNaN(at) ? Date.now() : at;
      // the rewrite only moves forward: a line dated before the last rewrite's day does not start another one.
      // A failed rewrite is not marked, so the next line tries again.
      const day = utcDay(nowMs);
      const last = pruned.get(path);
      if (last === undefined || day > last) {
        await prune(path, nowMs);
        pruned.set(path, day);
      }
    } catch {
      // the log is best effort
    }
  });
  chain = job;
  return job;
}

function add(a: number | null, b: number | null): number | null {
  return b === null ? a : (a ?? 0) + b;
}

/** The last `days` days (at most 30) of the log, grouped by UTC day, provider, account and model */
export async function summarize(days: number, path: string = PATHS.accountsUsage, now: Date = new Date()): Promise<UsageSummary> {
  const window = Math.min(Math.max(Math.trunc(days), 1), KEEP_DAYS);
  const out: UsageSummary = { days: window, totals: { claude: { requests: 0, recorded: 0 }, codex: { requests: 0, recorded: 0 } }, rows: [] };
  const text = await readUsage(path);
  if (text === 'missing') return out;
  if (text === 'unavailable') return { ...out, unavailable: true };
  const from = now.getTime() - window * DAY_MS;
  const groups = new Map<string, UsageRow>();
  for (const raw of text.split('\n')) {
    const line = parseLine(raw);
    if (!line) continue;
    const at = Date.parse(line.at);
    if (at < from) continue;
    const total = out.totals[line.provider];
    total.requests++;
    if (line.input !== null && line.output !== null) total.recorded++;
    const day = utcDay(at);
    const k = JSON.stringify([day, line.provider, line.account, line.model]);
    let row = groups.get(k);
    if (!row) {
      row = { day, provider: line.provider, account: line.account, model: line.model, requests: 0, input: null, output: null, cacheRead: null, cacheWrite: null };
      groups.set(k, row);
    }
    row.requests++;
    row.input = add(row.input, line.input);
    row.output = add(row.output, line.output);
    row.cacheRead = add(row.cacheRead, line.cacheRead);
    row.cacheWrite = add(row.cacheWrite, line.cacheWrite);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  out.rows = [...groups.values()].sort((a, b) => cmp(a.day, b.day) || cmp(a.provider, b.provider) || cmp(a.account, b.account) || cmp(String(a.model), String(b.model)));
  return out;
}
