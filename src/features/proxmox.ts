// Proxmox: CPU/memory trends per node and guest from the Proxmox API's RRD data (src/core/pvetrends.ts). The hosts
// and guests themselves come with the devices (list_devices, GET /api/devices).
//
//   GET /api/proxmox/trends?timeframe=hour|day

import { proxmoxTrends, TIMEFRAMES, type Timeframe } from '../core/pvetrends.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule } from './types.ts';

export const proxmoxFeature: FeatureModule = {
  name: 'proxmox',
  order: 900,
  routes: [
    {
      method: 'GET',
      path: '/api/proxmox/trends',
      async handler({ url }) {
        const tf = (url.searchParams.get('timeframe') ?? 'hour') as Timeframe;
        if (!TIMEFRAMES.includes(tf)) return reply(400, { error: 'timeframe must be hour or day' });
        return ok(await proxmoxTrends(tf));
      },
    },
  ],
  // the Proxmox API itself (proxmox.ts)
  collectors: ['proxmox'],
};
