// What a feature module declares. One file per feature (src/features/<name>.ts) owns its REST routes, MCP tools
// (local, and which of them the remote server may offer), resources/prompts, background jobs, the health
// collectors it reports, and the dashboard scripts it adds. registry.ts lists the modules; server.ts, mcp.ts,
// src/mcp/* and src/remote/tools.ts only iterate them.

import type { IncomingMessage } from 'node:http';
import type { Paths } from '../core/paths.ts';
import type { Core, ToolResult } from '../mcp/kit.ts';
import type { PromptDef } from '../mcp/prompts.ts';
import type { RedactPolicy } from '../remote/redact.ts';
import type { RemoteCore } from '../remote/core.ts';
import type { ServerContext } from './context.ts';

// ---- REST ----

export interface RouteRequest {
  url: URL;
  /** `:port` is a checked integer 1–65535; other params are the matched text */
  params: { port: number; device: string };
  /** Parsed JSON body, for routes that declare `body` */
  body: any;
  req: IncomingMessage;
}

export interface Reply {
  status: number;
  body: unknown;
}

interface RouteBase {
  /**
   * Exact path, or a pattern with `:port` (1–5 digits, 400 "bad port" outside 1–65535) or `:device` (a tailnet
   * device id). Anything else in the path is literal.
   */
  path: string;
  handler(r: RouteRequest, ctx: ServerContext): Promise<Reply>;
}

export interface ReadRoute extends RouteBase {
  method: 'GET';
  write?: false;
}

/**
 * Anything but GET changes something, so it must say `write: true`: the router then requires the `X-Portboard: 1`
 * header (a custom header forces a CORS preflight, which is never answered, so cross-site pages can't send it).
 */
export interface WriteRoute extends RouteBase {
  method: 'POST';
  write: true;
  /** Read and parse a JSON body up to this many bytes (400 "invalid JSON body" otherwise) */
  body?: { limit: number };
}

export type Route = ReadRoute | WriteRoute;

// ---- MCP ----

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/** How the remote (internet-facing, read-only) server answers a tool: only from RemoteCore, which has no writes. */
export type RemoteCall = (args: unknown, core: RemoteCore, policy: RedactPolicy) => Promise<ToolResult>;

export interface Tool {
  def: ToolDef;
  call(args: unknown, core: Core): Promise<ToolResult>;
  /**
   * Offer this tool on the remote server too. Only read-only tools (annotations.readOnlyHint) may; the registry
   * refuses anything else. The remote copy keeps name and schema, gets this description and read-only annotations,
   * and answers with `call`, which must redact (src/remote/redact.ts).
   */
  remote?: { description?: string; call: RemoteCall };
}

/** A tool only the remote server has (listed after the shared ones). */
export interface RemoteTool {
  def: ToolDef;
  call: RemoteCall;
}

export interface Resource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
}

export interface ReadResult {
  contents: { uri: string; mimeType: string; text: string }[];
}

export interface Resources {
  templates?: ResourceTemplate[];
  /** Entries for resources/list (may read the core; a failing source leaves its entries out) */
  list(core: Core): Promise<Resource[]>;
  /** Whether this module serves the URI; resources/read goes to the first module that claims it */
  claims(uri: string): boolean;
  read(uri: string, core: Core): Promise<ReadResult>;
}

export interface RemoteResources {
  resources: Resource[];
  read(uri: string, core: RemoteCore, policy: RedactPolicy): Promise<ReadResult>;
}

// ---- background ----

interface JobBase {
  name: string;
  /** Default: always. The alert checker, for one, only runs when paths.alertsOn (never in a preview by default). */
  enabled?(paths: Paths): boolean;
}

/**
 * Runs `run` every `everyMs`: the first time at start with `runAtStart`, after `firstAfterMs` when given, else after
 * one interval. Errors are the job's own to report.
 */
export interface IntervalJob extends JobBase {
  everyMs: number;
  runAtStart?: boolean;
  /** The first run this long after start (the self-watch looks after 20 s, once every collector has had a go) */
  firstAfterMs?: number;
  /**
   * A big scan (thousands of files or stats): at most one heavy job runs at a time, a due one waits for the running
   * one, so their transient memory peaks don't add up (both scans start at boot)
   */
  heavy?: boolean;
  run(ctx: ServerContext): unknown;
}

export type Job = IntervalJob;

// ---- the module ----

export interface FeatureModule {
  name: string;
  /** Position in FEATURES (src/features/registry.ts), lowest first: the order of tools/list, routes, jobs and page
   *  scripts. Unique across features; existing ones are spaced by 100, so a new feature takes a free number between
   *  the two it should sit between (below 2600 keeps it before remote-connector, access, write-devices, settings). */
  order: number;
  routes?: Route[];
  /** Local MCP tools, in tools/list order */
  tools?: Tool[];
  /** What this feature adds to the stdio server's Core (src/mcp.ts) */
  mcpCore?(): Partial<Core>;
  remoteTools?: RemoteTool[];
  resources?: Resources;
  remoteResources?: RemoteResources;
  prompts?: PromptDef[];
  remotePrompts?: PromptDef[];
  jobs?: Job[];
  /** Flushes and other work before the dashboard exits (SIGTERM / SIGINT) */
  shutdown?(ctx: ServerContext): Promise<void>;
  /** health.ts collector names this feature reports (labels and display order stay in health.ts COLLECTORS) */
  collectors?: string[];
  /**
   * Dashboard scripts this feature adds: served pages get `<script src type="module">` before </body>. The page
   * `#settings` is the 설정 modal (public/features/settings-modal.js imports those when it first opens).
   */
  ui?: { pages: string[]; script: string }[];
}
