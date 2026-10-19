// Minimal MCP JSON-RPC dispatcher: initialize, ping, tools/*, resources/*, prompts/*. Transport-agnostic. The
// tools, resources and prompts come from the feature modules (src/features/registry.ts).

import { VERSION } from '../version.ts';
import { callTool, RpcError, TOOLS, type Core } from './tools.ts';
import { NOT_FOUND } from './resources.ts';
import { describe, getPrompt } from './prompts.ts';
import { REGISTRY } from '../features/registry.ts';
import type { AuditLog } from '../core/audit.ts';

// Newest first; the tools, resources and prompts subsets of the protocol are the same across these
// (2025-06-18 added `title`, which older clients ignore).
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'portboard', version: VERSION };

type Id = string | number | null;
export interface Request {
  jsonrpc?: string;
  id?: Id;
  method?: unknown;
  params?: any;
}
export type Response = { jsonrpc: '2.0'; id: Id } & ({ result: unknown } | { error: { code: number; message: string } });

const ok = (id: Id, result: unknown): Response => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id, code: number, message: string): Response => ({ jsonrpc: '2.0', id, error: { code, message } });

/** resources/read: the first feature module that claims the URI answers; anything else is "not found". */
function readResource(uri: unknown, core: Core) {
  if (typeof uri !== 'string' || !uri) throw new RpcError(-32602, 'params.uri must be a string');
  const owner = REGISTRY.resources.find((r) => r.claims(uri));
  if (!owner) throw new RpcError(NOT_FOUND, `resource not found: ${uri.slice(0, 200)}`);
  return owner.read(uri, core);
}

/** Returns the reply, or null for notifications (no id). `audit`: where write tool calls are recorded (stdio server). */
export async function handleMessage(msg: Request, core: Core, audit?: AuditLog | null): Promise<Response | null> {
  const isNotification = msg === null || typeof msg !== 'object' || !('id' in msg);
  if (isNotification) return null;
  const id = msg.id ?? null;
  if (typeof msg.method !== 'string') return fail(id, -32600, 'invalid request');

  try {
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return ok(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          // No listChanged / subscribe: the lists are fixed for a session and nothing is pushed.
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'Portboard lists the TCP ports listening on this server and can publish loopback-only HTTP ports ' +
            'to the Tailscale tailnet. When the user asks what is running on the server, which ports or web apps ' +
            'are up, or how to open one from another device, call list_ports first instead of running ss/netstat/ps ' +
            'yourself: it already joins owner process, project folder, systemd unit, docker container, HTTP title ' +
            'and the tailnet URL to open. Shell commands are still fine for CPU/memory/disk questions. ' +
            'Call list_ports before expose_port; only ports with canExpose=true can be exposed. ' +
            'For a service that is down or misbehaving, read tail_logs before restart_service. Before starting a new ' +
            'dev server, call free_port instead of guessing a port. Ask before stop_service unless the user asked to stop it. ' +
            'For questions about the machines themselves (is the desktop up, how loaded is the server, what is running on the desktop or the Mac), use list_devices. ' +
            'For "who is using X", "when was this last used" or "is anything still using this before I stop it", call ' +
            'who_uses (optionally with port): devices connected now plus last-used history. list_ports shows group (ports ' +
            'of the same compose project/unit/process) and lastUsed. name_device names a LAN device by the key who_uses gives.',
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: TOOLS });
      case 'tools/call': {
        const name = msg.params?.name;
        if (typeof name !== 'string') return fail(id, -32602, 'params.name must be a string');
        return ok(id, await callTool(name, msg.params?.arguments ?? {}, core, audit));
      }
      case 'resources/list':
        return ok(id, { resources: (await Promise.all(REGISTRY.resources.map((r) => r.list(core)))).flat() });
      case 'resources/templates/list':
        return ok(id, { resourceTemplates: REGISTRY.resources.flatMap((r) => r.templates ?? []) });
      case 'resources/read':
        return ok(id, await readResource(msg.params?.uri, core));
      case 'prompts/list':
        return ok(id, { prompts: REGISTRY.prompts.map(describe) });
      case 'prompts/get':
        return ok(id, getPrompt(msg.params?.name, msg.params?.arguments, REGISTRY.prompts));
      default:
        return fail(id, -32601, `method not found: ${msg.method}`);
    }
  } catch (err) {
    if (err instanceof RpcError) return fail(id, err.code, err.message);
    return fail(id, -32603, err instanceof Error ? err.message : String(err));
  }
}
