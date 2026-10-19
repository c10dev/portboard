// Other machines' listening ports read over SSH with a read-only key: the Proxmox host and its containers
// (pveports.ts) and the desktop's Windows side (winports.ts). The results join the devices and usage; this module
// only keeps them fresh. 새로고침 asks for a sooner read through ServerContext.refreshHostPorts().
//
//   job host-ports: about once a minute, backing off while a read fails (sshread.ts decides; this only nudges)

import { pvePorts } from '../core/pveports.ts';
import { winPorts } from '../core/winports.ts';
import type { FeatureModule } from './types.ts';

export const hostPortsFeature: FeatureModule = {
  name: 'host-ports',
  jobs: [
    {
      name: 'host-ports',
      everyMs: 15_000,
      run: () => {
        pvePorts().refreshLater();
        winPorts().refreshLater();
      },
    },
  ],
  // the two SSH reads (sshread.ts)
  collectors: ['pve-ports', 'win-ports'],
};
