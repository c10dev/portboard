// Hand a task to another coding agent CLI (codex, gemini) running on THIS host: start it in a known worktree with a
// prompt, list the runs, read their progress and final answer, stop one (MCP tools in src/features/coding-agents.ts).
//
// A "run" is one launch. Its state is a folder, `<state dir>/coding-agents/<id>/` (0700, files 0600, written through
// writePrivate / appendPrivate):
//
//   meta.json     RunMeta, written at start; rewritten whole when a stop is requested
//   prompt.txt    the prompt. Never logged, never returned by a tool (results carry promptChars only)
//   events.jsonl  the CLI's stdout, verbatim            (written by the runner)
//   stderr.log    the CLI's stderr                      (written by the runner)
//   last.md       codex -o output / gemini final text   (written by the CLI / the runner)
//   exit.json     { code, signal, endedAt, timedOut?, stopped?, launchFailed? }, written by the runner when the CLI is gone
//
// The CLI runs under coding-agent-runner.ts: a transient systemd user unit (`pb-agent-<id>`) where there is systemd,
// else a detached process. The runner enforces the timeout in both. The adapters (argv, event parsing) are in
// coding-agent-adapters.ts, which the runner imports too; they are re-exported here.

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir, hostname } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendPrivate, writePrivate } from './atomic.ts'; // appendPrivate: the launch note in stderr.log
import { readOnlyRefusal } from './control.ts';
import { claudeEnvArgs } from './devservers.ts';
import { run } from './exec.ts';
import { resolvePaths } from './paths.ts';
import { platform } from './platform/index.ts';
import { services } from './platform/services.ts';
import { t } from './i18n.ts';
import { discoverRepos } from './worktrees.ts';
import { knownDirs } from '../features/devservers.ts';
import {
  adapterFor,
  eventLines,
  emptySummary,
  isEventLine,
  KINDS,
  resolveBin,
  SANDBOXES,
  type CodingAgentKind,
  type RunState,
  type RunSummary,
  type Sandbox,
} from './coding-agent-adapters.ts';

export * from './coding-agent-adapters.ts';

export interface RunMeta {
  id: string;
  kind: CodingAgentKind;
  /** the worktree path (a knownDirs() key) */
  cwd: string;
  /** `<repo>@<branch>` from knownDirs() */
  owner: string;
  sandbox: Sandbox;
  model: string | null;
  promptChars: number;
  startedAt: string;
  timeoutMinutes: number;
  launcher: 'systemd' | 'process';
  /** `pb-agent-<id>.service` under systemd */
  unit: string | null;
  /** the runner's pid in process mode */
  pid: number | null;
  /** the runner's start time as the OS reports it (processStart), so a reused pid is not mistaken for it */
  pidStart?: string | null;
  stopRequestedAt: string | null;
  /** CLAUDE_CODE_SESSION_ID when valid (same rule as claudeEnvArgs) */
  session: string | null;
}

export interface RunExit {
  code: number | null;
  signal: string | null;
  endedAt: string;
  timedOut?: true;
  /** the runner got SIGTERM/SIGINT (a stop), not a timeout */
  stopped?: true;
  launchFailed?: true;
}

export const ID_RE = /^ca-[0-9a-f]{10}$/;
export const UNIT_PREFIX = 'pb-agent-';
export const MAX_PROMPT = 100_000;
export const DEFAULT_TIMEOUT_MINUTES = 30;
// must not start with '-': the value would be read as a flag
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
/** A run younger than this with no exit.json and not yet seen alive is still starting, not lost. */
const START_GRACE_MS = 30_000;
const LOCK_STALE_MS = 60_000;
const FINAL_MAX = 20_000;
const STDERR_TAIL = 2_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Where the runs live: `dir` (tests) or `<state dir>/coding-agents`. Every run is a folder below it. */
export const runsDir = (opts?: { dir?: string }): string => opts?.dir ?? join(resolvePaths().stateDir, 'coding-agents');
const runDirOf = (id: string, opts?: { dir?: string }): string => join(runsDir(opts), id);
const unitOf = (id: string): string => `${UNIT_PREFIX}${id}.service`;
export const newId = (): string => `ca-${randomBytes(5).toString('hex')}`;

