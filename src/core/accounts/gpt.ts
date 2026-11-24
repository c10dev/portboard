// The GPT lane of the accounts proxy (docs/accounts.md#gpt-lane): a Claude Code request (Anthropic Messages) for a model the
// owner listed is converted to an OpenAI Responses request, and the answer (a Responses SSE stream from chatgpt.com's Codex
// endpoint) is converted back to Anthropic Messages (SSE or one JSON message). This file only converts: it opens no socket,
// reads no file and writes no log.
//
// Written from the Anthropic Messages and OpenAI Responses API docs, a capture of Claude Code 2.1.330 requests and of
// chatgpt.com Codex answers (2026-11-24). No code is copied from other converters.
//
// No token, key, account id, header value, body or query string is put into an error text: a ConvertError holds a closed
// text, and the texts of an upstream error are cut (`clip`) before they are used.

import { createHash, randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Transform } from 'node:stream';

export interface GptConfig {
  enabled: boolean;
  /** the model name of a request -> the upstream GPT model */
  models: Record<string, string>;
}

/** A GPT model id that may go upstream (the same rule as the `proxy.gpt.models` values in site.ts) */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODEX_PREFIX = 'codex/';

/** The upstream GPT model for a request's `model`, or null when the lane does not take it */
export function routeModel(model: unknown, cfg: GptConfig): string | null {
  if (!cfg.enabled || typeof model !== 'string') return null;
  if (Object.hasOwn(cfg.models, model)) return cfg.models[model];
  if (model.startsWith(CODEX_PREFIX)) {
    const rest = model.slice(CODEX_PREFIX.length);
    if (MODEL_ID.test(rest)) return rest;
  }
  return null;
}

/** A request the converter cannot read. The message is a closed text, never a part of the request. */
export class ConvertError extends Error {}

/** One SSE event: `response.completed` repeats the instructions, the tools and the whole output, so it can be large */
const MAX_EVENT_CHARS = 32 * 1024 * 1024;
const MAX_ERROR_CHARS = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const SECRETS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
  /\b(?:org|user|acct|account|proj|sess|req|resp|call|fc|msg)[-_][A-Za-z0-9_-]{6,}/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /[A-Za-z0-9_\-+/=.]{24,}/g,
];

/**
 * An upstream text for a client message. Control characters out; an e-mail address, an id (org-, user-, ...), a UUID and any
 * run of 24 or more token characters become `[redacted]`; 500 characters at most (clip.ts adds an ellipsis, this does not).
 */
export function clipText(s: unknown): string {
  if (typeof s !== 'string') return 'upstream error';
  let t = s.replace(/[\u0000-\u001f\u007f]/g, '');
  for (const re of SECRETS) t = t.replace(re, '[redacted]');
  return t.slice(0, MAX_ERROR_CHARS);
}

// ---- tool names ----

const VALID_TOOL = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ToolNames {
  toUpstream(name: string): string;
  fromUpstream(name: string): string;
}

/** One per request: OpenAI takes `^[a-zA-Z0-9_-]{1,64}$`; another name is shortened to a name that is the same every time, and mapped back for the answer */
export function toolNames(): ToolNames {
  const up = new Map<string, string>();
  const down = new Map<string, string>();
  return {
    toUpstream(name) {
      if (VALID_TOOL.test(name)) return name;
      let mapped = up.get(name);
      if (mapped === undefined) {
        mapped = `${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 55)}_${sha(name).slice(0, 8)}`;
        up.set(name, mapped);
        down.set(mapped, name);
      }
      return mapped;
    },
    fromUpstream: (name) => down.get(name) ?? name,
  };
}

// ---- request ----

/** The text of a `system` value or of a message's content: a string, or the text blocks joined with `sep` */
function textOf(v: unknown, sep: string, skip?: string): string {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  return v
    .filter((b): b is Obj => isObj(b) && b.type === 'text' && typeof b.text === 'string' && !(skip && (b.text as string).startsWith(skip)))
    .map((b) => b.text as string)
    .join(sep);
}

