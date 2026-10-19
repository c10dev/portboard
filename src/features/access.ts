// 소유자 전용 쓰기 (#29) and 기록 (#30), the parts a client sees. The check itself is in the router (appRouter in
// router.ts, decisions in src/core/access.ts); every write goes into the audit log (src/core/audit.ts).
//
//   GET /api/whoami                  {login, source, owner, canWrite, reason?, device?}: the dashboard disables its
//                                    write buttons and says why when canWrite is false; device ({addr, name?, id?})
//                                    is the tailnet node a serve or direct caller came from (tailscale whois)
//   GET /api/audit?port=&limit=      newest first (limit 1–500, default 50); with port, the entries for that port

import { resolveCaller } from '../core/access.ts';
import { deviceOf } from '../core/audit.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule } from './types.ts';

export const accessFeature: FeatureModule = {
  name: 'access',
  routes: [
    {
      method: 'GET',
      path: '/api/whoami',
      async handler({ req }, ctx) {
        const c = await resolveCaller(req, ctx);
        const device = deviceOf(c.device);
        return ok({ login: c.login, source: c.source, owner: c.owner, canWrite: c.canWrite, ...(c.reason ? { reason: c.reason } : {}), ...(device ? { device } : {}) });
      },
    },
    {
      method: 'GET',
      path: '/api/audit',
      async handler({ url }, ctx) {
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
