// The main process of a coding-agent run (start_coding_agent): `node coding-agent-runner.ts <runDir>`, started as a
// transient systemd unit or as a detached process (coding-agents.ts). It runs the CLI once with the prompt on stdin,
// keeps its output in the run folder, and writes exit.json when the CLI is gone. Imports only node:*, atomic.ts (node:*
// only) and the adapters, so it never loads the server.
//
// Files (all 0600, in the 0700 run folder): events.jsonl = the CLI's stdout verbatim, stderr.log = its stderr. They are
// opened here with mode 0o600 in append mode and handed to the child as its stdio, because appendPrivate per line is
// too slow and a stream in this process would only copy the bytes. exit.json goes through writePrivate (the one
// whole-file write).
//
// SIGTERM/SIGINT, or the timeout, send SIGTERM to the CLI and SIGKILL 10 s later if it is still there.
//
// PORTBOARD_CODING_AGENT_TIMEOUT_MS is TEST-ONLY: it replaces the timeout in meta.json so a test can wait for the
// timeout path in milliseconds. Nothing but this file reads it.

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivate } from './atomic.ts';
import { adapterFor, emptySummary, resolveBin, type CodingAgentKind, type Sandbox } from './coding-agent-adapters.ts';

interface Meta {
  kind: CodingAgentKind;
  cwd: string;
  sandbox: Sandbox;
  model: string | null;
  timeoutMinutes: number;
}

interface Exit {
  code: number | null;
  signal: string | null;
  endedAt: string;
  timedOut?: true;
  /** got SIGTERM/SIGINT (a stop) and did not time out */
  stopped?: true;
  launchFailed?: true;
}

const KILL_AFTER_MS = 10_000;

// Installed before anything else: a stop that arrives while the runner is still starting is not lost, it is applied as
// soon as the CLI exists. (A signal before this line has no handler yet and ends the process: node's own start-up.)
let handler: (() => void) | null = null;
let earlySignal = false;
const forward = () => (handler ? handler() : (earlySignal = true));
process.on('SIGTERM', forward);
process.on('SIGINT', forward);

async function main(runDir: string): Promise<void> {
  // files the CLI writes itself (codex -o last.md) follow the umask: keep them 0600 like the rest of the run folder
  process.umask(0o077);
  const writeExit = (e: Omit<Exit, 'endedAt'>) => writePrivate(join(runDir, 'exit.json'), JSON.stringify({ ...e, endedAt: new Date().toISOString() }) + '\n');
  const stderrNote = (line: string) => appendFileSync(join(runDir, 'stderr.log'), `[runner] ${line}\n`, { mode: 0o600 });

  let meta: Meta;
  try {
    meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8'));
  } catch (err) {
    stderrNote(`cannot read meta.json: ${(err as Error).message}`);
    await writeExit({ code: null, signal: null, launchFailed: true });
    return;
  }
  const adapter = adapterFor(meta.kind);
  const bin = adapter ? resolveBin(adapter.bin, process.env.PATH) : null;
  if (!adapter || !bin) {
    stderrNote(`${meta.kind}: command not found on PATH`);
    await writeExit({ code: 127, signal: null });
    return;
  }

  const stdin = openSync(join(runDir, 'prompt.txt'), 'r');
  const out = openSync(join(runDir, 'events.jsonl'), 'a', 0o600);
  const err = openSync(join(runDir, 'stderr.log'), 'a', 0o600);
  const argv = adapter.args({ cwd: meta.cwd, sandbox: meta.sandbox, model: meta.model ?? undefined, lastMessageFile: join(runDir, 'last.md') });

  const override = Number(process.env.PORTBOARD_CODING_AGENT_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(override) && override > 0 ? override : meta.timeoutMinutes * 60_000;

  // detached: the CLI leads its own process group, so a stop reaches the tools it started too
  const child = spawn(bin, argv, { cwd: meta.cwd, env: process.env, stdio: [stdin, out, err], detached: true });
  for (const fd of [stdin, out, err]) closeSync(fd);

  let timedOut = false;
  let signalled = false;
  let done = false;
  let killTimer: NodeJS.Timeout | undefined;
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
  };
  const terminate = () => {
    if (done || killTimer) return;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_AFTER_MS);
  };
  const onSignal = () => {
    signalled = true;
    terminate();
  };
  handler = onSignal;
  if (earlySignal) onSignal();
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);

  const finish = async (e: Omit<Exit, 'endedAt'>) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (adapter.kind === 'gemini') {
      // gemini has no -o: the final text comes from its events
      const s = emptySummary();
      try {
        for (const line of readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n')) adapter.parse(line, s);
        if (s.finalText) await writePrivate(join(runDir, 'last.md'), s.finalText);
      } catch {
        // no final text then
      }
    }
    await writeExit({ ...e, ...(timedOut ? { timedOut: true as const } : signalled ? { stopped: true as const } : {}) });
  };

  await new Promise<void>((resolve) => {
    child.on('error', (e) => {
      stderrNote(`cannot start ${bin}: ${e.message}`);
      void finish({ code: 127, signal: null }).then(resolve);
    });
    child.on('close', (code, signal) => void finish({ code, signal }).then(resolve));
  });
}

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: coding-agent-runner <run folder>');
  process.exit(2);
}
main(runDir).then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