/** An Anthropic image block as an OpenAI `input_image`, or null for a source that is neither base64 nor a URL */
function imagePart(b: Obj): Obj | null {
  const s = isObj(b.source) ? b.source : null;
  if (!s) return null;
  if (s.type === 'base64' && typeof s.media_type === 'string' && typeof s.data === 'string') return { type: 'input_image', image_url: `data:${s.media_type};base64,${s.data}` };
  if (s.type === 'url' && typeof s.url === 'string') return { type: 'input_image', image_url: s.url };
  return null;
}

function documentPart(b: Obj): Obj {
  const s = isObj(b.source) ? b.source : null;
  if (s?.type === 'base64' && s.media_type === 'application/pdf' && typeof s.data === 'string') return { type: 'input_file', filename: 'document.pdf', file_data: `data:application/pdf;base64,${s.data}` };
  if (s?.type === 'text' && typeof s.data === 'string') return { type: 'input_text', text: s.data };
  return { type: 'input_text', text: '[document omitted]' };
}

const omitted = (type: unknown): Obj => ({ type: 'input_text', text: `[${(typeof type === 'string' ? type : 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)} block omitted]` });

/** The names of the tools that a `tool_reference` block (inside a tool result) loaded */
function referencedTools(messages: unknown[]): Set<string> {
  const out = new Set<string>();
  const scan = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (!isObj(b)) continue;
      if (b.type === 'tool_reference' && typeof b.tool_name === 'string') out.add(b.tool_name);
      else if (b.type === 'tool_result') scan(b.content);
    }
  };
  for (const m of messages) if (isObj(m)) scan(m.content);
  return out;
}

/** A tool result as the `output` text, and the images inside it */
function toolOutput(b: Obj): { output: string; images: Obj[] } {
  const images: Obj[] = [];
  let output = '';
  if (typeof b.content === 'string') output = b.content;
  else if (Array.isArray(b.content)) {
    const lines: string[] = [];
    for (const c of b.content) {
      if (!isObj(c)) continue;
      if (c.type === 'text' && typeof c.text === 'string') lines.push(c.text);
      else if (c.type === 'tool_reference' && typeof c.tool_name === 'string') lines.push(`Tool loaded: ${c.tool_name}`);
      else if (c.type === 'image') {
        const p = imagePart(c);
        if (p) images.push(p);
      }
    }
    output = lines.join('\n');
  }
  return { output: b.is_error === true ? `Error: ${output}` : output, images };
}

/** Claude Code sends this system block first; it is for Anthropic only */
const BILLING_HEADER = 'x-anthropic-billing-header:';

const EFFORTS: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', minimal: 'minimal', xhigh: 'high', max: 'high' };