type Result = { ok: boolean; status: number; message: string };

// ---- reading a run ----

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** meta.json of a run; null for an id that is not ours, a missing run or an unreadable file. The id is checked before it becomes a path. */
export async function readMeta(id: string, opts?: { dir?: string }): Promise<RunMeta | null> {
  if (!ID_RE.test(id)) return null;
  const m = await readJson<RunMeta>(join(runDirOf(id, opts), 'meta.json'));
  return m && m.id === id ? m : null;
}

const readExit = (id: string, opts?: { dir?: string }) => readJson<RunExit>(join(runDirOf(id, opts), 'exit.json'));

/**
 * The last `max` BYTES of a file as text (the whole file when it is smaller), and whether it was cut. A cut that lands
 * inside a UTF-8 character drops that broken leading character. null when the file can't be read.
 */
async function readTail(path: string, max: number): Promise<{ text: string; cut: boolean } | null> {
  let fh;
  try {
    fh = await open(path, 'r');
    const size = (await fh.stat()).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    if (len) await fh.read(buf, 0, len, size - len);
    const cut = size > max;
    let from = 0;
    if (cut) while (from < len && from < 4 && (buf[from] & 0xc0) === 0x80) from++; // continuation bytes of a split character
    return { text: buf.subarray(from).toString('utf8'), cut };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** The whole events file as a stream: numbers the events, folds every one into the summary, keeps only the page asked for. */
async function scanEvents(
  kind: CodingAgentKind,
  path: string,
  page?: { after: number; limit: number },
): Promise<{ summary: RunSummary; lines: { i: number; text: string }[]; next: number; truncated: boolean }> {
  const adapter = adapterFor(kind)!;
  const summary = emptySummary();
  const lines: { i: number; text: string }[] = [];
  let index = 0;
  let next = 0;
  let truncated = false;
  let paging = page !== undefined;
  try {
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!isEventLine(line)) continue;
      adapter.parse(line, summary);
      const i = index++;
      if (!paging) continue;
      next = index;
      if (i < page!.after) continue;
      const add = eventLines(kind, line);
      if (lines.length && lines.length + add.length > page!.limit) {
        // the page ends before this event; the rest of the file still goes into the summary
        truncated = true;
        next = i;
        paging = false;
        continue;
      }
      for (const text of add) lines.push({ i, text });
    }
  } catch {
    // no events file yet
  }
  if (page && !truncated) next = index;
  return { summary, lines, next, truncated };
}

/** The start time of a process as the OS reports it (Linux: field 22 of /proc/<pid>/stat; elsewhere ps), or null when it can't be read. */
export async function processStart(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // "pid (comm) state ...": comm may hold spaces and parentheses, so count from the last ")"; field 3 is rest[0]
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return rest[19] || null;
    } catch {
      return null;
    }
  }
  const r = await run('ps', ['-o', 'lstart=', '-p', String(pid)], 5_000);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Whether pid is the runner this run started: same pid and the same start time. Never true for an unreadable or different process. */
async function runnerAlive(meta: RunMeta): Promise<boolean> {
  if (meta.pid === null || !meta.pidStart) return false;
  return (await processStart(meta.pid)) === meta.pidStart;
}

/** Whether the run's unit is active: true/false, or null when systemctl could not say (unknown stays unknown). */
async function unitActive(unit: string): Promise<boolean | null> {
  const r = await services().show([unit], 'ActiveState', 5_000);
  if (!r.ok) return null;
  const state = /^ActiveState=(.*)$/m.exec(r.stdout)?.[1]?.trim();
  if (!state) return null;
  return state === 'active' || state === 'activating' || state === 'reloading' || state === 'deactivating';
}

