// 소유자 전용 쓰기 (#29) and 기록 (#30), the parts a client sees. The check itself is in the router (appRouter in
// router.ts, decisions in src/core/access.ts); every write goes into the audit log (src/core/audit.ts).
//
//   GET /api/whoami                  {login, source, owner, canWrite, reason?, device?, mode?, tailscale?}: the
//                                    dashboard disables its write buttons and says why when canWrite is false; device
//                                    ({addr, name?, id?}) is the tailnet node a serve or direct caller came from
//                                    (tailscale whois); mode "token" in token mode (#12: 설정 › 화면 then offers the
//                                    owner token field), tailscale false when Tailscale isn't running here (the
//                                    Tailscale-only controls are hidden)
//   GET /api/audit?port=&limit=      newest first (limit 1–500, default 50); with port, the entries for that port.
//                                    The owner only (#7): 403 {error: "owner only", reason} for anyone else. Every
//                                    other read stays open to the tailnet.

import { classify, resolveCaller } from '../core/access.ts';
import { deviceOf } from '../core/audit.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule } from './types.ts';

export const accessFeature: FeatureModule = {
  name: 'access',
  order: 2700,
  routes: [
    {
      method: 'GET',
      path: '/api/whoami',
      async handler({ req }, ctx) {
        const policy = await ctx.policy();
        const c = await resolveCaller(req, { ...ctx, policy: async () => policy });
        const device = deviceOf(c.device);
        return ok({
          login: c.login,
          source: c.source,
          owner: c.owner,
          canWrite: c.canWrite,
          ...(c.reason ? { reason: c.reason } : {}),
          ...(device ? { device } : {}),
          ...(policy.mode === 'token' ? { mode: 'token' } : {}),
          ...(ctx.ts.available ? {} : { tailscale: false }),
        });
      },
    },
    {
      method: 'GET',
      path: '/api/audit',
      async handler({ url, req }, ctx) {
        // Who changed what, from which device and when is the owner's business, not every tailnet peer's. The same
        // owner decision as writes (classify), without the device lookup: owner rights don't depend on the device, and
        // the write-device allowlist limits writes only.
        const c = classify(req, await ctx.owner(), await ctx.policy());
        if (!c.owner) return reply(403, { error: 'owner only', reason: c.reason ?? '' });
        const p = url.searchParams.get('port');
        const l = url.searchParams.get('limit');
        const port = p === null || p === '' ? undefined : Number(p);
        if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return reply(400, { error: 'port must be 1–65535' });
        const limit = l === null || l === '' ? 50 : Number(l);
        if (!(Number.isInteger(limit) && limit >= 1 && limit <= 500)) return reply(400, { error: 'limit must be 1–500' });
        return ok({ entries: await ctx.audit.query({ port, limit }) });
      },
    },
  ],
  ui: [{ pages: ['index.html'], script: 'features/audit.js' }],
  // Denials still being counted (audit.ts coalesces repeats per minute) are written before exit.
  shutdown: (ctx) => ctx.audit.flush().catch((err) => console.error(`[portboard] audit: ${err}`)),
};