function reasoningOf(body: Obj): { effort: string } | undefined {
  const oc = isObj(body.output_config) ? body.output_config : null;
  const effort = typeof oc?.effort === 'string' && Object.hasOwn(EFFORTS, oc.effort) ? EFFORTS[oc.effort] : null;
  if (effort) return { effort };
  const th = isObj(body.thinking) ? body.thinking : null;
  return th?.type === 'enabled' || th?.type === 'adaptive' ? { effort: 'medium' } : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session id the lane sends as `session-id` and `prompt_cache_key` (chatgpt.com caches a prompt per session): the client's
 * `x-claude-code-session-id` when it is a UUID, else a UUID-shaped hash of `metadata.user_id` (the raw value never goes up),
 * else null.
 */
export function sessionIdOf(header: unknown, body: unknown): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (typeof h === 'string' && UUID.test(h)) return h.toLowerCase();
  const user = isObj(body) && isObj(body.metadata) ? str(body.metadata.user_id) : null;
  if (!user) return null;
  const x = sha(user);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** An Anthropic Messages body (parsed JSON) as an OpenAI Responses body. A new object, built from known fields only. */
export function toResponsesRequest(body: unknown, upstreamModel: string, names: ToolNames, sessionId?: string | null): Record<string, unknown> {
  if (!isObj(body)) throw new ConvertError('request is not a JSON object');
  if (!Array.isArray(body.messages)) throw new ConvertError('messages must be an array');
  const messages: unknown[] = body.messages;
  const input: Obj[] = [];

  for (const m of messages) {
    if (!isObj(m)) continue;
    const c = m.content;
    if (m.role === 'user') {
      let pending: Obj[] = [];
      const flush = (): void => {
        if (pending.length) input.push({ type: 'message', role: 'user', content: pending });
        pending = [];
      };
      if (typeof c === 'string') {
        if (c !== '') pending.push({ type: 'input_text', text: c });
      }
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (!isObj(b)) continue;
          if (b.type === 'text') {
            if (typeof b.text === 'string') pending.push({ type: 'input_text', text: b.text });
          } else if (b.type === 'image') pending.push(imagePart(b) ?? omitted('image'));
          else if (b.type === 'document') pending.push(documentPart(b));
          else if (b.type === 'tool_result') {
            flush();
            if (typeof b.tool_use_id !== 'string') continue;
            const r = toolOutput(b);
            input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: r.output });
            if (r.images.length) input.push({ type: 'message', role: 'user', content: r.images });
          } else pending.push(omitted(b.type));
        }
      }
      flush();
    } else if (m.role === 'assistant') {
      let pending: Obj[] = [];
      const flush = (): void => {
        if (pending.length) input.push({ type: 'message', role: 'assistant', content: pending });
        pending = [];
      };
      if (typeof c === 'string') {
        if (c !== '') pending.push({ type: 'output_text', text: c });
      }
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (!isObj(b)) continue;
          if (b.type === 'text') {
            if (typeof b.text === 'string') pending.push({ type: 'output_text', text: b.text });
          } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
            flush();
            input.push({ type: 'function_call', call_id: b.id, name: names.toUpstream(b.name), arguments: JSON.stringify(b.input ?? {}) });
          }
        }
      }
      flush();
    } else if (m.role === 'system') {
      const text = textOf(c, '\n\n');
      if (text !== '') input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
    }
  }

  const out: Obj = { model: upstreamModel };
  const instructions = textOf(body.system, '\n\n', BILLING_HEADER);
  if (instructions !== '') out.instructions = instructions;
  out.input = input;

  if (Array.isArray(body.tools)) {
    const loaded = referencedTools(messages);
    const tools: Obj[] = [];
    for (const t of body.tools) {
      if (!isObj(t) || typeof t.name !== 'string' || !isObj(t.input_schema)) continue;
      if (t.defer_loading === true && !loaded.has(t.name)) continue;
      tools.push({ type: 'function', name: names.toUpstream(t.name), description: typeof t.description === 'string' ? t.description : '', parameters: t.input_schema, strict: false });
    }
    if (tools.length) out.tools = tools;
  }

  const tc = isObj(body.tool_choice) ? body.tool_choice : null;
  if (tc) {
    const listed = (n: string): boolean => (out.tools as Obj[] | undefined)?.some((t) => t.name === names.toUpstream(n)) === true;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'tool' && typeof tc.name === 'string' && listed(tc.name)) out.tool_choice = { type: 'function', name: names.toUpstream(tc.name) };
    if (tc.disable_parallel_tool_use === true) out.parallel_tool_calls = false;
  }

  const reasoning = reasoningOf(body);
  if (reasoning) out.reasoning = reasoning;
  if (sessionId) out.prompt_cache_key = sessionId;
  out.stream = true;
  out.store = false;
  return out;
}

