// PreToolUse hook on Bash (c10dev/portboard#42): when a command starts a dev server on a hard-coded port or kills
// whatever holds a port, add Portboard's view of that port to the model's context: who holds or reserved it, the port
// to use for this worktree instead, and the MCP alternative (start_dev_server / cleanup_servers).
//
//   node port-nudge.ts < pretooluse.json     (Claude Code writes the PreToolUse JSON to stdin)
//
// It never blocks and never asks: no permissionDecision, exit code always 0, nothing on stdout unless there is
// context to add. One GET to the local REST API with a 300 ms timeout; on any failure it passes silently.
//
// Off: the plugin's `port_nudge` option (CLAUDE_PLUGIN_OPTION_PORT_NUDGE=false) or PORTBOARD_NUDGE=0.
// PORTBOARD_URL overrides the address (a preview on another port, tests); the default is production on loopback.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { portboardHome } from './home.ts';

export const DEFAULT_URL = 'http://127.0.0.1:8790';
export const TIMEOUT_MS = 300;
export const MARKER = '[portboard]';

export interface PreToolUseInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: unknown };
}

type Env = Record<string, string | undefined>;

/** The same cheap filter as src/core/portcmd.ts mayMentionPort: most Bash calls stop here, before any import. */
const MAYBE = (c: string) => /\d{2,5}/.test(c) && /(port|PORT|-p|-l|vite|next|astro|serve|kill|fuser|lsof|http\.server)/.test(c);

export function disabled(env: Env = process.env): boolean {
  return env.PORTBOARD_NUDGE === '0' || /^(false|0|no|off)$/i.test(env.CLAUDE_PLUGIN_OPTION_PORT_NUDGE ?? '');
}

/** The context to add, or null. Never throws. */
export async function nudge(input: PreToolUseInput, opts: { env?: Env; home?: string | null; timeoutMs?: number } = {}): Promise<string | null> {
  try {
    const env = opts.env ?? process.env;
    if (disabled(env) || input?.tool_name !== 'Bash') return null;
    const command = input.tool_input?.command;
    if (typeof command !== 'string' || !MAYBE(command)) return null;
    const home = opts.home === undefined ? portboardHome(env) : opts.home;
    if (!home) return null;
    const { parsePortCommands } = (await import(pathToFileURL(join(home, 'src', 'core', 'portcmd.ts')).href)) as typeof import('../../src/core/portcmd.ts');
    const [hit] = parsePortCommands(command);
    if (!hit) return null;

    const base = (env.PORTBOARD_URL || DEFAULT_URL).replace(/\/+$/, '');
    const q = new URLSearchParams({ port: String(hit.port), cmd: hit.kind, tool: hit.tool });
    if (typeof input.cwd === 'string' && input.cwd.startsWith('/')) q.set('cwd', input.cwd);
    if (typeof input.session_id === 'string' && /^[0-9a-zA-Z-]{1,64}$/.test(input.session_id)) q.set('session', input.session_id);
    const res = await fetch(`${base}/api/claude/port-advice?${q}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const body = (await res.json()) as { text?: unknown };
    return typeof body.text === 'string' && body.text.startsWith(MARKER) ? body.text : null;
  } catch {
    return null; // Portboard down, slow, or an old server without the route: say nothing
  }
}

/** What the hook prints: additionalContext only (no permissionDecision: the normal permission flow is untouched). */
export function hookOutput(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });
}

async function readStdin(limit = 1_048_576): Promise<string> {
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
    const text = await nudge(JSON.parse((await readStdin()) || '{}'));
    if (text) process.stdout.write(`${hookOutput(text)}\n`);
  } catch {
    // bad input: nothing to add
  }
}

const isMain = (import.meta as { main?: boolean }).main ?? (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href);
if (isMain) main().finally(() => process.exit(0));
