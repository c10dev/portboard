// SessionEnd hook (c10dev/portboard#43): tells the local Portboard that this Claude Code session ended, so the servers
// it started become cleanup candidates at once (and are stopped, when the user turned auto-stop on).
//
//   node session-end.ts < hook-input.json     (as a command hook: Claude Code writes the SessionEnd JSON to stdin)
//   import { onSessionEnd } from './session-end.ts'
//
// It never blocks a session from ending: one POST with a 500 ms timeout, every error swallowed, exit code always 0.
// Standalone on purpose (no imports from Portboard's src/): the plugin is installed without the rest of the repo.
// PORTBOARD_URL overrides the address (a preview on another port, tests); the default is production on loopback.

export const DEFAULT_URL = 'http://127.0.0.1:8790';
export const TIMEOUT_MS = 500;

export interface SessionEndInput {
  session_id: string;
  cwd: string;
  reason?: string;
}

export async function onSessionEnd(input: SessionEndInput, opts: { url?: string; timeoutMs?: number } = {}): Promise<void> {
  try {
    if (!input || typeof input.session_id !== 'string' || !input.session_id) return;
    const base = (opts.url ?? process.env.PORTBOARD_URL ?? DEFAULT_URL).replace(/\/+$/, '');
    const body: SessionEndInput = { session_id: input.session_id, cwd: typeof input.cwd === 'string' ? input.cwd : '' };
    if (typeof input.reason === 'string' && input.reason) body.reason = input.reason;
    const res = await fetch(`${base}/api/claude/session-end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-portboard': '1' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    // Portboard not running, slow, or refused: the session ends anyway
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
    const input = JSON.parse((await readStdin()) || '{}');
    await onSessionEnd(input);
  } catch {
    // bad input: nothing to report
  }
}

const isMain = (import.meta as { main?: boolean }).main ?? (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href);
if (isMain) main().finally(() => process.exit(0));
