// MCP tool layer: tools/list and tools/call over the feature registry (src/features/registry.ts). Each feature
// module owns its tool definitions, argument checks and result shaping. Pure (no stdio), so the stdio server in
// ../mcp.ts and the remote server share it, and tests can pass a fake core instead of touching `ss` or `tailscale serve`.

import { RpcError, text, type Core, type ToolResult } from './kit.ts';
import { REGISTRY } from '../features/registry.ts';
import { record, targetOf, type AuditLog } from '../core/audit.ts';

export { parseOptionalInt, parsePort, RpcError, type Core, type ToolResult } from './kit.ts';

/** tools/list: every feature's tools, in registry order. */
export const TOOLS = REGISTRY.tools.map((t) => t.def);

/**
 * With `audit` (the stdio server passes it), every call of a tool that isn't read-only goes into the audit log as
 * source "mcp", who "local": the stdio server is a child of a Claude session on this machine (#30).
 */
export async function callTool(name: string, args: unknown, core: Core, audit?: AuditLog | null): Promise<ToolResult> {
  const tool = REGISTRY.toolByName.get(name);
  if (!tool) throw new RpcError(-32602, `unknown tool: ${name}`);
  let result: ToolResult;
  try {
    result = await tool.call(args, core);
  } catch (err) {
    if (err instanceof RpcError) throw err;
    result = text(`${name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  if (audit && tool.def.annotations.readOnlyHint !== true) {
    await record(audit, { at: new Date().toISOString(), who: 'local', source: 'mcp', route: `mcp ${name}`, target: targetOf(null, args), result: result.isError ? 'error' : 'ok' });
  }
  return result;
}
