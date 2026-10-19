// Stdio MCP server for Claude Code / Claude Desktop: newline-delimited JSON-RPC on stdin/stdout.
// Wraps the same core API as the REST server (src/server.ts). Tools, resources and prompts come from the feature
// modules (src/features/registry.ts); docs/mcp.md lists them.
//
//   claude mcp add portboard -- node <checkout>/src/mcp.ts   (or the plugin: see the 설정 tab's 시작하기)

import { createInterface } from 'node:readline';
import { handleMessage, type Response } from './mcp/rpc.ts';
import type { Core } from './mcp/kit.ts';
import { REGISTRY } from './features/registry.ts';
import { AuditLog } from './core/audit.ts';
import { PATHS } from './core/paths.ts';

// stdout carries protocol messages only; anything logged by accident goes to stderr.
console.log = console.info = console.debug = console.error;

// Each feature adds its part (mcpCore in src/features/*): reads of the files the dashboard writes, never its own
// sampling or alerting.
const core = Object.assign({}, ...REGISTRY.features.map((f) => f.mcpCore?.() ?? {})) as Core;
// 기록 (#30): write tools go into the same audit log as the dashboard's writes (same state dir), as source "mcp".
const audit = new AuditLog(PATHS.audit);
const send = (msg: Response) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const inFlight = new Set<Promise<void>>();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const job = handleMessage(msg, core, audit)
    .then((reply) => {
      if (reply) send(reply);
    })
    .finally(() => inFlight.delete(job));
  inFlight.add(job);
});

// Client closed stdin: finish what was asked, then exit (fetch keep-alive sockets would otherwise linger).
rl.on('close', async () => {
  await Promise.allSettled([...inFlight]);
  process.exit(0);
});
