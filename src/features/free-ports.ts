// Free ports: suggest ports for a new dev server (not listening, not used by tailscale serve, outside the ephemeral
// range). Nothing is reserved.
//
//   GET /api/free-ports?count=1&preferred=3000&for=<owner>   (reserved ports of <owner> first; others' never, #27)
//   MCP free_port (also remote: the result is only port numbers)

import { freePorts } from '../core/index.ts';
import { parseOptionalInt, text, type Core } from '../mcp/kit.ts';
import { readOnlyCore } from '../remote/core.ts';
import { ok } from './router.ts';
import type { FeatureModule, Tool } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    freePorts(count: number, preferred?: number, forOwner?: string | null): Promise<number[]>;
  }
}

async function freePort(args: unknown, core: Core) {
  const preferred = parseOptionalInt(args, 'preferred', 1024, 65535);
  if (!preferred.ok) return text(preferred.error, true);
  const count = parseOptionalInt(args, 'count', 1, 20);
  if (!count.ok) return text(count.error, true);
  const forRaw = (args as { for?: unknown } | null)?.for;
  if (forRaw !== undefined && typeof forRaw !== 'string') return text('for must be a string (a project or worktree owner)', true);
  return text({ ports: await core.freePorts(count.value ?? 1, preferred.value, forRaw?.trim() || null) });
}

const tool: Tool = {
  def: {
    name: 'free_port',
    title: 'Suggest free ports',
    description:
      'Suggest ports that are free for a new dev server: not listening, not used by tailscale serve, and outside ' +
      'the ephemeral range. Call this before starting a server instead of guessing a port.',
    inputSchema: {
      type: 'object',
      properties: {
        preferred: { type: 'integer', minimum: 1024, maximum: 65535, description: 'Start searching here (default 3000)' },
        count: { type: 'integer', minimum: 1, maximum: 20, description: 'How many ports to suggest (default 1)' },
        for: { type: 'string', description: "Owner (repo name, repo@branch or worktree path): that owner's reserved ports come first" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  call: freePort,
  remote: {
    description:
      'Suggest ports that are free on the Portboard server for a new dev server: not listening, not used by tailscale ' +
      'serve, and outside the ephemeral range. Read-only; it does not reserve the port.',
    // Same validation as the local tool, over a Core whose writes all throw.
    call: (args, core) => freePort(args, readOnlyCore(core)),
  },
};

export const freePortsFeature: FeatureModule = {
  name: 'free-ports',
  routes: [
    {
      method: 'GET',
      path: '/api/free-ports',
      async handler({ url }) {
        const count = Number(url.searchParams.get('count') ?? 1);
        const preferred = url.searchParams.has('preferred') ? Number(url.searchParams.get('preferred')) : undefined;
        return ok({ ports: await freePorts(count, preferred, url.searchParams.get('for')?.trim() || null) });
      },
    },
  ],
  tools: [tool],
  mcpCore: () => ({ freePorts }),
};
