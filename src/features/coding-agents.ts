// Hand a task to another coding agent CLI on this host (codex, gemini): start, list, read the output, stop.
//
//   MCP  start_coding_agent, list_coding_agents, coding_agent_output, stop_coding_agent (local stdio server only)
//
// No HTTP route and no remote tool: the prompt and the answer are the caller's, and the CLI runs with this machine
// user's own login. The logic is in src/core/coding-agents.ts. The audit line of start_coding_agent holds the argument
// names and `path`, never the prompt (src/core/audit.ts keeps the value of an allowlisted key only).

import {
  codingAgentOutput,
  listCodingAgents,
  startCodingAgent,
  stopCodingAgent,
  KINDS,
  SANDBOXES,
  type ListedRun,
  type OutputResult,
  type StartRequest,
  type StartResult,
} from '../core/coding-agents.ts';
import { parseOptionalInt, text, type Core } from '../mcp/kit.ts';
import type { FeatureModule, Tool } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    startCodingAgent(req: StartRequest): Promise<StartResult>;
    listCodingAgents(id?: string): Promise<{ runs: ListedRun[] }>;
    codingAgentOutput(id: string, after?: number, limit?: number): Promise<OutputResult>;
    stopCodingAgent(id: string): Promise<{ ok: boolean; status: number; message: string }>;
  }
}

const startTool: Tool = {
  def: {
    name: 'start_coding_agent',
    title: 'Start a coding agent in a worktree',
    description:
      'Run another coding agent CLI (codex or gemini) non-interactively on THIS Portboard host, in an existing worktree ' +
      '(see list_worktrees / find_worktree), with a prompt. One run per worktree. The sandbox is read-only by default; ' +
      'workspace-write is allowed only for codex and only in a linked worktree, never in a main checkout, and the tool never ' +
      "bypasses the CLI's own sandbox or approvals. Gemini runs read-only only, and its read-only is the CLI's approval mode, " +
      'not an OS sandbox. The CLI uses its own login on this host. Returns an id: follow it with ' +
      'coding_agent_output until the state is not running. To pick a machine, call where_to_run first: this tool does ' +
      'not run anywhere else. Ask the user before using workspace-write unless they asked for edits.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...KINDS], description: 'The coding agent CLI to run' },
        path: { type: 'string', description: 'Absolute worktree path (as list_worktrees reports it)' },
        prompt: { type: 'string', description: 'The task, up to 100000 characters. It goes to the CLI on stdin and is not logged.' },
        sandbox: { type: 'string', enum: [...SANDBOXES], description: 'Default read-only. workspace-write lets codex edit files in the worktree (refused for gemini).' },
        model: { type: 'string', description: "The CLI's own model name (letters, digits, . _ : -; starts with a letter or digit)" },
        timeout_minutes: { type: 'integer', minimum: 1, maximum: 240, description: 'Default 30. The run is stopped after this long.' },
      },
      required: ['kind', 'path', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async call(args, core) {
    const a = (args ?? {}) as Record<string, unknown>;
    if (typeof a.kind !== 'string' || !(KINDS as readonly string[]).includes(a.kind)) return text(`kind must be ${KINDS.join(' or ')}`, true);
    if (typeof a.path !== 'string') return text('path must be a worktree path', true);
    if (typeof a.prompt !== 'string') return text('prompt must be a string', true);
    if (a.sandbox !== undefined && !(SANDBOXES as readonly unknown[]).includes(a.sandbox)) return text(`sandbox must be ${SANDBOXES.join(' or ')}`, true);
    if (a.model !== undefined && typeof a.model !== 'string') return text('model must be a string', true);
    const timeout = parseOptionalInt(args, 'timeout_minutes', 1, 240);
    if (!timeout.ok) return text(timeout.error, true);
    const r = await core.startCodingAgent({
      kind: a.kind as StartRequest['kind'],
      path: a.path,
      prompt: a.prompt,
      sandbox: a.sandbox as StartRequest['sandbox'],
      model: a.model as string | undefined,
      timeoutMinutes: timeout.value,
    });
    return text(r, !r.ok);
  },
};

const listTool: Tool = {
  def: {
    name: 'list_coding_agents',
    title: 'Coding agent runs',
    description:
      'Runs of start_coding_agent on this host, newest first: id, kind, worktree, state (running, succeeded, failed, stopped, ' +
      'timed-out, lost), exit code, event counts, commands, changed files and the last error. No prompt and no final text: ' +
      'read those with coding_agent_output.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Only this run' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const a = (args ?? {}) as { id?: unknown };
    if (a.id !== undefined && typeof a.id !== 'string') return text('id must be a string', true);
    return text(await core.listCodingAgents(a.id as string | undefined));
  },
};

const outputTool: Tool = {
  def: {
    name: 'coding_agent_output',
    title: 'Progress and answer of a coding agent run',
    description:
      'Read a run started by start_coding_agent: its state, a summary, compact progress lines (commands, messages, file ' +
      'changes, errors) for events from `after`, and the final answer once there is one. Poll it until state is not ' +
      '`running`; pass `next` from the last result as `after` to get only new lines.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id start_coding_agent returned' },
        after: { type: 'integer', minimum: 0, description: 'First event to return (default 0): the `next` of the last result' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Most lines to return (default 50)' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const a = (args ?? {}) as { id?: unknown };
    if (typeof a.id !== 'string') return text('id must be a string', true);
    const after = parseOptionalInt(args, 'after', 0, Number.MAX_SAFE_INTEGER);
    if (!after.ok) return text(after.error, true);
    const limit = parseOptionalInt(args, 'limit', 1, 200);
    if (!limit.ok) return text(limit.error, true);
    const r = await core.codingAgentOutput(a.id, after.value, limit.value);
    return text(r, !r.ok);
  },
};

const stopTool: Tool = {
  def: {
    name: 'stop_coding_agent',
    title: 'Stop a coding agent run',
    description: 'Stop a running coding agent run started by start_coding_agent (SIGTERM, then SIGKILL after 10 seconds). Confirm with the user first unless they asked for it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const a = (args ?? {}) as { id?: unknown };
    if (typeof a.id !== 'string') return text('id must be a string', true);
    const r = await core.stopCodingAgent(a.id);
    return text(r, !r.ok);
  },
};

export const codingAgentsFeature: FeatureModule = {
  name: 'coding-agents',
  order: 1650,
  tools: [startTool, listTool, outputTool, stopTool],
  // The stdio server is a Claude session's child: its CLAUDE_* env tells owners.ts whose unit this is (#43).
  mcpCore: (): Partial<Core> => ({
    startCodingAgent: (req: StartRequest) => startCodingAgent(req, process.env),
    listCodingAgents: (id?: string) => listCodingAgents({ id }),
    codingAgentOutput: (id: string, after?: number, limit?: number) => codingAgentOutput(id, { after, limit }),
    stopCodingAgent: (id: string) => stopCodingAgent(id),
  }),
};
