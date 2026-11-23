// The adapters of the coding-agent CLIs that start_coding_agent runs (codex, gemini): their argv, and how one line of
// their JSON stdout folds into a run's summary. Pure functions with node:* imports only, because the runner
// (coding-agent-runner.ts, the job's main process) imports this file and must stay small. Run store, launch and the
// state rules are in coding-agents.ts, which re-exports everything here.
//
// "Coding agent" means an external CLI; "run" is one launch of it. The host agent of src/agent.ts is a different thing.
//
// The prompt is never in argv: it comes on stdin. The sandbox is only ever one of the two modes below. No adapter ever
// passes a flag that turns the CLI's own sandbox or approvals off.

import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type CodingAgentKind = 'codex' | 'gemini';
export type Sandbox = 'read-only' | 'workspace-write';
export const KINDS: readonly CodingAgentKind[] = ['codex', 'gemini'];
export const SANDBOXES: readonly Sandbox[] = ['read-only', 'workspace-write'];

export type RunState = 'running' | 'succeeded' | 'failed' | 'stopped' | 'timed-out' | 'lost';

export interface RunSummary {
  state: RunState;
  exitCode: number | null;
  /** JSON lines parsed */
  events: number;
  unknownEvents: number;
  turns: { completed: number; failed: number };
  /** command_execution / tool_use items completed */
  commands: number;
  /** unique paths from file_change, at most MAX_FILES */
  filesChanged: string[];
  filesChangedTruncated: boolean;
  /** the last error / turn.failed message, cut to 500 characters */
  lastError: string | null;
  usage: Record<string, number> | null;
  /** the last agent_message text (codex) / the final text (gemini) */
  finalText: string | null;
}

export interface Adapter {
  kind: CodingAgentKind;
  /** command name looked up on PATH */
  bin: string;
  /** argv after the binary. The prompt is NEVER in argv: it comes on stdin. */
  args(o: { cwd: string; sandbox: Sandbox; model?: string; lastMessageFile: string }): string[];
  /** Fold one stdout line into the summary; ignore lines that are not JSON or of unknown type. */
  parse(line: string, s: RunSummary): void;
}

export const MAX_FILES = 50;
const MAX_ERROR = 500;

export function emptySummary(): RunSummary {
  return {
    state: 'running',
    exitCode: null,
    events: 0,
    unknownEvents: 0,
    turns: { completed: 0, failed: 0 },
    commands: 0,
    filesChanged: [],
    filesChangedTruncated: false,
    lastError: null,
    usage: null,
    finalText: null,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** One stdout line as an event object (it needs a string `type`), else null: stderr noise and half lines are skipped. */
function eventOf(line: string): Obj | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(trimmed);
    return isObj(v) && typeof v.type === 'string' ? v : null;
  } catch {
    return null;
  }
}

function setError(s: RunSummary, msg: unknown): void {
  const m = str(msg);
  if (m !== null) s.lastError = m.slice(0, MAX_ERROR);
}

function addUsage(s: RunSummary, usage: unknown, flatten: boolean): void {
  if (!isObj(usage)) return;
  const out: Record<string, number> = s.usage ?? {};
  const walk = (o: Obj, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (Object.keys(out).length >= 50) return;
      const key = prefix + k;
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = (out[key] ?? 0) + v;
      else if (flatten && depth < 2 && isObj(v)) walk(v, `${key}.`, depth + 1);
    }
  };
  walk(usage, '', 0);
  s.usage = Object.keys(out).length ? out : s.usage;
}

function addFile(s: RunSummary, path: string): void {
  if (s.filesChanged.includes(path)) return;
  if (s.filesChanged.length >= MAX_FILES) s.filesChangedTruncated = true;
  else s.filesChanged.push(path);
}

/** Collapse whitespace so one event is one line, then cut. */
const oneLine = (v: unknown, max: number): string => (str(v) ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---- codex (flags checked against `codex exec --help`, codex-cli 0.159.3) ----

const CODEX_ITEM_EVENTS = new Set(['item.started', 'item.updated', 'item.completed']);
const CODEX_ITEM_TYPES = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'error']);
const CODEX_QUIET = new Set(['thread.started', 'turn.started']);

function codexParse(line: string, s: RunSummary): void {
  const e = eventOf(line);
  if (!e) return;
  s.events++;
  const type = e.type as string;
  if (CODEX_QUIET.has(type)) return;
  if (type === 'turn.completed') {
    s.turns.completed++;
    addUsage(s, e.usage, false);
    return;
  }
  if (type === 'turn.failed') {
    s.turns.failed++;
    setError(s, isObj(e.error) ? e.error.message : undefined);
    return;
  }
  if (type === 'error') {
    setError(s, e.message);
    return;
  }
  if (CODEX_ITEM_EVENTS.has(type) && isObj(e.item) && CODEX_ITEM_TYPES.has(e.item.type as string)) {
    if (type !== 'item.completed') return;
    const item = e.item;
    switch (item.type) {
      case 'agent_message':
        if (str(item.text) !== null) s.finalText = item.text as string;
        break;
      case 'command_execution':
        s.commands++;
        break;
      case 'file_change':
        if (Array.isArray(item.changes)) for (const c of item.changes) if (isObj(c) && typeof c.path === 'string') addFile(s, c.path);
        break;
      case 'error':
        setError(s, item.message);
        break;
    }
    return;
  }
  s.unknownEvents++;
}

