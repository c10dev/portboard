// MCP prompts: ready-made requests the user picks in the client (Claude Code: /mcp__portboard__<name>; Claude
// Desktop and claude.ai: the + / attach menu). prompts/get does no I/O: it returns instructions in the server's
// language (core/i18n.ts) that name the tools to call, so the text is the same in every client and needs nothing to
// redact. Names are ASCII because they become slash commands; titles are in the server's language.

import { RpcError } from './kit.ts';
import { t } from '../core/i18n.ts';

export interface PromptArg {
  name: string;
  title?: string;
  description: string;
  required: boolean;
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  /** Arguments are already checked; values are trimmed and non-empty, or absent. */
  text(args: Record<string, string>): string;
}

export interface PromptResult {
  description: string;
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
}

// Titles, descriptions and texts are read when a client lists or gets a prompt (getters), in the server's language.
export const PROMPTS: PromptDef[] = [
  {
    name: 'server_status_summary',
    get title() {
      return t('prompts.status.title');
    },
    get description() {
      return t('prompts.status.desc');
    },
    arguments: [],
    text: () => t('prompts.status.text'),
  },
  {
    name: 'port_cleanup',
    get title() {
      return t('prompts.cleanup.title');
    },
    get description() {
      return t('prompts.cleanup.desc');
    },
    get arguments() {
      return [{ name: 'days', title: t('prompts.cleanup.arg.days'), description: t('prompts.cleanup.arg.days.desc'), required: false }];
    },
    text: (a) => t('prompts.cleanup.text', { days: a.days ?? '7' }),
  },
  {
    name: 'new_dev_server',
    get title() {
      return t('prompts.newDev.title');
    },
    get description() {
      return t('prompts.newDev.desc');
    },
    get arguments() {
      return [
        { name: 'project', title: t('prompts.newDev.arg.project'), description: t('prompts.newDev.arg.project.desc'), required: false },
        { name: 'preferred', title: t('prompts.newDev.arg.preferred'), description: t('prompts.newDev.arg.preferred.desc'), required: false },
      ];
    },
    text: (a) =>
      [
        a.project ? t('prompts.newDev.leadProject', { project: a.project }) : t('prompts.newDev.lead'),
        '',
        t('prompts.newDev.text', { args: a.preferred ? `preferred: ${a.preferred}` : '' }),
      ].join('\n'),
  },
  {
    name: 'why_not_open',
    get title() {
      return t('prompts.why.title');
    },
    get description() {
      return t('prompts.why.desc');
    },
    get arguments() {
      return [
        { name: 'port', title: 'port', description: t('prompts.why.arg.port.desc'), required: true },
        { name: 'from', title: t('prompts.why.arg.from'), description: t('prompts.why.arg.from.desc'), required: false },
      ];
    },
    text: (a) =>
      [
        a.from ? t('prompts.why.leadFrom', { port: a.port, from: a.from }) : t('prompts.why.lead', { port: a.port }),
        '',
        t('prompts.why.steps', { port: a.port }),
        a.from ? t('prompts.why.step5From', { port: a.port, from: a.from }) : t('prompts.why.step5', { port: a.port }),
        '',
        t('prompts.why.end'),
      ].join('\n'),
  },
];

// Numeric arguments by name, whichever prompt has them.
const RANGES: Record<string, { min: number; max: number }> = { port: { min: 1, max: 65535 }, preferred: { min: 1024, max: 65535 }, days: { min: 1, max: 30 } };

/** prompts/list entry: the definition without its text function. */
export const describe = (p: PromptDef) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments });

/**
 * Checks arguments against a prompt's definition. Values must be strings (MCP sends them as strings); an empty
 * string counts as absent (some clients send "" for a field left blank). Throws RpcError -32602.
 */
export function checkArgs(p: PromptDef, raw: unknown): Record<string, string> {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new RpcError(-32602, 'arguments must be an object');
  const given = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(given)) {
    const def = p.arguments.find((a) => a.name === k);
    if (!def) throw new RpcError(-32602, `unknown argument for ${p.name}: ${k.slice(0, 40)}`);
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' && typeof v !== 'number') throw new RpcError(-32602, `${k} must be a string`);
    const s = String(v).trim();
    if (!s) continue;
    if (s.length > 200) throw new RpcError(-32602, `${k} is too long (max 200 characters)`);
    const range = RANGES[k];
    if (range && (!/^\d{1,5}$/.test(s) || Number(s) < range.min || Number(s) > range.max)) {
      throw new RpcError(-32602, `${k} must be an integer between ${range.min} and ${range.max} (got ${JSON.stringify(s.slice(0, 20))})`);
    }
    out[k] = range ? String(Number(s)) : s.replace(/\s+/g, ' ');
  }
  for (const a of p.arguments) if (a.required && !(a.name in out)) throw new RpcError(-32602, `missing required argument: ${a.name}`);
  return out;
}

export function getPrompt(name: unknown, args: unknown, prompts: PromptDef[] = PROMPTS): PromptResult {
  if (typeof name !== 'string') throw new RpcError(-32602, 'params.name must be a string');
  const p = prompts.find((x) => x.name === name);
  if (!p) throw new RpcError(-32602, `unknown prompt: ${name.slice(0, 64)}`);
  const text = p.text(checkArgs(p, args));
  return { description: p.title, messages: [{ role: 'user', content: { type: 'text', text } }] };
}