/**
 * With exit.json: failed for a launch failure; stopped when a stop was requested before the runner ended and the run
 * ended because of it (signal, a non-zero code, or the runner's own `stopped` mark); timed-out; else succeeded (code 0)
 * or failed. Without it: running while the unit is active / the runner is alive (same pid and start time), else lost
 * (the runner died without writing exit.json), except that a run under 30 s old that was not seen alive yet is still
 * starting and counts as running. `active` null (systemctl failed) keeps running: the caller marks it stateUnknown.
 */
export function runState(meta: RunMeta, exit: RunExit | null, active: boolean | null, now: number = Date.now()): RunState {
  if (exit) {
    if (exit.launchFailed) return 'failed';
    if (meta.stopRequestedAt && exit.endedAt >= meta.stopRequestedAt && (exit.stopped === true || exit.signal !== null || exit.code !== 0)) return 'stopped';
    if (exit.timedOut) return 'timed-out';
    return exit.code === 0 ? 'succeeded' : 'failed';
  }
  if (active === true || (active === null && meta.launcher === 'systemd')) return 'running';
  const starting = now - Date.parse(meta.startedAt) < START_GRACE_MS && (meta.launcher === 'systemd' || meta.pid === null);
  return starting ? 'running' : 'lost';
}

async function stateOf(meta: RunMeta, opts?: { dir?: string }): Promise<{ state: RunState; exit: RunExit | null; stateUnknown: boolean }> {
  const exit = await readExit(meta.id, opts);
  let active: boolean | null = false;
  if (!exit) active = meta.launcher === 'systemd' ? (meta.unit ? await unitActive(meta.unit) : false) : await runnerAlive(meta);
  return { state: runState(meta, exit, active), exit, stateUnknown: !exit && meta.launcher === 'systemd' && active === null };
}

export type ListedRun = RunMeta & Omit<RunSummary, 'finalText'> & { stateUnknown?: true };

/** Runs, newest first, each with its state and summary (no prompt, no final text: those are one coding_agent_output away). */
export async function listCodingAgents(opts?: { dir?: string; id?: string }): Promise<{ runs: ListedRun[] }> {
  const ids = opts?.id !== undefined ? [opts.id] : (await readdir(runsDir(opts)).catch(() => [] as string[])).filter((n) => ID_RE.test(n));
  const runs = await Promise.all(
    ids.map(async (id) => {
      const meta = await readMeta(id, opts);
      if (!meta) return null;
      const { state, exit, stateUnknown } = await stateOf(meta, opts);
      const scanned = (await scanEvents(meta.kind, join(runDirOf(id, opts), 'events.jsonl'))).summary;
      const { finalText: _final, ...summary } = { ...scanned, state, exitCode: exit?.code ?? null };
      return { ...meta, ...summary, ...(stateUnknown ? { stateUnknown: true as const } : {}) };
    }),
  );
  return { runs: runs.filter((r): r is ListedRun => r !== null).sort((a, b) => b.startedAt.localeCompare(a.startedAt)) };
}

// ---- output ----

export interface OutputResult {
  ok: boolean;
  status: number;
  message?: string;
  id: string;
  state: RunState;
  summary: RunSummary;
  /** compact lines for events with index >= after: "cmd: <command> (exit 0)", "msg: <first 300 chars>", "file: <kind> <path>", "error: <msg>", "tool: <name>" */
  lines: { i: number; text: string }[];
  /** pass as `after` next time */
  next: number;
  /** more lines than limit: call again with `after` = next */
  truncated: boolean;
  /** last.md content: at most its last 20 000 bytes */
  final: string | null;
  finalTruncated: boolean;
  /** the last 2 000 bytes of stderr.log, only when the state is failed or lost */
  stderrTail: string | null;
}

function failedOutput(id: string, status: number, message: string): OutputResult {
  return { ok: false, status, message, id, state: 'lost', summary: { ...emptySummary(), state: 'lost' }, lines: [], next: 0, truncated: false, final: null, finalTruncated: false, stderrTail: null };
}

