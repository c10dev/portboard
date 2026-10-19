// 채택 지표 (c10dev/portboard#40): how Claude Code sessions on this machine handle ports, from their transcripts
// (~/.claude/projects/<dir>/<session>.jsonl, and the subagents' <dir>/<session>/subagents/*.jsonl folded into their
// session). Read-only, and nothing a transcript says leaves this module except counts, project dir names, ports and
// short command prefixes (the first one or two "safe" tokens: a command word and a flag, never an argument).
//
// What is counted, per session and KST day (the timestamp of each record; file mtime only decides what to skip):
//   tools      tool_use blocks of assistant messages (each id once, across every file: --resume and forks copy them)
//   shell      Bash / mcp__terminal__run_in_terminal calls (input.command)
//   mcp        Portboard MCP calls: a tool whose server segment contains "portboard" (mcp__portboard__list_ports,
//              a plugin's mcp__plugin_portboard_portboard__…)
//   inspect    a shell call that looks at ports itself: ss -ltn…, lsof -i, netstat -l…, fuser N/tcp
//   kill       a shell call that kills by port: fuser -k, kill $(lsof|ss …), lsof -t -i … | xargs kill, kill-port
//              (a call is kill or inspect, not both: inspect + kill is the raw total)
//   hardcoded  a shell call that starts something on a fixed port: PORT=N / *_PORT=N, --port N, -p N with
//              vite/next/astro/serve, python -m http.server N
//   nudges     Portboard hook context shown to the session (#41/#42): a hook attachment or a hook's added context
//              containing "[portboard]", or a tool result that starts with it (see isNudge)
//   followed   nudges whose next port action in the same file was a Portboard MCP call rather than a raw one
//
// Heredoc bodies are dropped before matching, so a file written with `cat <<EOF` isn't read as commands.

import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { t } from './i18n.ts';
import { SITE } from './site.ts';

const DAY = 86_400_000;
/** The configured fixed UTC offset (portboard.json utcOffset, PORTBOARD_UTC_OFFSET; default +09:00, KST) */
const KST = SITE.utcOffsetMs;

export const MARKER = '[portboard]';

/** KST calendar day of a time: "2026-10-18" */
export const kstDate = (t: number): string => new Date(t + KST).toISOString().slice(0, 10);

/** The day `n` days before `day` */
export const dayMinus = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);

// ---------- commands ----------

export interface CommandHits {
  inspect: boolean;
  kill: boolean;
  /** Ports a server was started on (hard-coded) */
  hardcoded: number[];
  /** Ports the inspection / kill named */
  ports: number[];
  /** Short prefixes of what matched, e.g. "ss -ltnp", "fuser -k", "PORT= npm" */
  prefixes: string[];
}

const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;

/** The command with heredoc bodies removed (the `<<EOF` stays, the text up to EOF goes). */
export const stripHeredocs = (cmd: string): string => cmd.replace(HEREDOC, '<<$2\n');

// Where a command word can start: the beginning, after a separator, $( or a backtick, optionally behind sudo /
// timeout / watch.
const START = String.raw`(?:^|[\n;&|(\x60]|\$\()\s*(?:sudo\s+(?:-\S+\s+)*)?(?:timeout\s+\S+\s+)?(?:watch\s+(?:-\S+(?:\s+[\d.]+)?\s+)*)?`;
const re = (s: string) => new RegExp(START + s, 'g');

const INSPECT: { re: RegExp; label: string }[] = [
  { re: re(String.raw`ss(?:\s+-[a-zA-Z]+)*\s+-[a-zA-Z]*[ltn][a-zA-Z]*`), label: 'ss' },
  { re: re(String.raw`lsof\b[^\n|;&]*?\s-[a-zA-Z]*i`), label: 'lsof' },
  { re: re(String.raw`netstat(?:\s+-[a-zA-Z]+)*\s+-[a-zA-Z]*[lta][a-zA-Z]*`), label: 'netstat' },
  { re: re(String.raw`fuser\b[^\n|;&]*?\d+\/(?:tcp|udp)`), label: 'fuser' },
];

