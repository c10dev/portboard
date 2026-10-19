// Starts the background jobs the features declare: one scheduler for every interval job (c10dev/portboard#24).
// One tick drives all of them, a job never overlaps itself, a failing job doesn't affect the others, and start
// times get a little jitter so jobs with the same interval don't all spawn their subprocesses in the same second.
// Heavy jobs (the worktree and transcript scans) take turns: a due one starts on the first tick after the other ends.
// The alert checker and the self-watch run here too (c10dev/portboard#4); the audit log's flush timer is the one timer
// left outside: it runs only while denials are pending, and the stdio MCP server, which has no scheduler, has one too.

import type { Paths } from '../core/paths.ts';
import type { ServerContext } from './context.ts';
import type { IntervalJob, Job } from './types.ts';

export const isEnabled = (job: Job, paths: Paths) => (job.enabled ? job.enabled(paths) : true);

export interface JobState {
  name: string;
  everyMs: number;
  runs: number;
  errors: number;
  running: boolean;
  lastRunAt: number | null;
  lastMs: number | null;
  lastError: string | null;
  nextAt: number;
}

export interface SchedulerOptions {
  now?(): number;
  /** 0..1, default Math.random */
  random?(): number;
  /** Max start jitter as a fraction of the interval (default 0.2, capped at 5 s) */
  jitter?: number;
  log?(line: string): void;
}

export class Scheduler {
  private readonly jobs: { job: IntervalJob; state: JobState }[] = [];
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly jitter: number;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SchedulerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.jitter = opts.jitter ?? 0.2;
    this.log = opts.log ?? ((l) => console.error(l));
  }

  add(job: IntervalJob, ctx: ServerContext): void {
    const t = this.now();
    const delay = job.runAtStart ? 0 : (job.firstAfterMs ?? job.everyMs + this.spread(job.everyMs));
    const state: JobState = { name: job.name, everyMs: job.everyMs, runs: 0, errors: 0, running: false, lastRunAt: null, lastMs: null, lastError: null, nextAt: t + delay };
    this.jobs.push({ job, state });
    this.ctx = ctx;
  }

  private ctx: ServerContext | null = null;

  private spread(everyMs: number): number {
    return Math.floor(this.random() * Math.min(everyMs * this.jitter, 5_000));
  }

  /** Runs every job that is due and not already running; returns the names started (tests drive this directly). */
  tick(): string[] {
    const t = this.now();
    const started: string[] = [];
    let heavyRunning = this.jobs.some((j) => j.job.heavy && j.state.running);
    for (const entry of this.jobs) {
      const { job, state } = entry;
      if (state.running || t < state.nextAt) continue;
      if (job.heavy && heavyRunning) continue;
      heavyRunning ||= !!job.heavy;
      state.running = true;
      state.lastRunAt = t;
      state.nextAt = t + job.everyMs + this.spread(job.everyMs);
      started.push(job.name);
      const began = this.now();
      Promise.resolve()
        .then(() => job.run(this.ctx!))
        .then(
          () => {
            state.lastError = null;
          },
          (err: unknown) => {
            state.errors++;
            const msg = err instanceof Error ? err.message : String(err);
            if (msg !== state.lastError) this.log(`[portboard] job ${job.name} failed: ${msg}`);
            state.lastError = msg;
          },
        )
        .finally(() => {
          state.runs++;
          state.running = false;
          state.lastMs = this.now() - began;
        });
    }
    return started;
  }

  start(tickMs = 1_000): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  states(): JobState[] {
    return this.jobs.map((j) => ({ ...j.state }));
  }
}

let shared: Scheduler | null = null;

/** The scheduler the server started (for /api/health?detail); null before startJobs. */
export function scheduler(): Scheduler | null {
  return shared;
}

/** Starts every enabled job; returns the names started (for the startup log and tests). */
export function startJobs(jobs: Job[], ctx: ServerContext, sched: Scheduler = new Scheduler()): string[] {
  const started: string[] = [];
  for (const job of jobs) {
    if (!isEnabled(job, ctx.paths)) continue;
    sched.add(job, ctx);
    started.push(job.name);
  }
  sched.start();
  shared = sched;
  return started;
}
