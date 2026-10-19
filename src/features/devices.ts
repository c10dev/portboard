// Devices: this server and the other tailnet devices, joined with compute-pool host status, Proxmox hosts and the
// other machines' listening ports (src/core/devices.ts).
//
//   GET /api/devices          (?fresh also re-reads the Proxmox host's and the desktop's ports soon)
//   MCP list_devices (also remote, redacted)

import { devices, type Devices } from '../core/devices.ts';
import { topology } from '../core/topology.ts';
import { lanClientsOf } from '../core/usage.ts';
import { SITE } from '../core/site.ts';
import { text } from '../mcp/kit.ts';
import { redactDevices } from '../remote/redact.ts';
import { ok } from './router.ts';
import type { FeatureModule } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    devices(): Promise<Devices>;
  }
}

export const devicesFeature: FeatureModule = {
  name: 'devices',
  routes: [
    {
      method: 'GET',
      path: '/api/devices',
      async handler({ url }, ctx) {
        if (url.searchParams.has('fresh')) ctx.refreshHostPorts();
        // the LAN clients connected now, so the tree lists them as the 기기 tab does (topology is cached 2 s)
        const lanClients = await ctx.topology().then(lanClientsOf, () => []);
        return ok(await devices({ lanClients }));
      },
    },
  ],
  tools: [
    {
      def: {
        name: 'list_devices',
        title: 'Devices and their status',
        description:
          'This server and the other devices on the Tailscale tailnet (online, last seen, direct or relayed path), joined ' +
          'with compute-pool host status where known: state (ok, degraded, wsl-down, host-down, agent-away, agent-busy), ' +
          'whether it takes jobs, CPU/load, memory, disk, busy slots and recent runs. Use it for "is the desktop up?", ' +
          '"how loaded is the server?" or before sending work to another machine. When a Proxmox token is configured, also ' +
          'the Proxmox hosts with their VMs/containers (vmid, running/stopped, CPU, memory) matched to these devices; read-only. ' +
          'For the other compute-pool hosts (desktop, mac), ports lists their listening TCP ports as compute-pool reports ' +
          'them: port, scope (all / tailnet: reachable over Tailscale; loopback: only inside that machine; other: a LAN or ' +
          'docker address), processes, and url (http://<tailscale name>:<port>) where it can be opened. ports is null when ' +
          'the host did not report them (an older Mac worker, a host that is down) and for this server (use list_ports).' +
          ` The Proxmox host (${SITE.pve.node}) and its running containers get ports the same way, read over a ` +
          'read-only SSH key (portsSource pve-ssh, also on proxmox.hosts[].ports and guests[].ports; lan=true means open it at ' +
          `its LAN address); pvePorts says whether that read works (error not-installed: the key is not set up on ${SITE.pve.node} yet). ` +
          `The desktop (${SITE.windows.device}) lists Windows and WSL ports together, each with side windows or wsl; winPorts is that read's status.` +
          ' tree is the network hierarchy: roots are the subnet routers and Proxmox hosts (kind host), each with its guests ' +
          '(kind guest: vmid, qemu/lxc, status, lanOnly when it has no Tailscale) and the LANs it routes (kind subnet: cidr, ' +
          'role primary or standby); a subnet lists the LAN machines in it with reach (tailnet: has its own Tailscale address; ' +
          'routed: only through that router; arp: only seen in this server\'s ARP table). Then the group "직접 연결" (the other ' +
          'tailnet devices, path direct or relay) and "그 밖의 LAN 기기" (LAN clients outside every routed subnet). Each device appears once.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      call: async (_args, core) => text(await core.devices()),
      remote: {
        description:
          'The Portboard server and the other devices on the owner\'s Tailscale network: online or not, last seen, direct or ' +
          'relayed, compute-pool state and load (CPU, memory, disk, busy slots, recent runs), and Proxmox hosts with their ' +
          'VMs/containers when configured. For the other compute-pool machines (desktop, mac), ports lists their listening ' +
          'TCP ports: port, scope (all / tailnet: reachable over Tailscale; loopback: only inside that machine; other) and a ' +
          'tailnet URL where one can be opened; null when the machine did not report them. Addresses are left out. Read-only.' +
          ' The Proxmox host and its running containers get ports the same way (portsSource pve-ssh); the desktop lists Windows and WSL ports together (side).' +
          ' tree is the network hierarchy: routers and Proxmox hosts with their guests (VM/CT) and the LANs they route, each ' +
          'LAN machine with how it is reached (tailnet, routed through the router, or arp only), then the other tailnet devices.',
        call: async (_args, core, policy) => text(redactDevices(await core.devices(), policy)),
      },
    },
  ],
  mcpCore: () => ({ devices: () => topology().then(lanClientsOf, () => []).then((lanClients) => devices({ lanClients })) }),
  // compute-pool host status (pool.ts) and the SSH host-key probe behind the devices' ssh links (hostkeys.ts)
  collectors: ['pool', 'hostkeys'],
};
