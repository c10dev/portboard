// 원격 커넥터 (#31): the owner's view of who holds a token for the public read-only MCP (src/remote/), and revoking
// a client or one authorization. Tailnet-only: these routes live on the dashboard, never on the remote server.
// Reads and writes this profile's remote.json (a preview manages its own copy, never production's).
// The ids in the paths are the derived c-…/g-… ids (src/remote/admin.ts); they fit the router's `:device` slug
// pattern, so the routes use it rather than a parameter of their own.
//
//   GET  /api/remote/clients                {publicUrl, connectorUrl, pendingApproval, approvalExpiresAt, clients[], grants[]}
//                                           (no token values)
//   POST /api/remote/clients/<id>/revoke    every token of that client, and its registration
//   POST /api/remote/tokens/<id>/revoke     one authorization (access + refresh tokens)
//   POST /api/remote/approval-code          승인 코드 만들기: the same one-time code as `node src/remote.ts approve`
//                                           (10 min, single use, replaces a pending one) → {code, expiresAt, ttlMs,
//                                           replaced}. A guarded owner write like the revokes; the audit line and the
//                                           server log never hold the code. Dashboard only: no MCP tool, local or
//                                           remote, ever makes one.
//   ui   remote-connector.js on the 설정 page (원격 커넥터 section, settings.html#remote)

import { connectorView, revokeClient, revokeGrant } from '../remote/admin.ts';
import { Store } from '../remote/store.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule } from './types.ts';

// One Store per file: its in-process queue serializes this process's writes (the lock file covers the others).
const stores = new Map<string, Store>();
const storeFor = (path: string) => {
  let s = stores.get(path);
  if (!s) stores.set(path, (s = new Store(path)));
  return s;
};

/** The URL to paste into claude.ai or ChatGPT: remote.json's publicUrl + /mcp, null when it isn't public. */
export function connectorUrlOf(publicUrl: unknown): string | null {
  if (typeof publicUrl !== 'string' || !publicUrl) return null;
  try {
    const u = new URL(publicUrl);
    return u.protocol === 'https:' ? `${u.origin}/mcp` : null;
  } catch {
    return null;
  }
}

const unreadable = (err: unknown) => reply(500, { error: `remote.json을 읽을 수 없어요 (${err instanceof Error ? err.message.replace(/^.*: /, '') : 'error'})` });

export const remoteConnectorFeature: FeatureModule = {
  name: 'remote-connector',
  routes: [
    {
      method: 'GET',
      path: '/api/remote/clients',
      async handler(_r, ctx) {
        try {
          const s = await storeFor(ctx.paths.remoteConfig).read();
          return ok({ profile: ctx.paths.profile, connectorUrl: connectorUrlOf(s.publicUrl), ...connectorView(s) });
        } catch (err) {
          return unreadable(err);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/remote/clients/:device/revoke',
      write: true,
      async handler({ params }, ctx) {
        let out;
        try {
          out = await revokeClient(storeFor(ctx.paths.remoteConfig), params.device);
        } catch (err) {
          return unreadable(err);
        }
        if (!out) return reply(404, { error: '그런 클라이언트가 없어요' });
        console.error(`[portboard] remote connector: client ${params.device} revoked (${out.tokens} token(s))`);
        return ok({ revoked: out });
      },
    },
    {
      method: 'POST',
      path: '/api/remote/tokens/:device/revoke',
      write: true,
      async handler({ params }, ctx) {
        let out;
        try {
          out = await revokeGrant(storeFor(ctx.paths.remoteConfig), params.device);
        } catch (err) {
          return unreadable(err);
        }
        if (!out) return reply(404, { error: '그런 토큰이 없어요' });
        console.error(`[portboard] remote connector: authorization ${params.device} revoked (${out.tokens} token(s))`);
        return ok({ revoked: out });
      },
    },
    {
      method: 'POST',
      path: '/api/remote/approval-code',
      write: true,
      async handler(_r, ctx) {
        const store = storeFor(ctx.paths.remoteConfig);
        let out;
        try {
          const now = Date.now();
          const before = await store.read();
          const replaced = !!before.approval && typeof before.approval.expiresAt === 'number' && before.approval.expiresAt > now;
          const { code, expiresAt } = await store.newApprovalCode();
          await store.ensurePrivate();
          out = { code, expiresAt, ttlMs: Math.max(0, expiresAt - Date.now()), replaced };
        } catch (err) {
          return unreadable(err);
        }
        // Never the code itself: the answer is the only place it appears.
        console.error(`[portboard] remote connector: approval code created${out.replaced ? ' (replaced the pending one)' : ''}, valid until ${new Date(out.expiresAt).toISOString()}`);
        return ok(out);
      },
    },
  ],
  ui: [{ pages: ['#settings'], script: 'features/remote-connector.js' }],
};