// ---- answer ----

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function usageOf(resp: Obj): { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } {
  const u = isObj(resp.usage) ? resp.usage : {};
  const cached = num(isObj(u.input_tokens_details) ? u.input_tokens_details.cached_tokens : 0);
  return { input_tokens: Math.max(0, num(u.input_tokens) - cached), output_tokens: num(u.output_tokens), cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

function stopReasonOf(resp: Obj, sawTool: boolean): string {
  if (sawTool) return 'tool_use';
  const why = isObj(resp.incomplete_details) ? resp.incomplete_details.reason : null;
  if (resp.status === 'incomplete' && why === 'max_output_tokens') return 'max_tokens';
  return why === 'content_filter' ? 'refusal' : 'end_turn';
}

const messageId = (resp: Obj): string => `msg_${typeof resp.id === 'string' && resp.id !== '' ? resp.id.replace(/^resp_/, '') : randomBytes(12).toString('hex')}`;

/** An OpenAI Response object as an Anthropic Message object */
export function fromResponse(resp: unknown, requestedModel: string, names: ToolNames): Record<string, unknown> {
  const r = isObj(resp) ? resp : {};
  const content: Obj[] = [];
  let sawTool = false;
  for (const item of Array.isArray(r.output) ? r.output : []) {
    if (!isObj(item)) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const p of item.content) {
        if (!isObj(p)) continue;
        if (p.type === 'output_text' && typeof p.text === 'string') content.push({ type: 'text', text: p.text });
        else if (p.type === 'refusal' && typeof p.refusal === 'string') content.push({ type: 'text', text: p.refusal });
      }
    } else if (item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
      sawTool = true;
      let input: Obj = {};
      try {
        const parsed: unknown = JSON.parse(typeof item.arguments === 'string' ? item.arguments : '');
        if (isObj(parsed)) input = parsed;
      } catch {
        // not JSON: an empty input
      }
      content.push({ type: 'tool_use', id: item.call_id, name: names.fromUpstream(item.name), input });
    }
  }
  return { id: messageId(r), type: 'message', role: 'assistant', model: requestedModel, content, stop_reason: stopReasonOf(r, sawTool), stop_sequence: null, usage: usageOf(r) };
}

type Open = { kind: 'text'; key: string } | { kind: 'tool'; itemId: string; sentArgs: boolean };

/**
 * An OpenAI Responses SSE stream in, an Anthropic Messages SSE stream out. It never throws: an event it cannot read is
 * skipped. It keeps the last Response of `response.completed` / `response.incomplete` (`finalResponse`) and the text of an
 * error (`failure`), which the proxy needs when the client asked for no stream.
 */
