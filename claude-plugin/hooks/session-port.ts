// SessionStart and CwdChanged hook: puts the worktree's reserved port into the session.
//
//   node session-port.ts < hook-input.json     (Claude Code writes the hook JSON to stdin)
//
// Claude Code's own advice for its preview is "have your server read PORT". So when the session's worktree has a port
// reserved in Portboard (owner <repo>@<branch>), this writes `export PORT=<port>` to CLAUDE_ENV_FILE, which Claude Code
// runs before every Bash command of the session: the preview, `npm run dev` and the user all land on the same port.
// On SessionStart it also adds one short `[portboard]` context note (the reserved port, or how to get one).
// CwdChanged (Claude entered another worktree) rewrites PORT for the new one, or unsets it when the new cwd has none.
// With the plugin's `multi_machine_hint` option (off by default) or PORTBOARD_MULTI_MACHINE_HINT=1, the note also says
// when the same repo@branch has uncommitted changes or an active session on another machine (`portboard agent`).
//
// Never blocks: one GET with a 500 ms timeout, every error swallowed, exit code always 0. Standalone (no imports from
// Portboard's src/), like session-end.ts. Off: the plugin's `session_port` option or PORTBOARD_SESSION_PORT=0.

import { appendFile, readFile } from 'node:fs/promises';

export const DEFAULT_URL = 'http://127.0.0.1:8790';
export const TIMEOUT_MS = 500;
export const MARKER = '[portboard]';
/** The comment line before each PORT line this hook writes, so a later run knows the PORT is ours to unset */
export const ENV_TAG = '# portboard: worktree port';

type Env = Record<string, string | undefined>;

export interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
}

export interface SessionPort {
  owner: string | null;
  port: number | null;
  text: string | null;
}

export function disabled(env: Env = process.env): boolean {
  return env.PORTBOARD_SESSION_PORT === '0' || /^(false|0|no|off)$/i.test(env.CLAUDE_PLUGIN_OPTION_SESSION_PORT ?? '');
}

const on = (v: string | undefined) => /^(true|1|yes|on)$/i.test(v ?? '');

/** The cross-machine note: opt-in, since it names the other machines in the session's context */
export function multiMachine(env: Env = process.env): boolean {
  return on(env.PORTBOARD_MULTI_MACHINE_HINT) || on(env.CLAUDE_PLUGIN_OPTION_MULTI_MACHINE_HINT);
}

export async function lookup(cwd: string, withEnv: boolean, opts: { env?: Env; timeoutMs?: number } = {}): Promise<SessionPort | null> {
  try {
    const env = opts.env ?? process.env;
    const base = (env.PORTBOARD_URL || DEFAULT_URL).replace(/\/+$/, '');
    const q = new URLSearchParams({ cwd, ...(withEnv ? { env: '1' } : {}), ...(multiMachine(env) ? { machines: '1' } : {}) });
    const res = await fetch(`${base}/api/claude/session-port?${q}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const b = (await res.json()) as Partial<SessionPort>;
    const port = Number.isInteger(b.port) && (b.port as number) > 0 && (b.port as number) < 65536 ? (b.port as number) : null;
    return { owner: typeof b.owner === 'string' ? b.owner : null, port, text: typeof b.text === 'string' && b.text.startsWith(MARKER) ? b.text : null };
  } catch {
    return null; // Portboard down, slow, or an old server without the route
  }
}

/** The lines to append to CLAUDE_ENV_FILE: set PORT, or unset the PORT an earlier run of this hook set; null: nothing. */
export function envLines(port: number | null, current: string): string | null {
  if (port) return `${ENV_TAG}\nexport PORT=${port}\n`;
  return current.includes(ENV_TAG) && !current.trimEnd().endsWith('unset PORT') ? `${ENV_TAG}\nunset PORT\n` : null;
}

/** Does the work; returns what to print on stdout (SessionStart context), or null. Never throws. */
export async function run(input: HookInput, opts: { env?: Env; timeoutMs?: number } = {}): Promise<string | null> {
  try {
    const env = opts.env ?? process.env;
    if (disabled(env) || typeof input?.cwd !== 'string' || !input.cwd.startsWith('/')) return null;
    const event = input.hook_event_name;
    if (event !== 'SessionStart' && event !== 'CwdChanged') return null;
    const envFile = env.CLAUDE_ENV_FILE;
    const r = await lookup(input.cwd, !!envFile, opts);
    // Portboard unreachable: leave the environment as it is rather than unsetting a port that may still be right
    if (!r) return null;
    if (envFile) {
      const current = await readFile(envFile, 'utf8').catch(() => '');
      const lines = envLines(r.port, current);
      if (lines) await appendFile(envFile, `${current && !current.endsWith('\n') ? '\n' : ''}${lines}`).catch(() => {});
    }
    if (event !== 'SessionStart' || !r.text) return null;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: r.text } });
  } catch {
    return null;
  }
}

async function readStdin(limit = 65_536): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += (c as Buffer).length;
    if (size > limit) return '';
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(): Promise<void> {
  try {
    const out = await run(JSON.parse((await readStdin()) || '{}'));
    if (out) process.stdout.write(`${out}\n`);
  } catch {
    // bad input: nothing to do
  }
}

const isMain = (import.meta as { main?: boolean }).main ?? (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href);
if (isMain) main().finally(() => process.exit(0));