const KILL: { re: RegExp; label: string }[] = [
  { re: re(String.raw`fuser\b[^\n|;&]*?\s-[a-zA-Z]*k`), label: 'fuser -k' },
  { re: re(String.raw`(?:sudo\s+)?kill\b[^\n;&]*?(?:\$\(|\x60)\s*(?:sudo\s+)?(?:ss|lsof|fuser|netstat)\b`), label: 'kill $(…)' },
  { re: re(String.raw`(?:ss|lsof|fuser|netstat)\b[^\n;&]*\|[^\n;&]*\bxargs\s+(?:-\S+\s+)*(?:sudo\s+)?kill\b`), label: '… | xargs kill' },
  { re: re(String.raw`(?:npx\s+(?:-y\s+)?)?kill-port\b`), label: 'kill-port' },
];

const validPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
/** A port an inspection names: below 1024 it is mostly a grep prefix (`grep :30`) or ssh */
const namedPort = (n: number) => validPort(n) && n >= 1024;

/** Ports a raw inspection or kill names: ":3001", "3001/tcp", "kill-port 3001 3002", "grep 3001" after ss/lsof. */
function namedPorts(cmd: string): number[] {
  const out: number[] = [];
  const add = (s: string | undefined) => {
    const n = Number(s);
    if (s && namedPort(n)) out.push(n);
  };
  for (const m of cmd.matchAll(/(?<![\w.:/])(?:-i\s*(?:tcp|udp|4|6)?|sport\s*(?:=|eq)\s*|dport\s*(?:=|eq)\s*|\s)?:(\d{2,5})\b(?![.\d])/gi)) add(m[1]);
  for (const m of cmd.matchAll(/\b(\d{2,5})\/(?:tcp|udp)\b/g)) add(m[1]);
  for (const m of cmd.matchAll(/kill-port((?:\s+\d{2,5})+)/g)) for (const p of m[1].trim().split(/\s+/)) add(p);
  for (const m of cmd.matchAll(/(?:ss|lsof|netstat)\b[^\n;&]*\|\s*grep\s+(?:-\w+\s+)*['"]?:?(\d{3,5})\b/g)) add(m[1]);
  return out;
}

// ---- hard-coded starts: segment by segment ----

/** Programs that take a port to connect to, not to listen on */
const CLIENTS = new Set(['ssh', 'scp', 'sftp', 'psql', 'pg_dump', 'pg_isready', 'mysql', 'redis-cli', 'mongosh', 'curl', 'wget', 'nc', 'ncat', 'telnet', 'rsync', 'gh', 'ss', 'lsof', 'netstat', 'fuser', 'kill', 'grep', 'rg', 'echo', 'printf', 'git', 'tailscale']);
/** Words skipped to find the command word */
const WRAPPERS = new Set(['sudo', 'nohup', 'exec', 'setsid', 'command', 'time', 'nice', 'npx', 'bunx', 'pnpx', 'export', 'env']);
const DEV_SERVERS = /^(?:.*\/)?(?:vite|next|astro|serve)$/;
const ASSIGN = /^([A-Za-z_]\w*)=(.*)$/;
const SAFE_WORD = /^[A-Za-z][\w.+-]{0,24}$/;

function tokens(segment: string): string[] {
  return (segment.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? []).map((t) => t.replace(/^(['"])(.*)\1$/, '$2'));
}

/** "PORT= npm", "vite --port", "next -p": what kind of start it was, without its arguments */
function startPrefix(env: string | null, word: string | undefined, flag: string | null): string {
  const base = word?.replace(/^.*\//, '');
  const w = base && SAFE_WORD.test(base) ? base : '';
  return [env ? `${env}=` : '', w, flag ?? ''].filter(Boolean).join(' ') || '?';
}

function hardcodedIn(segment: string): { ports: number[]; prefix: string } | null {
  const t = tokens(segment);
  const ports: number[] = [];
  let i = 0;
  let env: string | null = null;
  // leading assignments and wrappers (env PORT=3001 nohup npm run dev)
  for (; i < t.length; i++) {
    const a = ASSIGN.exec(t[i]);
    if (a) {
      if ((a[1] === 'PORT' || a[1].endsWith('_PORT')) && /^\d{1,5}$/.test(a[2]) && validPort(Number(a[2]))) {
        ports.push(Number(a[2]));
        env = a[1] === 'PORT' ? 'PORT' : `*_PORT`;
      }
      continue;
    }
    if (WRAPPERS.has(t[i])) continue;
    if (t[i] === 'timeout' && i + 1 < t.length) {
      i++;
      continue;
    }
    break;
  }
  const word = t[i]?.replace(/^.*\//, '');
  if (word && CLIENTS.has(word)) return ports.length ? { ports, prefix: startPrefix(env, t[i], null) } : null;
  const devServer = t.slice(i).some((x) => DEV_SERVERS.test(x));
  let flag: string | null = null;
  for (let j = i; j < t.length; j++) {
    const x = t[j];
    let v: string | undefined;
    if (x === '--port' || (x === '-p' && devServer)) {
      v = t[j + 1];
      flag ??= x;
    } else if (x.startsWith('--port=')) {
      v = x.slice(7);
      flag ??= '--port';
    } else if (x === 'http.server' && t[j - 1] === '-m') {
      v = t[j + 1];
      flag ??= '-m http.server';
    }
    if (v !== undefined && /^\d{1,5}$/.test(v) && validPort(Number(v))) ports.push(Number(v));
  }
  if (!ports.length) return null;
  return { ports, prefix: startPrefix(flag ? null : env, t[i], flag) };
}

/** What a shell command does with ports. */
export function classifyCommand(command: string): CommandHits {
  const cmd = stripHeredocs(command);
  const prefixes: string[] = [];
  const kills = KILL.filter((k) => (k.re.lastIndex = 0, k.re.test(cmd)));
  const inspects = kills.length ? [] : INSPECT.filter((k) => (k.re.lastIndex = 0, k.re.test(cmd)));
  for (const k of kills) prefixes.push(k.label);
  for (const k of inspects) prefixes.push(inspectPrefix(cmd, k));
  const hardcoded: number[] = [];
  for (const seg of cmd.split(/\n|&&|\|\||;|\||\$\(|\)|\x60/)) {
    const h = hardcodedIn(seg);
    if (!h) continue;
    hardcoded.push(...h.ports);
    prefixes.push(h.prefix);
  }
  const raw = kills.length > 0 || inspects.length > 0;
  return {
    inspect: !kills.length && inspects.length > 0,
    kill: kills.length > 0,
    hardcoded: [...new Set(hardcoded)],
    ports: raw ? [...new Set(namedPorts(cmd))] : [],
    prefixes: [...new Set(prefixes)],
  };
}

/** "ss -ltnp", "lsof -iTCP" → flags only, at most 12 characters of them */
function inspectPrefix(cmd: string, k: { re: RegExp; label: string }): string {
  k.re.lastIndex = 0;
  const m = k.re.exec(cmd);
  const flag = m?.[0].match(/\s(-[a-zA-Z]{1,8})(?=[\s:]|$)/g)?.map((f) => f.trim())[0];
  return flag ? `${k.label} ${flag}` : k.label;
}

// ---------- records ----------

export interface Counts {
  tools: number;
  shell: number;
  mcp: number;
  inspect: number;
  kill: number;
  hardcoded: number;
  nudges: number;
  followed: number;
}

export interface PortUse {
  start: number;
  inspect: number;
  kill: number;
}

export interface SessionDay extends Counts {
  /** port → how often it was hard-coded / inspected / killed by port */
  ports: Record<string, PortUse>;
  /** Portboard MCP tool (short name) → calls */
  mcpTools: Record<string, number>;
  /** short command prefix → calls */
  prefixes: Record<string, number>;
  /** every MCP server (the <server> of mcp__<server>__tool) → calls, for the memory view; absent in older scans */
  mcpServers?: Record<string, number>;
}

/** One session (its transcript and its subagents'), without its id or anything it said. */
export interface SessionRecord {
  /** ~/.claude/projects directory name */
  dir: string;
  /** The project it belongs to (dir name with ~/projects/ and .claude/worktrees/… taken off) */
  project: string;
  subagents: number;
  days: Record<string, SessionDay>;
}

export const emptyCounts = (): Counts => ({ tools: 0, shell: 0, mcp: 0, inspect: 0, kill: 0, hardcoded: 0, nudges: 0, followed: 0 });
const emptyDay = (): SessionDay => ({ ...emptyCounts(), ports: {}, mcpTools: {}, prefixes: {}, mcpServers: {} });

/**
 * "-home-dev-projects-acme--claude-worktrees-acme-135-x" → "acme", "-home-dev-projects-worktrees-webapp-<hex>-…"
 * → "webapp", "-home-dev-projects" → "projects", anything under /tmp (scratchpads) → "tmp"; other folders keep
 * their dir name without the home prefix.
 */
export function projectOf(dir: string): string {
  if (dir === '-tmp' || dir.startsWith('-tmp-')) return 'tmp';
  let p = dir.replace(/--claude-worktrees-.*$/, '').replace(/-worktrees-(.+?)-[0-9a-f]{6,}(?:-.*)?$/, '-$1');
  const m = /^-home-[^-]+-projects(?:-(.*))?$/.exec(p);
  if (m) return m[1] || 'projects';
  p = p.replace(/^-home-[^-]+-?/, '');
  return p || '~';
}

/** Is this a Portboard MCP tool? mcp__portboard__x, mcp__plugin_portboard_portboard__x */
export function portboardTool(name: string): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m && m[1].toLowerCase().includes('portboard') ? m[2] : null;
}

const SHELL_TOOLS = new Set(['Bash', 'mcp__terminal__run_in_terminal']);

const textOf = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

/**
 * Was this record a Portboard nudge? (#41/#42 add hook context that starts with "[portboard]".) A hook attachment
 * (hook_additional_context, hook_system_message, hook_success, …) or a system record's hookAdditionalContext
 * containing the marker anywhere, or a hook's denial: an is_error tool_result whose text starts with it. The
 * tool_result rule is strict on purpose: a Bash call that runs the hook script by hand (testing it) prints the same
 * text, and reading this very file would match too. Returns a dedupe key, or null.
 */
export function isNudge(rec: any): string | null {
  if (rec?.type === 'attachment') {
    const a = rec.attachment;
    if (!a || typeof a.type !== 'string' || !a.type.startsWith('hook_')) return null;
    if (!textOf(a.content).includes(MARKER) && !textOf(a.stdout).includes(MARKER)) return null;
    return a.toolUseID ? `${a.toolUseID}:${a.hookEvent ?? ''}` : `u:${rec.uuid}`;
  }
  if (rec?.type === 'system' && rec.hookAdditionalContext !== undefined) {
    return textOf(rec.hookAdditionalContext).includes(MARKER) ? (rec.toolUseID ? `${rec.toolUseID}:system` : `u:${rec.uuid}`) : null;
  }
  if (rec?.type === 'user' && Array.isArray(rec.message?.content)) {
    for (const b of rec.message.content) {
      if (b?.type !== 'tool_result' || b.is_error !== true) continue;
      const c = b.content;
      const first = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x: any) => x?.type === 'text')?.text ?? '') : '';
      if (typeof first === 'string' && first.trimStart().startsWith(MARKER)) return `${b.tool_use_id}:result`;
    }
  }
  return null;
}

/** Dedupe sets shared by every file of one scan */
export interface Seen {
  tools: Set<string>;
  nudges: Set<string>;
}

export const newSeen = (): Seen => ({ tools: new Set(), nudges: new Set() });

/**
 * Reads one transcript's records into a session (in file order: "followed" needs it). Records outside [fromDay,
 * toDay] (KST days, inclusive) are ignored. Pure apart from mutating `session` and `seen`.
 */
export function createFileReader(session: SessionRecord, seen: Seen, fromDay: string, toDay: string) {
  let pendingNudge: SessionDay | null = null;
  const dayOf = (rec: any): SessionDay | null => {
    const t = Date.parse(rec?.timestamp ?? '');
    if (!Number.isFinite(t)) return null;
    const d = kstDate(t);
    if (d < fromDay || d > toDay) return null;
    return (session.days[d] ??= emptyDay());
  };
  const portAction = (viaMcp: boolean) => {
    if (pendingNudge && viaMcp) pendingNudge.followed++;
    pendingNudge = null;
  };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const portUse = (day: SessionDay, port: number, k: keyof PortUse) => {
    const p = (day.ports[port] ??= { start: 0, inspect: 0, kill: 0 });
    p[k]++;
  };

  return {
    /** A parsed record */
    record(rec: any): void {
      const nudge = isNudge(rec);
      if (nudge) {
        if (seen.nudges.has(nudge)) return;
        const day = dayOf(rec);
        if (!day) return;
        seen.nudges.add(nudge);
        day.nudges++;
        pendingNudge = day;
        return;
      }
      if (rec?.type !== 'assistant') return;
      const day = dayOf(rec);
      if (!day) return;
      const content = rec.message?.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (b?.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
        if (seen.tools.has(b.id)) continue;
        seen.tools.add(b.id);
        day.tools++;
        const server = /^mcp__(.+?)__/.exec(b.name)?.[1];
        if (server) bump((day.mcpServers ??= {}), server);
        const pb = portboardTool(b.name);
        if (pb) {
          day.mcp++;
          bump(day.mcpTools, pb);
          portAction(true);
          continue;
        }
        if (!SHELL_TOOLS.has(b.name) || typeof b.input?.command !== 'string') continue;
        day.shell++;
        const h = classifyCommand(b.input.command);
        if (h.inspect) day.inspect++;
        if (h.kill) day.kill++;
        if (h.hardcoded.length) day.hardcoded++;
        for (const p of h.hardcoded) portUse(day, p, 'start');
        for (const p of h.ports) portUse(day, p, h.kill ? 'kill' : 'inspect');
        for (const p of h.prefixes) bump(day.prefixes, p);
        if (h.inspect || h.kill || h.hardcoded.length) portAction(false);
      }
    },
    /** An assistant line that wasn't parsed (no tool_use, no marker): only its day counts, for "sessions". */
    presence(timestamp: string): void {
      dayOf({ timestamp });
    },
  };
}

const TS = /"timestamp":"([^"]+)"/;

/**
 * Feeds one line. Only lines that can matter are parsed (tool_use, the marker); other assistant lines only give
 * their timestamp. A torn or invalid line (a live transcript's last one) is skipped.
 */
export function feedLine(reader: ReturnType<typeof createFileReader>, line: string): void {
  if (line.includes('"tool_use"') || line.includes(MARKER)) {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    reader.record(rec);
    return;
  }
  if (line.includes('"type":"assistant"')) {
    const m = TS.exec(line);
    if (m) reader.presence(m[1]);
  }
}

const B_TOOL_USE = Buffer.from('"tool_use"');
const B_MARKER = Buffer.from(MARKER);
const B_ASSISTANT = Buffer.from('"type":"assistant"');
const B_TS = Buffer.from('"timestamp":"');

/**
 * feedLine on a line's bytes: only a line that can matter is decoded, so the big tool_result and file-snapshot lines
 * (most of a transcript's bytes) never become strings. Same decisions as feedLine.
 */
export function feedBytes(reader: ReturnType<typeof createFileReader>, line: Buffer): void {
  if (line.includes(B_TOOL_USE) || line.includes(B_MARKER)) return feedLine(reader, line.toString('utf8'));
  if (!line.includes(B_ASSISTANT)) return;
  const at = line.indexOf(B_TS);
  const end = at < 0 ? -1 : line.indexOf(0x22, at + B_TS.length);
  if (end > 0) reader.presence(line.toString('utf8', at + B_TS.length, end));
}

// ---------- aggregation ----------

export interface Totals extends Counts {
  sessions: number;
}

export interface Summary {
  /** KST days, inclusive */
  from: string;
  to: string;
  totals: Totals;
  byDay: (Totals & { day: string })[];
  byProject: (Totals & { project: string; dirs: string[] })[];
  topPorts: (PortUse & { port: number; total: number })[];
  topPrefixes: { prefix: string; count: number }[];
  mcpTools: Record<string, number>;
  /** MCP server → calls and sessions that called it; null when the scan predates this count */
  mcpServers: Record<string, { calls: number; sessions: number }> | null;
}

const COUNT_KEYS: (keyof Counts)[] = ['tools', 'shell', 'mcp', 'inspect', 'kill', 'hardcoded', 'nudges', 'followed'];
const emptyTotals = (): Totals => ({ sessions: 0, ...emptyCounts() });
const addCounts = (into: Counts, c: Counts) => {
  for (const k of COUNT_KEYS) into[k] += c[k];
};

/** Everything over [from, to] (KST days, inclusive). A session counts once per day and once per project/window. */
export function summarize(sessions: SessionRecord[], from: string, to: string, top = 10): Summary {
  const totals = emptyTotals();
  const byDay = new Map<string, Totals & { day: string }>();
  for (let d = to; d >= from; d = dayMinus(d, 1)) byDay.set(d, { day: d, ...emptyTotals() });
  const byProject = new Map<string, Totals & { project: string; dirs: string[] }>();
  const ports = new Map<number, PortUse>();
  const prefixes = new Map<string, number>();
  const mcpTools: Record<string, number> = {};
  const mcpServers: Record<string, { calls: number; sessions: number }> = {};
  let serversCounted = false;
  for (const s of sessions) {
    const days = Object.entries(s.days).filter(([d]) => d >= from && d <= to);
    if (!days.length) continue;
    totals.sessions++;
    const proj = byProject.get(s.project) ?? { project: s.project, dirs: [], ...emptyTotals() };
    byProject.set(s.project, proj);
    proj.sessions++;
    if (!proj.dirs.includes(s.dir)) proj.dirs.push(s.dir);
    const used = new Set<string>();
    for (const [d, c] of days) {
      const row = byDay.get(d)!;
      row.sessions++;
      addCounts(row, c);
      addCounts(proj, c);
      addCounts(totals, c);
      for (const [p, u] of Object.entries(c.ports)) {
        const cur = ports.get(Number(p)) ?? { start: 0, inspect: 0, kill: 0 };
        cur.start += u.start;
        cur.inspect += u.inspect;
        cur.kill += u.kill;
        ports.set(Number(p), cur);
      }
      for (const [k, n] of Object.entries(c.prefixes)) prefixes.set(k, (prefixes.get(k) ?? 0) + n);
      for (const [k, n] of Object.entries(c.mcpTools)) mcpTools[k] = (mcpTools[k] ?? 0) + n;
      if (c.mcpServers) serversCounted = true;
      for (const [k, n] of Object.entries(c.mcpServers ?? {})) {
        (mcpServers[k] ??= { calls: 0, sessions: 0 }).calls += n;
        used.add(k);
      }
    }
    for (const k of used) mcpServers[k].sessions++;
  }
  return {
    from,
    to,
    totals,
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byProject: [...byProject.values()].map((p) => ({ ...p, dirs: p.dirs.sort() })).sort((a, b) => b.sessions - a.sessions || a.project.localeCompare(b.project)),
    topPorts: [...ports.entries()]
      .map(([port, u]) => ({ port, ...u, total: u.start + u.inspect + u.kill }))
      .sort((a, b) => b.total - a.total || a.port - b.port)
      .slice(0, top),
    topPrefixes: [...prefixes.entries()].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix)).slice(0, top),
    mcpTools,
    mcpServers: serversCounted ? mcpServers : null,
  };
}

// ---------- the scan ----------

export interface Scan {
  version: 1;
  /** When it ran (ISO) */
  at: string;
  /** KST days covered, inclusive */
  from: string;
  to: string;
  tookMs: number;
  files: { read: number; skipped: number; bytes: number; subagents: number };
  sessions: SessionRecord[];
}

export const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');

interface FileRef {
  path: string;
  size: number;
}

async function listDir(p: string) {
  return readdir(p, { withFileTypes: true }).catch(() => []);
}

async function fresh(path: string, since: number): Promise<FileRef | null> {
  try {
    const s = await stat(path);
    return s.isFile() && s.mtimeMs >= since ? { path, size: s.size } : null;
  } catch {
    return null;
  }
}

/** readLines' first buffer; it grows to the longest line of the scan, up to MAX_LINE */
export const READ_CHUNK = 256 * 1024;
/** A longer line is skipped (readline would have held all of it as one string) */
export const MAX_LINE = 64 * 1024 * 1024;

/** One scan's read buffer, shared by its files (one file at a time) */
export interface LineBuffer {
  buf: Buffer;
}

export const newLineBuffer = (): LineBuffer => ({ buf: Buffer.allocUnsafe(READ_CHUNK) });

/**
 * Calls `onLine` with each line's bytes (no newline, no trailing CR), read through one reused buffer: the line is a
 * view into it, valid only during the call. A file that vanishes or can't be read mid-way: what was read counts.
 */
export async function readLines(path: string, onLine: (line: Buffer) => void, lb: LineBuffer = newLineBuffer(), maxLine = MAX_LINE): Promise<void> {
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return;
  const emit = (b: Buffer) => onLine(b.length && b[b.length - 1] === 0x0d ? b.subarray(0, -1) : b);
  let start = 0; // buf[start, end) is the line being read
  let end = 0;
  let skipping = false; // inside a line longer than maxLine: drop bytes up to its newline
  try {
    for (;;) {
      if (end === lb.buf.length) {
        if (start > 0) {
          lb.buf.copy(lb.buf, 0, start, end);
          end -= start;
          start = 0;
        } else if (lb.buf.length >= maxLine) {
          skipping = true;
          end = 0;
        } else {
          const grown = Buffer.allocUnsafe(Math.min(lb.buf.length * 2, maxLine));
          lb.buf.copy(grown, 0, 0, end);
          lb.buf = grown;
        }
      }
      const from = end;
      const { bytesRead } = await fh.read(lb.buf, end, lb.buf.length - end, null);
      if (!bytesRead) break;
      end += bytesRead;
      for (let nl = lb.buf.indexOf(0x0a, from); nl !== -1 && nl < end; nl = lb.buf.indexOf(0x0a, start)) {
        if (!skipping) emit(lb.buf.subarray(start, nl));
        skipping = false;
        start = nl + 1;
      }
      if (start === end) start = end = 0;
    }
    if (end > start && !skipping) emit(lb.buf.subarray(start, end));
  } catch {
    // what was read counts
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Scans the transcripts touched within `days` KST days ending on now's day (inclusive), streaming each file. Files
 * last modified before the window starts are skipped without opening.
 */
export async function scanTranscripts(opts: { root?: string; days: number; now?: number }): Promise<Scan> {
  const root = opts.root ?? DEFAULT_ROOT;
  const now = opts.now ?? Date.now();
  const began = Date.now();
  const to = kstDate(now);
  const from = dayMinus(to, opts.days - 1);
  const since = Date.parse(`${from}T00:00:00Z`) - KST;
  const seen = newSeen();
  const lines = newLineBuffer();
  const sessions: SessionRecord[] = [];
  const files = { read: 0, skipped: 0, bytes: 0, subagents: 0 };
  for (const d of (await listDir(root)).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const dirPath = join(root, d);
    const entries = await listDir(dirPath);
    const ids = new Set<string>();
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) ids.add(e.name.slice(0, -6));
      else if (e.isDirectory()) ids.add(e.name);
    }
    for (const id of [...ids].sort()) {
      const main = entries.some((e) => e.isFile() && e.name === `${id}.jsonl`) ? await fresh(join(dirPath, `${id}.jsonl`), since) : null;
      const subs: FileRef[] = [];
      for (const e of await listDir(join(dirPath, id, 'subagents'))) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const f = await fresh(join(dirPath, id, 'subagents', e.name), since);
        if (f) subs.push(f);
        else files.skipped++;
      }
      if (!main && entries.some((e) => e.isFile() && e.name === `${id}.jsonl`)) files.skipped++;
      if (!main && !subs.length) continue;
      const session: SessionRecord = { dir: d, project: projectOf(d), subagents: 0, days: {} };
      for (const f of [...(main ? [main] : []), ...subs.sort((a, b) => basename(a.path).localeCompare(basename(b.path)))]) {
        const reader = createFileReader(session, seen, from, to);
        await readLines(f.path, (line) => feedBytes(reader, line), lines);
        files.read++;
        files.bytes += f.size;
        if (f !== main) {
          files.subagents++;
          session.subagents++;
        }
      }
      if (Object.keys(session.days).length) sessions.push(session);
    }
  }
  return { version: 1, at: new Date(now).toISOString(), from, to, tookMs: Date.now() - began, files, sessions };
}

