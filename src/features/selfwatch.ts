// Self-watch: Portboard watching its own collectors (a collector that keeps failing, a token about to expire) and
// alerting about them. Tracked with alerts off too; previews never send. Also the health endpoint deploys and
// compute-pool's monitor check.
//
//   GET /api/health            ({ok, profile, port}: production or a preview, see core/paths.ts; ?detail adds the
//                              self-watch: each collector's health, credential expiry, and memory pressure)
//   job selfwatch (every minute, the first look 20 s after start)
//   ui  selfwatch.js on the 서비스 and 기기 pages (header chip + dialog)

import { savedStatus, SELFWATCH_EVERY, SELFWATCH_FIRST, type SelfWatchStatus } from '../core/selfwatch.ts';
import { ok } from './router.ts';
import type { FeatureModule } from './types.ts';
import { runStats } from '../core/exec.ts';
import { scheduler } from './jobs.ts';
import { pressureNow } from './memory.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    /** The server's self-watch (selfwatch.json): collector health and credential expiry; null before its first check */
    collection?(): Promise<SelfWatchStatus | null>;
  }
}

/**
 * RSS next to the JS heap: RSS stays up for minutes after a scan's garbage is collected (V8 and malloc keep freed
 * pages), so rssMb alone reads like a leak; heapUsedMb is what is actually live.
 */
export function memoryMb(m: NodeJS.MemoryUsage = process.memoryUsage()) {
  const mb = (n: number) => Math.round(n / 2 ** 20);
  return { rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers) };
}

export const selfWatchFeature: FeatureModule = {
  name: 'selfwatch',
  order: 1100,
  routes: [
    {
      method: 'GET',
      path: '/api/health',
      async handler({ url }, ctx) {
        const base = { ok: true, profile: ctx.paths.profile, port: ctx.paths.port };
        return ok(url.searchParams.has('detail') ? { ...base, ...(await ctx.selfwatch.status()), memory: pressureNow(), runtime: { ...memoryMb(), uptimeSec: Math.round(process.uptime()), subprocesses: runStats(), jobs: scheduler()?.states() ?? [] } } : base);
      },
    },
  ],
  // Self-watch as the server last wrote it (selfwatch.json): which collectors fail, which credentials expire.
  mcpCore: () => ({ collection: () => savedStatus() }),
  jobs: [{ name: 'selfwatch', everyMs: SELFWATCH_EVERY, firstAfterMs: SELFWATCH_FIRST, run: (ctx) => ctx.selfwatch.tick() }],
  // in the shell's sidebar footer on every page (docs/layout/)
  ui: [{ pages: ['index.html', 'devices.html', 'dev.html', 'service.html'], script: 'features/selfwatch.js' }],
};
