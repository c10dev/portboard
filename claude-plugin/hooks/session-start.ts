// SessionStart hook: tells the local Portboard that this Claude Code session started (or resumed), so an earlier
// SessionEnd record of the same id stops counting at once (the desktop app resumes a session id in a new process;
// src/core/claude-sessions.ts).
//
//   node session-start.ts < hook-input.json     (Claude Code writes the SessionStart JSON to stdin)
//
// Never delays a session: one POST with a 500 ms timeout, every error swallowed, no output, exit code always 0.
// Standalone (no imports from Portboard's src/), like session-end.ts. PORTBOARD_URL overrides the address.

export const DEFAULT_URL = 'http://127.0.0.1:8790';
export const TIMEOUT_MS = 500;

export interface SessionStartInput {
  session_id: string;
  cwd: string;
  source?: string;
}

export async function onSessionStart(input: SessionStartInput, opts: { url?: string; timeoutMs?: number } = {}): Promise<void> {
  try {
    if (!input || typeof input.session_id !== 'string' || !input.session_id) return;
    const base = (opts.url ?? process.env.PORTBOARD_URL ?? DEFAULT_URL).replace(/\/+$/, '');
    const body: SessionStartInput = { session_id: input.session_id, cwd: typeof input.cwd === 'string' ? input.cwd : '' };
    if (typeof input.source === 'string' && input.source) body.source = input.source;
    const res = await fetch(`${base}/api/claude/session-start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-portboard': '1' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    // Portboard not running, slow, or refused: the session starts anyway
  }
}

async function readStdin(limit = 65_536): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += (c as Buffer).length;
    if (size > limit) break;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(): Promise<void> {
  try {
    await onSessionStart(JSON.parse((await readStdin()) || '{}'));
  } catch {
    // bad input: nothing to report
  }
}

const isMain = (import.meta as { main?: boolean }).main ?? (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href);
if (isMain) main().finally(() => process.exit(0));
