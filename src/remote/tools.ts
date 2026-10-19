// Remote (internet-facing) MCP surface: an allowlist of read-only tools, one resource and two prompts over a core
// that has no write methods. Wraps src/mcp/rpc.ts instead of changing it: initialize, tools/*, resources/* and
// prompts/* are answered here, only ping and notifications are delegated. (The shared dispatcher also serves
// resources/read for ports and devices, unredacted; it must never see those methods from here.)
//
// Three independent layers keep write tools out:
//   1. tools/list returns only REMOTE_TOOLS: the tools feature modules mark remote, and the registry refuses to mark
//      one that isn't read-only (src/features/registry.ts; test/registry.test.ts pins the exact set)
//   2. tools/call refuses any name not in REMOTE_TOOL_NAMES, with the same error as a tool that doesn't exist
//   3. remote calls get a RemoteCore, which has no writes; shared tool code gets readOnlyCore(), whose
//      expose/unexpose/restart/stop/logs throw (src/remote/core.ts)

import { handleMessage, PROTOCOL_VERSIONS, type Request, type Response } from '../mcp/rpc.ts';
import { RpcError, type ToolResult } from '../mcp/tools.ts';
import { readOnlyCore, type RemoteCore } from './core.ts';
import { REGISTRY } from '../features/registry.ts';
import { NOT_FOUND } from '../mcp/resources.ts';
import { describe, getPrompt } from '../mcp/prompts.ts';
import { STRICT, type RedactPolicy } from './redact.ts';
import { VERSION } from '../version.ts';
import { SITE } from '../core/site.ts';

export { readOnlyCore, type RemoteCore } from './core.ts';

// Each feature module says which of its tools the remote server offers (Tool.remote, RemoteTool); the registry
// refuses any that isn't read-only. Shared tools come in local order, then remote-only tools.
export const REMOTE_TOOLS = REGISTRY.remoteTools;

/** Everything tools/call answers remotely; any other name is "unknown tool". */
export const REMOTE_TOOL_NAMES: ReadonlySet<string> = new Set(REMOTE_TOOLS.map((t) => t.name));

// ---- resources and prompts: what the feature modules offer remotely (remoteResources, remotePrompts) ----

export const REMOTE_RESOURCES = REGISTRY.remoteResources.flatMap((r) => r.resources);
export const REMOTE_RESOURCE_URIS: ReadonlySet<string> = new Set(REMOTE_RESOURCES.map((r) => r.uri));
/** Same names and titles as the local server; the texts only name what this connection has. */
export const REMOTE_PROMPTS = REGISTRY.remotePrompts;

/** Only the URIs a module lists remotely (portboard://status). Any other, a port or device URI included, is "not found" before touching the core. */
export async function readRemoteResource(uri: unknown, core: RemoteCore, policy: RedactPolicy = STRICT) {
  if (typeof uri !== 'string' || !uri) throw new RpcError(-32602, 'params.uri must be a string');
  const owner = REGISTRY.remoteResources.find((r) => r.resources.some((x) => x.uri === uri));
  if (!owner) throw new RpcError(NOT_FOUND, `resource not found: ${uri.slice(0, 200)}`);
  return owner.read(uri, core, policy);
}

export const REMOTE_INSTRUCTIONS =
  `Portboard (read-only, remote). It describes one Linux server, ${SITE.host}, on its owner's private Tailscale network: ` +
  'which TCP ports are listening and what owns them (list_ports), which devices are online and how loaded they are ' +
  '(list_devices), which device is using which service right now (who_uses_what), and which ports are free for a ' +
  'new dev server (free_port). Nothing here can start, stop, publish or change anything, and logs are not available. ' +
  'The URLs in the results only open from the owner\'s own tailnet devices. Network addresses, process ids and paths ' +
  'are redacted on purpose; do not ask for them. The portboard://status resource is a compact summary of all of this; ' +
  'the prompts server_status_summary and port_cleanup are ready-made requests built on these tools.';

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export async function callRemoteTool(name: string, args: unknown, core: RemoteCore, policy: RedactPolicy = STRICT): Promise<ToolResult> {
  // Same message as a tool that doesn't exist: don't confirm that write tools exist elsewhere.
  if (!REMOTE_TOOL_NAMES.has(name)) throw new RpcError(-32602, `unknown tool: ${name}`);
  const remote = REGISTRY.remoteCalls.get(name)!;
  try {
    return await remote(args, core, policy);
  } catch (err) {
    if (err instanceof RpcError) throw err;
    // Error text can carry paths or addresses; keep it generic.
    return text(`${name} failed on the server`, true);
  }
}

const ok = (id: Request['id'], result: unknown): Response => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Request['id'], code: number, message: string): Response => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** One JSON-RPC message → reply, or null for notifications. */
export async function handleRemoteMessage(msg: Request, core: RemoteCore, policy: RedactPolicy = STRICT): Promise<Response | null> {
  const isRequest = msg !== null && typeof msg === 'object' && !Array.isArray(msg) && 'id' in msg;
  if (isRequest && typeof msg.method === 'string') {
    const id = msg.id ?? null;
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = msg.params?.protocolVersion;
          return ok(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'portboard-remote', title: 'Portboard (read-only)', version: VERSION },
            instructions: REMOTE_INSTRUCTIONS,
          });
        }
        case 'tools/list':
          return ok(id, { tools: REMOTE_TOOLS });
        case 'tools/call': {
          const name = msg.params?.name;
          if (typeof name !== 'string') return fail(id, -32602, 'params.name must be a string');
          return ok(id, await callRemoteTool(name, msg.params?.arguments ?? {}, core, policy));
        }
        case 'resources/list':
          return ok(id, { resources: REMOTE_RESOURCES });
        case 'resources/templates/list':
          return ok(id, { resourceTemplates: [] });
        case 'resources/read':
          return ok(id, await readRemoteResource(msg.params?.uri, core, policy));
        case 'prompts/list':
          return ok(id, { prompts: REMOTE_PROMPTS.map(describe) });
        case 'prompts/get':
          // Unknown and local-only names get the same -32602 "unknown prompt" as a name that doesn't exist.
          return ok(id, getPrompt(msg.params?.name, msg.params?.arguments, REMOTE_PROMPTS));
        case 'ping':
          break;
        default:
          return fail(id, -32601, `method not found: ${msg.method.slice(0, 64)}`);
      }
    } catch (err) {
      if (err instanceof RpcError) return fail(id, err.code, err.message);
      return fail(id, -32603, 'internal error');
    }
  }
  // ping, invalid requests, notifications: the shared dispatcher, with writes disabled.
  return handleMessage(msg, readOnlyCore(core));
}