// ---------- what the API, MCP and the digest show ----------

export interface AdoptionView {
  at: string | null;
  scanning: boolean;
  tookMs: number | null;
  days: number;
  /** The last `days` days (ending today, KST) */
  current: Summary | null;
  /** The `days` before those, when the scan reaches back that far */
  previous: Summary | null;
  files: Scan['files'] | null;
}

/**
 * The `days` days ending on `toDay` (default: the scan's last day), and the `days` before them; each null when the
 * scan doesn't reach back that far.
 */
export function viewOf(scan: Scan | null, days: number, scanning = false, toDay?: string): AdoptionView {
  if (!scan) return { at: null, scanning, tookMs: null, days, current: null, previous: null, files: null };
  const to = toDay ?? scan.to;
  const from = dayMinus(to, days - 1);
  const pTo = dayMinus(from, 1);
  const pFrom = dayMinus(pTo, days - 1);
  return {
    at: scan.at,
    scanning,
    tookMs: scan.tookMs,
    days,
    current: from >= scan.from ? summarize(scan.sessions, from, to) : null,
    previous: pFrom >= scan.from ? summarize(scan.sessions, pFrom, pTo) : null,
    files: scan.files,
  };
}

/** "MCP 14(+6) · ss/lsof 110(−20) · 고정 포트 320" style delta */
const delta = (cur: number, prev: number | undefined) => (prev === undefined || prev === cur ? '' : `(${cur > prev ? '+' : '−'}${Math.abs(cur - prev)})`);

/** The digest line (info, not a problem): Claude sessions' port habits over the period, vs the one before. */
export function adoptionLine(cur: Totals, prev: Totals | null): string {
  const raw = cur.inspect + cur.kill;
  const p = prev ?? undefined;
  return (
    t('adoptionMsg.line', {
      n: cur.sessions,
      mcp: `${cur.mcp}${delta(cur.mcp, p?.mcp)}`,
      raw: `${raw}${delta(raw, p ? p.inspect + p.kill : undefined)}`,
      hardcoded: `${cur.hardcoded}${delta(cur.hardcoded, p?.hardcoded)}`,
    }) + (cur.nudges ? ` · ${t('adoptionMsg.nudges', { n: cur.nudges })}` : '')
  );
}

export function parseScan(text: string): Scan | null {
  try {
    const s = JSON.parse(text);
    return s?.version === 1 && Array.isArray(s.sessions) && typeof s.from === 'string' && typeof s.to === 'string' ? (s as Scan) : null;
  } catch {
    return null;
  }
}
