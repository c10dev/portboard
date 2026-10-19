# compute-pool (optional)

compute-pool is a separate, private tool that runs jobs on a few machines (this server, a desktop, a Mac) and keeps
a monitor of their health. Portboard does not need it: without one, the 기기 tab lists tailnet devices from
`tailscale status`, the Proxmox tree and the SSH port readers as usual, and the setup checklist's Mac agent step stays
a warning you can ignore.

When a monitor answers, Portboard reads it and nothing else: it never starts, stops or reconfigures a pool host. Any
program that serves the same JSON can stand in for it.

## What Portboard reads

`GET <poolUrl>/api/hosts` on the monitor, every 10 s at most (1.5 s timeout). `poolUrl` comes from
`PORTBOARD_POOL_URL`, else `portboard.json`'s `poolUrl`, else `http://127.0.0.1:7720` ([config.md](../config.md)).

```json
{
  "version": 1,
  "healthAt": 1792385956604,
  "hosts": [
    {
      "name": "desktop",
      "kind": "ssh",
      "addresses": ["192.168.1.7"],
      "state": "ok",
      "inRotation": true,
      "since": 1792061944919,
      "checkedAt": 1792385956604,
      "detail": "ok",
      "slots": 3,
      "busy": 0,
      "cores": 16,
      "load1": 0.06,
      "cpuPct": 0,
      "memTotalMb": 24033,
      "memAvailMb": 21839,
      "diskFreePct": 87,
      "runners": { "active": 4, "total": 4 },
      "last24h": { "runs": 12, "failed": 1, "runMin": 40.5, "avgWaitSec": 0.4 },
      "listening": [{ "port": 2222, "address": "0.0.0.0", "process": "sshd" }],
      "listeningAt": 1792385956604
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Must be `1`; anything else is reported as unsupported and the monitor counts as unavailable |
| `healthAt` | no | ms, when the monitor last checked its hosts |
| `hosts[].name` | yes | The pool's name for the host (`desktop`, `mac`…) |
| `hosts[].kind` | yes | `local` (this server), `ssh` (reached over SSH) or `agent` (a worker that connects in) |
| `hosts[].addresses` | no | IPs or host names without ports: the SSH target, or an agent's connecting address |
| `hosts[].state` | yes | `ok`, `degraded`, `wsl-down`, `host-down`, `auth`, `agent-away`, `agent-busy` or `unknown`. `degraded`, `wsl-down`, `host-down` and `auth` count as problems (the ⚠ in the menu bar and the Mac app); `agent-busy` is normal |
| `hosts[].inRotation`, `slots`, `busy` | yes | Whether the host takes jobs, how many at once, how many it runs now |
| `hosts[].since`, `checkedAt`, `detail` | no | ms of the last state change and check; a short status text |
| `hosts[].cores`, `load1`, `cpuPct`, `memTotalMb`, `memAvailMb`, `diskFreePct` | no | Load figures for the device card |
| `hosts[].runners` | no | `{active, total}` job runners |
| `hosts[].agent` | no | Agent hosts: `{connected, available, why?}` |
| `hosts[].last24h` | no | `{runs, failed, runMin, avgWaitSec}` |
| `hosts[].listening`, `listeningAt` | no | The host's listening TCP sockets (`port`, `address` without brackets, `process` when known) and when they were read (ms). Both or neither; an empty list with `listeningAt` means none. The 기기 card then lists that host's open ports |

Unknown fields are ignored. If `/api/hosts` answers 404, Portboard falls back to an older `GET /api/state`
(`hosts[].health` with the same figures) plus `hosts.json` in `COMPUTE_POOL_DIR` (default
`~/.local/state/compute-pool`) for the addresses.

## How a pool host finds its device card

In order: the `local` host is this server; a host whose `addresses` include a device's Tailscale IP; a
`deviceLinks` entry in `prefs.json` (`{"deviceLinks": {"desktop": "desktop-pc"}}`) for hosts the pool reaches over the
LAN. A host that matches nothing gets a card of its own ([dashboard.md](../dashboard.md#devices-strip)).

## Alerts

Down alerts, self-watch, 새 기기 and the digest are sent through the channel file compute-pool uses for its own alerts,
`~/.local/state/compute-pool/alerts.json` (`PORTBOARD_ALERT_CHANNEL`): `{"ntfy": {"server", "topic"}, "webhook":
{"url"}}`. The file can exist without compute-pool; see [the ntfy runbook](../runbooks/ntfy-topic.md).

## Mac agent

The setup checklist's Mac agent step looks for an `agent` host (or one named like `mac`) in `/api/hosts`. compute-pool
starts its agent with `cpool agent --coordinator <this server> --host mac`; with a different pool, connect the Mac
whichever way that tool does, or ignore the step.
