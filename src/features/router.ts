// REST routing over the features' declared routes. Kept separate from server.ts so tests can drive it with a fake
// context: every write route goes through the same X-Portboard guard here, before its handler can run.
//
// Order of checks, as before the registry: path (404) → `:port` range (400 "bad port") → method (405) → guard
// (403) → read-only install (403, with a WriteGuard; #11) → owner (403, with a WriteGuard) → JSON body (400) → handler.
//
// The dashboard's router (appRouter, what server.ts uses) also checks who is calling (src/core/access.ts, #29) and
// writes every write — allowed, denied or failed — to the audit log (src/core/audit.ts, #30). createRouter without a
// guard is the bare router the unit tests drive with fake requests.

import type { IncomingMessage } from 'node:http';
import type { Reply, Route, RouteRequest } from './types.ts';
import type { ServerContext } from './context.ts';
import { randomBytes } from 'node:crypto';
import { resolveCaller, type Caller } from '../core/access.ts';
import { clean, deviceOf, record, targetOf, whoOf, type AuditEntry, type AuditLog, type Target } from '../core/audit.ts';
import { t } from '../core/i18n.ts';
import { platform } from '../core/platform/index.ts';

const TOKENS: Record<string, string> = {
  ':port': '(?<port>\\d{1,5})',
  ':device': '(?<device>[A-Za-z0-9][A-Za-z0-9-]{0,62})',
};

interface Compiled {
  route: Route;
  re: RegExp;
  params: boolean;
}

