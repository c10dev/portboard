// What every MCP tool needs, without the tool list: the Core the tools run against, result and error shapes, and
// argument checks. Feature modules (src/features/*) import this instead of tools.ts, so tools.ts can build its list
// from the registry without an import cycle.
//
// Core starts empty here. Each feature module adds the methods its tools need with a module augmentation
// (`declare module '../mcp/kit.ts' { interface Core { … } }`), and contributes them for the stdio server through
// its `mcpCore()`; the full interface is the union of those.

// Not `type`: interfaces merge, which is what the feature modules' augmentations rely on.
export interface Core {}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Protocol-level failure (unknown tool) — reported as a JSON-RPC error, not a tool result. */
export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export const PORT_ARG = {
  type: 'object',
  properties: { port: { type: 'integer', minimum: 1, maximum: 65535, description: 'TCP port number' } },
  required: ['port'],
  additionalProperties: false,
};

/** What every remote tool is listed with, whatever its module says (src/features/registry.ts). */
export const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Accepts an integer or a digit string (some clients stringify numbers). */
export function parsePort(args: unknown): Parsed<number> {
  const raw = (args as Record<string, unknown> | null | undefined)?.port;
  const port = typeof raw === 'string' && /^\d{1,5}$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `port must be an integer between 1 and 65535 (got ${JSON.stringify(raw ?? null)})` };
  }
  return { ok: true, value: port };
}

export function parseOptionalInt(args: unknown, key: string, min: number, max: number): Parsed<number | undefined> {
  const raw = (args as Record<string, unknown> | null | undefined)?.[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    return { ok: false, error: `${key} must be an integer between ${min} and ${max} (got ${JSON.stringify(raw)})` };
  }
  return { ok: true, value: n };
}