export class ResponsesToMessages extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private data: string[] = [];
  private dataSize = 0;
  private skipping = false;
  private discarding = false;

  private started = false;
  private index = -1;
  private open: Open | null = null;
  private sawTool = false;
  private finished = false;
  private final: unknown = null;
  private failed: string | null = null;

  private readonly requestedModel: string;
  private readonly names: ToolNames;

  constructor(requestedModel: string, names: ToolNames) {
    super();
    this.requestedModel = requestedModel;
    this.names = names;
  }

  /** The `response` of the last `response.completed` / `response.incomplete`, or null */
  finalResponse(): unknown | null {
    return this.final;
  }

  /** The message of a `response.failed` or `error` event ("codex: ..."), or null */
  failure(): string | null {
    return this.failed;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      this.feed(this.decoder.write(chunk));
    } catch {
      // a stream that cannot be read ends early; the bytes of the rest are skipped
    }
    cb();
  }

  override _flush(cb: (err?: Error | null) => void): void {
    try {
      this.feed(this.decoder.end());
      if (this.pending !== '' && !this.discarding) this.line(this.pending.replace(/\r$/, ''));
      this.pending = '';
      this.dispatch();
      if (!this.finished) {
        this.close();
        this.emit_('error', { type: 'error', error: { type: 'api_error', message: 'codex stream ended early' } });
        this.finished = true;
      }
    } catch {
      // nothing more to say
    }
    cb();
  }

  private feed(text: string): void {
    let from = 0;
    while (from < text.length) {
      const nl = text.indexOf('\n', from);
      if (this.discarding) {
        if (nl < 0) return;
        this.discarding = false;
        from = nl + 1;
        continue;
      }
      if (nl < 0) {
        this.pending += text.slice(from);
        if (this.pending.length > MAX_EVENT_CHARS) {
          this.pending = '';
          this.discarding = true;
        }
        return;
      }
      this.line((this.pending + text.slice(from, nl)).replace(/\r$/, ''));
      this.pending = '';
      from = nl + 1;
    }
  }

  private line(l: string): void {
    if (l === '') return this.dispatch();
    if (!l.startsWith('data:')) return;
    if (this.skipping) return;
    const v = l.slice(5).replace(/^ /, '');
    this.dataSize += v.length + 1;
    if (this.dataSize > MAX_EVENT_CHARS) {
      this.data = [];
      this.dataSize = 0;
      this.skipping = true;
      return;
    }
    this.data.push(v);
  }

  private dispatch(): void {
    if (this.skipping) {
      this.skipping = false;
      return;
    }
    if (!this.data.length) return;
    const text = this.data.join('\n');
    this.data = [];
    this.dataSize = 0;
    let ev: unknown;
    try {
      ev = JSON.parse(text);
    } catch {
      return;
    }
    if (isObj(ev)) this.handle(ev);
  }

  private emit_(type: string, data: Obj): void {
    this.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private start(resp: unknown): void {
    if (this.started) return;
    this.started = true;
    this.emit_('message_start', {
      type: 'message_start',
      message: { id: messageId(isObj(resp) ? resp : {}), type: 'message', role: 'assistant', model: this.requestedModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }

  private close(): void {
    if (!this.open) return;
    this.emit_('content_block_stop', { type: 'content_block_stop', index: this.index });
    this.open = null;
  }

  private text(key: string, delta: unknown): void {
    if (typeof delta !== 'string') return;
    this.start(null);
    if (this.open?.kind !== 'text' || this.open.key !== key) {
      this.close();
      this.index++;
      this.emit_('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } });
      this.open = { kind: 'text', key };
    }
    this.emit_('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: delta } });
  }

  private fail(message: unknown): void {
    this.close();
    const text = `codex: ${clipText(message)}`;
    this.failed = text;
    this.emit_('error', { type: 'error', error: { type: 'api_error', message: text } });
    this.finished = true;
  }

  private handle(ev: Obj): void {
    if (this.finished) return;
    const type = ev.type;
    const item = isObj(ev.item) ? ev.item : null;
    switch (type) {
      case 'response.created':
        this.start(ev.response);
        return;
      case 'response.output_text.delta':
        return this.text(`${String(ev.item_id)}:${String(ev.content_index)}`, ev.delta);
      case 'response.refusal.delta':
        return this.text(`${String(ev.item_id)}:${String(ev.content_index)}`, ev.delta);
      case 'response.output_item.added':
        if (item?.type !== 'function_call') return;
        this.start(null);
        this.close();
        this.index++;
        this.sawTool = true;
        this.emit_('content_block_start', {
          type: 'content_block_start',
          index: this.index,
          content_block: { type: 'tool_use', id: str(item.call_id) ?? '', name: this.names.fromUpstream(str(item.name) ?? ''), input: {} },
        });
        this.open = { kind: 'tool', itemId: str(item.id) ?? '', sentArgs: false };
        return;
      case 'response.function_call_arguments.delta':
        if (this.open?.kind === 'tool' && ev.item_id === this.open.itemId && typeof ev.delta === 'string') {
          this.emit_('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: ev.delta } });
          this.open.sentArgs = true;
        }
        return;
      case 'response.output_item.done':
        if (item?.type === 'function_call' && this.open?.kind === 'tool' && item.id === this.open.itemId) {
          if (!this.open.sentArgs && typeof item.arguments === 'string' && item.arguments !== '') {
            this.emit_('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: item.arguments } });
          }
          this.close();
        } else if (item?.type === 'message' && this.open?.kind === 'text' && typeof item.id === 'string' && this.open.key.startsWith(`${item.id}:`)) this.close();
        return;
      case 'response.output_text.done':
      case 'response.content_part.done':
        if (this.open?.kind === 'text' && this.open.key === `${String(ev.item_id)}:${String(ev.content_index)}`) this.close();
        return;
      case 'response.completed':
      case 'response.incomplete': {
        const resp = isObj(ev.response) ? ev.response : {};
        this.final = resp;
        this.start(resp);
        this.close();
        this.emit_('message_delta', { type: 'message_delta', delta: { stop_reason: stopReasonOf(resp, this.sawTool), stop_sequence: null }, usage: usageOf(resp) });
        this.emit_('message_stop', { type: 'message_stop' });
        this.finished = true;
        return;
      }
      case 'response.failed': {
        const err = isObj(ev.response) && isObj(ev.response.error) ? ev.response.error.message : null;
        return this.fail(err);
      }
      case 'error':
        return this.fail(ev.message);
      default:
      // reasoning, in_progress, metadata, content_part.added, function_call_arguments.done: nothing to send
    }
  }
}