export function compile(route: Route): Compiled {
  let params = false;
  const src = route.path
    .split('/')
    .map((seg) => {
      if (TOKENS[seg]) {
        params = true;
        return TOKENS[seg];
      }
      if (seg.startsWith(':')) throw new Error(`route ${route.path}: unknown parameter ${seg}`);
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { route, re: new RegExp(`^${src}$`), params };
}

export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export const reply = (status: number, body: unknown): Reply => ({ status, body });
export const ok = (body: unknown): Reply => ({ status: 200, body });

/**
 * A 500 without the error's text (it can hold paths and command output): a generic Korean message and a short request
 * id, with the full error on stderr (journalctl --user -u portboard) under the same id.
 */
export function internalError(err: unknown, where: string): Reply {
  const requestId = randomBytes(4).toString('hex');
  console.error(`[portboard] 500 ${requestId} ${clean(where, 200)}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return reply(500, { error: t('errors.internal', { id: requestId }), requestId });
}

/**
 * A Tailscale-only write (expose, unexpose, the write-device allowlist) on a machine where `tailscale status` didn't
 * answer when the server started (#12): a 409 saying so, before anything runs. `message` too, for the port actions'
 * {ok, message} answers.
 */
export function tailscaleRequired(ctx: Pick<ServerContext, 'ts'>): Reply | null {
  if (ctx.ts.available) return null;
  const error = t('errors.tailscaleRequired');
  return reply(409, { ok: false, error, message: error });
}

/** Who may write, and where writes are recorded. */
export interface WriteGuard {
  caller(req: IncomingMessage): Promise<Caller>;
  record(e: AuditEntry): Promise<void>;
  /** Why every write is refused on this install (PORTBOARD_READ_ONLY, the Docker image; #11), or null */
  readOnly?(): string | null;
}

/** The answer's own short message, error, or why the caller may not write, for the audit line. */
function detailOf(r: Reply): string | undefined {
  const b = r.body as { message?: unknown; error?: unknown; reason?: unknown } | null;
  const d = typeof b?.reason === 'string' && b.reason ? b.reason : typeof b?.error === 'string' ? b.error : typeof b?.message === 'string' ? b.message : undefined;
  return d === undefined ? undefined : clean(d, 200);
}

/** A port the answer names (dev server started on, port reserved) when the request didn't. */
function withReplyPort(t: Target, r: Reply): Target {
  const p = (r.body as { port?: unknown } | null)?.port;
  return t.port === undefined && typeof p === 'number' && Number.isInteger(p) && p > 0 && p <= 65535 ? { ...t, port: p } : t;
}

export function createRouter(routes: Route[], guard?: WriteGuard) {
  const compiled = routes.map(compile);
  /** The reply, or null when no route has this path (static files and the 404 come next). */
  return async function route(req: IncomingMessage, url: URL, ctx: ServerContext): Promise<Reply | null> {
    const path = url.pathname;
    const hits = compiled.map((c) => ({ c, m: c.re.exec(path) })).filter((h) => h.m);
    if (!hits.length) return null;
    const groups = hits[0].m!.groups ?? {};
    const port = groups.port === undefined ? NaN : Number(groups.port);
    if (groups.port !== undefined && (port < 1 || port > 65535)) return reply(400, { error: 'bad port' });

    const hit = hits.find((h) => h.c.route.method === req.method);
    if (!hit) {
      // A read-only path without parameters never answered other methods; everything else says which one to use.
      if (hits.every((h) => h.c.route.method === 'GET' && !h.c.params)) return null;
      return reply(405, { error: `use ${hits[0].c.route.method}` });
    }
    const r = hit.c.route;
    const params = { port, device: groups.device ?? '' };
    if (r.method === 'GET') return r.handler({ url, params, body: undefined, req }, ctx);

    // The guard is checked for every non-GET route, whatever it declares.
    const caller = guard ? await guard.caller(req) : null;
    const log = (out: Reply, target: Target) =>
      caller && guard
        ? guard.record({
            at: new Date().toISOString(),
            who: whoOf(caller),
            source: caller.source,
            route: `${r.method} ${r.path}`,
            target,
            result: out.status === 403 ? 'denied' : out.status < 400 ? 'ok' : 'error',
            status: out.status,
            ...(detailOf(out) ? { detail: detailOf(out) } : {}),
            ...(deviceOf(caller.device) ? { device: deviceOf(caller.device) } : {}),
          })
        : Promise.resolve();
    if (req.headers['x-portboard'] !== '1') {
      const out = reply(403, { error: 'missing X-Portboard header' });
      await log(out, targetOf(params, null));
      return out;
    }
    const readOnly = guard?.readOnly?.() ?? null;
    if (readOnly) {
      const out = reply(403, { error: 'read-only', reason: readOnly });
      await log(out, targetOf(params, null));
      return out;
    }
    if (caller && !caller.canWrite) {
      // Denied before the body is read: nothing from a caller who may not write goes further than the route params.
      const out = reply(403, { error: 'owner only', reason: caller.reason ?? '' });
      await log(out, targetOf(params, null));
      return out;
    }
    let body: unknown;
    if (r.body) {
      try {
        body = JSON.parse((await readBody(req, r.body.limit)) || '{}');
      } catch {
        const out = reply(400, { error: 'invalid JSON body' });
        await log(out, targetOf(params, null));
        return out;
      }
    }
    let out: Reply;
    try {
      out = await r.handler({ url, params, body, req }, ctx);
    } catch (err) {
      // The error text stays in the server log: the answer and the audit line (readable by every tailnet peer) get
      // only a request id to find it by.
      const out = internalError(err, `${r.method} ${r.path}`);
      await log(out, targetOf(params, body));
      return out;
    }
    await log(out, withReplyPort(targetOf(params, body), out));
    return out;
  };
}

/**
 * The dashboard's router: createRouter with the owner check and the audit log from the server context. server.ts
 * uses only this (a test reads server.ts to make sure).
 */
export function appRouter(routes: Route[], ctx: Pick<ServerContext, 'owner' | 'device' | 'writeDevices' | 'policy' | 'audit'>) {
  return createRouter(routes, {
    caller: (req) => resolveCaller(req, ctx),
    record: (e) => record(ctx.audit, e),
    readOnly: () => {
      const p = platform();
      return p.readOnly ? t('errors.readOnly', { reason: p.readOnlyReason }) : null;
    },
  });
}