function codexLines(line: string): string[] {
  const e = eventOf(line);
  if (!e) return [];
  const type = e.type as string;
  if (type === 'turn.failed') return [`error: ${oneLine(isObj(e.error) ? e.error.message : '', 300)}`];
  if (type === 'error') return [`error: ${oneLine(e.message, 300)}`];
  if (type !== 'item.completed' || !isObj(e.item)) return [];
  const item = e.item;
  switch (item.type) {
    case 'agent_message':
      return [`msg: ${oneLine(item.text, 300)}`];
    case 'command_execution':
      return [`cmd: ${oneLine(item.command, 200)} (exit ${typeof item.exit_code === 'number' ? item.exit_code : '?'})`];
    case 'file_change':
      return Array.isArray(item.changes) ? item.changes.filter((c): c is Obj => isObj(c) && typeof c.path === 'string').map((c) => `file: ${oneLine(c.kind, 20) || '?'} ${oneLine(c.path, 300)}`) : [];
    case 'error':
      return [`error: ${oneLine(item.message, 300)}`];
    default:
      return [];
  }
}

export const codexAdapter: Adapter = {
  kind: 'codex',
  bin: 'codex',
  args: (o) => ['exec', '--json', '--color', 'never', '-s', o.sandbox, '-C', o.cwd, '-o', o.lastMessageFile, ...(o.model ? [`--model=${o.model}`] : []), '-'],
  parse: codexParse,
};

// ---- gemini (official docs docs/cli/headless.md, cli-reference.md; field names are not documented: parsed defensively) ----

const GEMINI_QUIET = new Set(['init', 'tool_result']);

function geminiParse(line: string, s: RunSummary): void {
  const e = eventOf(line);
  if (!e) return;
  s.events++;
  const type = e.type as string;
  if (GEMINI_QUIET.has(type)) return;
  if (type === 'message') {
    if (e.role === 'assistant' && typeof e.content === 'string') s.finalText = e.delta === true ? (s.finalText ?? '') + e.content : e.content;
    return;
  }
  if (type === 'tool_use') {
    s.commands++;
    return;
  }
  if (type === 'error') {
    setError(s, e.message);
    return;
  }
  if (type === 'result') {
    const final = str(e.response) ?? str(e.result);
    if (final !== null) s.finalText = final;
    addUsage(s, e.stats, true);
    if (e.status === 'error') {
      s.turns.failed++;
      setError(s, isObj(e.error) ? e.error.message : e.message);
    } else s.turns.completed++;
    return;
  }
  s.unknownEvents++;
}

function geminiLines(line: string): string[] {
  const e = eventOf(line);
  if (!e) return [];
  switch (e.type) {
    case 'message':
      // a delta is a fragment of the final text: that text is in `final`
      return e.role === 'assistant' && e.delta !== true && typeof e.content === 'string' ? [`msg: ${oneLine(e.content, 300)}`] : [];
    case 'tool_use':
      return [`tool: ${oneLine(e.tool_name ?? e.name, 100) || '?'}`];
    case 'error':
      return [`error: ${oneLine(e.message, 300)}`];
    default:
      return [];
  }
}

export const geminiAdapter: Adapter = {
  kind: 'gemini',
  bin: 'gemini',
  // no cwd flag: the process cwd is the worktree. Non-TTY stdin runs it headless.
  args: (o) => ['--output-format', 'stream-json', '--approval-mode', 'default', ...(o.model ? [`--model=${o.model}`] : [])],
  parse: geminiParse,
};

export const ADAPTERS: Record<CodingAgentKind, Adapter> = { codex: codexAdapter, gemini: geminiAdapter };
const LINES: Record<CodingAgentKind, (line: string) => string[]> = { codex: codexLines, gemini: geminiLines };

export function adapterFor(kind: string): Adapter | null {
  return (KINDS as readonly string[]).includes(kind) ? ADAPTERS[kind as CodingAgentKind] : null;
}

/** The compact text lines one stdout line adds to coding_agent_output ("cmd: …", "msg: …", "file: …", "error: …", "tool: …"). */
export function eventLines(kind: CodingAgentKind, line: string): string[] {
  return LINES[kind](line);
}

/** A line is an event when it parses as one: coding_agent_output numbers events, not raw lines. */
export function isEventLine(line: string): boolean {
  return eventOf(line) !== null;
}

/** `adapter.bin` on PATH: absolute entries only (a relative one would resolve against the worktree), a file with the x bit. */
export function resolveBin(bin: string, pathEnv: string | undefined = process.env.PATH): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(bin)) return null;
  for (const dir of (pathEnv ?? '').split(':')) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, bin);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}
