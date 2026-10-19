# Multi-host: `portboard agent`

One Portboard install describes one server. Other machines used to show up only through compute-pool's `/api/hosts` or the Proxmox and Windows SSH readers, and the host picker could only list their ports. With **agent mode** (c10dev/portboard#10) each other machine runs a small, read-only `portboard agent`, and one board (the dashboard you already run) reads every agent it is told about.

```
 desk (Linux/WSL)      mac                 nas
 portboard agent       portboard agent     portboard agent       read-only JSON on :8797, tailnet only
        \                  |                  /
         \_________________|_________________/
                           |
                 devbox: portboard start          the board: 기기 tab, host picker, /api/devices
```

An agent needs no compute-pool, no SSH key and no dashboard of its own. Where both an agent and compute-pool report a machine's ports, the agent's list is used; compute-pool's load and rotation state still show on the card.

## On each machine: run the agent

```bash
npm i -g portboard
portboard agent                          # foreground, :8797 on 127.0.0.1 and this node's Tailscale IPv4
portboard install-service --agent        # or: a systemd user unit, portboard-agent.service, alone
```

Then say who may read it, in that machine's `~/.config/portboard/portboard.json`:

```json
{
  "agent": {
    "allow": ["devbox"],
    "port": 8797
  }
}
```

### Who may read

Checked in this order; the first that applies decides:

1. **Loopback.** A process on the agent's own machine (`curl http://127.0.0.1:8797/agent/v1/info`). A request that carries a proxy header (`tailscale serve` proxies from 127.0.0.1 too) does not count as loopback.
2. **Bearer token.** `Authorization: Bearer <token>` equal to `agent.token` or `PORTBOARD_AGENT_TOKEN`, compared in constant time. A token that is sent and wrong is refused with 401; it is never tried as anything else.
3. **Tailscale identity.** The caller's tailnet address is looked up with `tailscale whois` (cached per address; addresses outside 100.64.0.0/10 and fd7a:115c:a1e0::/48 are never looked up). It may read when `agent.allow` (or `PORTBOARD_AGENT_ALLOW`, a comma list, merged) names:
   - its node: the short or full MagicDNS name (`devbox`, `devbox.example.ts.net`) or its stable node ID (`nAbC123CNTRL`);
   - its login (`owner@example.com`), for an untagged node;
   - one of its ACL tags (`tag:portboard`).

With neither an allowlist nor a token only loopback reads, and the agent says so at start. Everything else gets `403 {"error":"not allowed"}`.

The Host header must be a name of the machine (its host name, MagicDNS name, Tailscale IPs, loopback): a DNS-rebinding page gets 421. The agent never binds a wildcard address; `PORTBOARD_AGENT_HOSTS` replaces the bind list (`127.0.0.1` alone for a test).

### What it serves

| Method | Path | |
|---|---|---|
| GET | `/agent/v1/info` | `{schema: 1, version, host, dnsName, at, load: {cores, load1, memTotalMb, memAvailMb, diskFreePct, uptimeSec}}` |
| GET | `/agent/v1/ports` | `{schema: 1, at, host, listening, services}`: `listening` is one row per bind address, `{port, address, process?}`, the shape compute-pool's `/api/hosts` uses; `services` is the remote connector's `list_ports` projection (names, kinds, HTTP titles, tailnet URLs), system ports included |
| GET | `/agent/v1/usage` | Who uses what on that machine, the remote connector's `who_uses_what` projection, plus `schema` |

Any other method is `405` (the agent is read-only); any other path `404`. Answers are `no-store`.

What never leaves the machine: pids, command lines, working directories, unit descriptions, ssh commands, MAC addresses, and LAN or docker addresses (they become `[lan-ip]` / `[ip]`). Bind addresses keep their class: `0.0.0.0`, `::`, loopback and the machine's own Tailscale IPs, which the board needs to tell "every interface" from "only on that device". `agent.showAddresses: true` keeps LAN addresses too, for a board that should link to them. A process is named by its container, its systemd unit or the first word of its command line without the path (`node`, never `node /home/…/server.js --token=…`).

The agent reads the snapshot and usage from that machine's own dashboard over loopback when one runs there (as the remote MCP server does, #5); otherwise it computes them itself, cached for 2 s (usage 5 s).

## On the board: list the agents

In the board's `portboard.json`:

```json
{
  "agents": [
    { "name": "desk", "url": "http://desk.example.ts.net:8797" },
    { "name": "mac", "url": "http://100.64.10.3:8797" },
    { "name": "nas", "url": "http://nas.example.ts.net:8797", "token": "…" }
  ]
}
```

- `name`: a host name (letters, digits, `.`, `_`, `-`), unique. It is matched to a tailnet device: first by the MagicDNS name the agent reports, then by the Tailscale IP in `url`, then by `name` or the host name the agent reports against the device's name. An agent that matches no device gets a card of its own (`agent:<name>`).
- `url`: `http` or `https`, no credentials in it; a trailing `/` is dropped.
- `token`: optional; sent only as `Authorization: Bearer` to that agent. Keep the file `0600` (it is under `~/.config/portboard/` by default). Without a token the board authenticates by its own Tailscale identity: put the board's node name in each agent's `agent.allow`.

The board reads `/agent/v1/info` and `/agent/v1/ports` from every agent at most every 10 s, when `/api/devices` or `/api/usage` is asked (새로고침 reads again at once). Each agent is independent:

- A failure is a fixed code, never the agent's own text: `unreachable`, `timeout`, `auth` (401/403), `http` (another status), `bad-answer` (not JSON, another `schema`, a missing field, over 4 MB).
- A failing agent backs off: 15 s, 30 s, 1 min … up to 5 min between tries.
- Its last good ports stay on its card, with the time they were read; the host picker marks the host 에이전트 응답 없음 / "agent not answering".

`/api/devices` carries each device's `agent` (`name`, `url`, `ok`, `pending`, `error`, `checkedAt`, `lastOk`, `failures`, `nextAt`, `info`) and `portsSource: "agent"`, plus `agents[]` with the device each agent went to. The remote connector's `list_devices` gets the state and version only, never the URL or the load numbers.

## Not in v1

- **Writes on another host** (restart, stop, expose, logs). The agent has no write route. When it gets one it will stay owner-only: the board's owner check (loopback or the owner's login through serve, the write-device allowlist), then the agent's own check of the board's identity, both in the audit log.
- **Push or streaming.** The board polls.
- **The board's other views of an agent host** (the service page, history, uptime and alerts for its ports): the 기기 tab and the host picker show its ports and load.
- **Removing compute-pool.** compute-pool still feeds hosts without an agent, and its load and rotation state.