const clampInt = (v: number | undefined, min: number, max: number, fallback: number): number =>
  v === undefined || !Number.isFinite(v) ? fallback : Math.min(max, Math.max(min, Math.trunc(v)));

/**
 * The progress and final answer of a run. Events are numbered in the order their JSON lines appear in events.jsonl;
 * `after` is the first event to return and `next` the cursor for the following call. A page ends between two events.
 */
export async function codingAgentOutput(id: string, o?: { after?: number; limit?: number; dir?: string }): Promise<OutputResult> {
  if (!ID_RE.test(id)) return failedOutput(String(id).slice(0, 40), 400, t('codingAgents.badArgs', { message: 'id' }));
  const meta = await readMeta(id, o);
  if (!meta) return failedOutput(id, 404, t('codingAgents.notFound'));
  const after = clampInt(o?.after, 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = clampInt(o?.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const { state, exit } = await stateOf(meta, o);
  const dir = runDirOf(id, o);
  const scan = await scanEvents(meta.kind, join(dir, 'events.jsonl'), { after, limit });
  const summary = { ...scan.summary, state, exitCode: exit?.code ?? null };
  const { lines, next, truncated } = scan;

  const last = await readTail(join(dir, 'last.md'), FINAL_MAX);
  const final = last ? last.text : null;
  const stderr = state === 'failed' || state === 'lost' ? await readTail(join(dir, 'stderr.log'), STDERR_TAIL) : null;
  return { ok: true, status: 200, id, state, summary, lines, next, truncated, final, finalTruncated: last?.cut ?? false, stderrTail: stderr ? stderr.text : null };
}

// ---- start ----

export interface StartRequest {
  kind: CodingAgentKind;
  path: string;
  prompt: string;
  sandbox?: Sandbox;
  model?: string;
  timeoutMinutes?: number;
}

export type StartResult = Result & { id?: string; unit?: string | null; pid?: number | null; host?: string };

const RUNNER = fileURLToPath(new URL('./coding-agent-runner' + extname(fileURLToPath(import.meta.url)), import.meta.url));

const bad = (message: string): StartResult => ({ ok: false, status: 400, message: t('codingAgents.badArgs', { message }) });

/** Whether a worktree path is a repo's main checkout (the folder discoverRepos finds), not a linked worktree. */
async function isMainCheckout(path: string): Promise<boolean> {
  const real = await realpath(path).catch(() => path);
  for (const repo of await discoverRepos()) if (repo === path || (await realpath(repo).catch(() => repo)) === real) return true;
  return false;
}

/** A systemd specifier starts with %: a path or a branch name holding one must reach the unit as %%. */
const specifierSafe = (v: string): string => v.replace(/%/g, '%%');

/** Why runs can't be started or stopped here: a read-only install, or a container (403); null when they can. */
function writeRefusal(): Result | null {
  const refused = readOnlyRefusal();
  if (refused) return { ok: false, status: 403, message: refused.message };
  if (platform().container) return { ok: false, status: 403, message: t('errors.readOnly', { reason: 'container (PORTBOARD_CONTAINER=1)' }) };
  return null;
}

/**
 * One start at a time per worktree: `<runs>/locks/<first 16 hex of sha256(path)>.lock`, created with the exclusive flag
 * (the same pattern writePrivate uses for its temp file; the file is empty and holds no state). A lock older than 60 s
 * is a crashed start's and is removed. Returns the release function, or null when another start holds the lock.
 */
async function acquireLock(path: string, opts?: { dir?: string }): Promise<(() => Promise<void>) | null> {
  const dir = join(runsDir(opts), 'locks');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${createHash('sha256').update(path).digest('hex').slice(0, 16)}.lock`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fh = await open(file, 'wx', 0o600);
      await fh.close();
      return () => unlink(file).catch(() => {});
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const st = await stat(file).catch(() => null);
      if (st && Date.now() - st.mtimeMs <= LOCK_STALE_MS) return null;
      if (st) await unlink(file).catch(() => {});
    }
  }
  return null;
}

export async function startCodingAgent(req: StartRequest, env?: Record<string, string | undefined>, opts?: { dir?: string }): Promise<StartResult> {
  const refused = writeRefusal();
  if (refused) return refused;

  const r = (req ?? {}) as Partial<StartRequest> & Record<string, unknown>;
  if (typeof r.kind !== 'string' || !(KINDS as readonly string[]).includes(r.kind)) return bad(`kind must be ${KINDS.join(' or ')}`);
  const kind = r.kind as CodingAgentKind;
  if (typeof r.prompt !== 'string' || !r.prompt.trim() || r.prompt.length > MAX_PROMPT) return bad(`prompt must be a text of 1 to ${MAX_PROMPT} characters`);
  const sandbox = r.sandbox ?? 'read-only';
  if (!(SANDBOXES as readonly unknown[]).includes(sandbox)) return bad(`sandbox must be ${SANDBOXES.join(' or ')}`);
  if (r.model !== undefined && (typeof r.model !== 'string' || !MODEL_RE.test(r.model))) return bad('model must be 1 to 64 letters, digits or . _ : - and start with a letter or digit');
  const timeoutMinutes = r.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  if (typeof timeoutMinutes !== 'number' || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 240) return bad('timeout_minutes must be an integer between 1 and 240');
  if (typeof r.path !== 'string') return bad('path must be a worktree path');

  const dir = (await knownDirs()).get(r.path);
  if (!dir) return { ok: false, status: 400, message: t('codingAgents.unknownDir') };
  if (sandbox === 'workspace-write' && (await isMainCheckout(r.path))) return { ok: false, status: 400, message: t('codingAgents.mainCheckout') };

  const adapter = adapterFor(kind)!;
  const binAbs = resolveBin(adapter.bin);
  if (!binAbs) return { ok: false, status: 400, message: t('codingAgents.noBinary', { kind }) };

  const release = await acquireLock(r.path, opts);
  if (!release) {
    const going = (await listCodingAgents(opts)).runs.find((x) => x.cwd === r.path && x.state === 'running');
    return { ok: false, status: 409, message: t('codingAgents.busy', { id: going?.id ?? 'starting' }) };
  }
  try {
    const busy = (await listCodingAgents(opts)).runs.find((x) => x.cwd === r.path && x.state === 'running');
    if (busy) return { ok: false, status: 409, message: t('codingAgents.busy', { id: busy.id }) };
    return await launch({ kind, path: r.path, prompt: r.prompt, sandbox, model: r.model, timeoutMinutes }, dir.owner, binAbs, env, opts);
  } finally {
    await release();
  }
}

/** Steps 6 and 7 of a start: write the run folder, then start the runner. Runs under the worktree's lock. */
async function launch(req: Required<Pick<StartRequest, 'kind' | 'path' | 'prompt' | 'sandbox' | 'timeoutMinutes'>> & { model?: string }, owner: string, binAbs: string, env: Record<string, string | undefined> | undefined, opts?: { dir?: string }): Promise<StartResult> {
  const { kind, sandbox, timeoutMinutes } = req;
  const id = newId();
  const runDir = runDirOf(id, opts);
  const sessionId = env?.CLAUDE_CODE_SESSION_ID && SESSION_RE.test(env.CLAUDE_CODE_SESSION_ID) ? env.CLAUDE_CODE_SESSION_ID : null;
  const systemd = services().unavailable === null;
  const meta: RunMeta = {
    id,
    kind,
    cwd: req.path,
    owner,
    sandbox,
    model: req.model ?? null,
    promptChars: req.prompt.length,
    startedAt: new Date().toISOString(),
    timeoutMinutes,
    launcher: systemd ? 'systemd' : 'process',
    unit: systemd ? unitOf(id) : null,
    pid: null,
    pidStart: null,
    stopRequestedAt: null,
    session: sessionId,
  };
  const writeMeta = () => writePrivate(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  await writeMeta();
  await writePrivate(join(runDir, 'prompt.txt'), req.prompt);

  const failLaunch = async (message: string): Promise<StartResult> => {
    const exit: RunExit = { code: null, signal: null, endedAt: new Date().toISOString(), launchFailed: true };
    await writePrivate(join(runDir, 'exit.json'), JSON.stringify(exit) + '\n').catch(() => {});
    await appendPrivate(join(runDir, 'stderr.log'), `[launch] ${message}\n`).catch(() => {});
    return { ok: false, status: 500, message: t('codingAgents.launchFailed', { message }), id };
  };

  const path = `${dirname(binAbs)}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
  if (systemd) {
    const started = await services().startTransient([
      '--user',
      `--unit=${UNIT_PREFIX}${id}`,
      '--collect',
      `--description=${specifierSafe(`Portboard coding agent: ${kind} ${owner}`)}`,
      `--property=WorkingDirectory=${specifierSafe(req.path)}`,
      // backstop: the runner's own timer fires first
      `--property=RuntimeMaxSec=${timeoutMinutes * 60 + 60}`,
      `--setenv=HOME=${homedir()}`,
      `--setenv=PATH=${path}`,
      ...claudeEnvArgs(env ?? {}),
      '--',
      process.execPath,
      RUNNER,
      runDir,
    ]);
    if (!started.ok) return failLaunch((started.stderr || started.stdout).trim().slice(0, 300));
  } else {
    const child = spawn(process.execPath, [RUNNER, runDir], {
      cwd: req.path,
      detached: true,
      stdio: 'ignore',
      env: { HOME: homedir(), PATH: path, ...(sessionId ? { CLAUDE_CODE_SESSION_ID: sessionId } : {}) },
    });
    const spawnError = await new Promise<Error | null>((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', (e) => resolve(e));
    });
    if (spawnError) return failLaunch(spawnError.message.slice(0, 300));
    child.unref();
    meta.pid = child.pid ?? null;
    // the runner's identity, so a later stop never signals another process that got this pid
    meta.pidStart = meta.pid === null ? null : await processStart(meta.pid);
    await writeMeta();
  }
  return { ok: true, status: 200, id, unit: meta.unit, pid: meta.pid, host: hostname(), message: t('codingAgents.started', { kind, id }) };
}

// ---- stop ----

export async function stopCodingAgent(id: string, opts?: { dir?: string }): Promise<Result> {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, status: 400, message: t('codingAgents.badArgs', { message: 'id' }) };
  const refused = writeRefusal();
  if (refused) return refused;
  const meta = await readMeta(id, opts);
  if (!meta) return { ok: false, status: 404, message: t('codingAgents.notFound') };
  if ((await stateOf(meta, opts)).state !== 'running') return { ok: false, status: 409, message: t('codingAgents.notRunning') };

  // taken before the signal, written after it worked: exit.json can only be later than this
  const requestedAt = new Date().toISOString();
  if (meta.launcher === 'systemd') {
    // the unit is derived from the id, never taken from the file: only pb-agent-* units are ever stopped
    const r = await services().stop(unitOf(id), true);
    if (!r.ok) return { ok: false, status: 500, message: (r.stderr || r.stdout).trim().slice(0, 300) };
  } else {
    // only the runner (it forwards the signal to the CLI's process group), and only when pid and start time still match
    const pid = meta.pid;
    if (pid === null || !Number.isInteger(pid) || pid <= 1 || pid === process.pid || !(await runnerAlive(meta))) return { ok: false, status: 409, message: t('codingAgents.notRunning') };
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      return { ok: false, status: 500, message: (err as Error).message.slice(0, 300) };
    }
  }
  meta.stopRequestedAt = requestedAt;
  await writePrivate(join(runDirOf(id, opts), 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return { ok: true, status: 200, message: t('codingAgents.stopped', { id }) };
}
