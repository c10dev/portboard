# Security policy

Portboard can stop services, publish ports and delete git worktrees on the machine it runs on, and its optional remote
MCP server is meant to face the internet through Tailscale Funnel. Reports are very welcome.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting instead: the repository's
**Security** tab → **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker
needs (a tailnet device, a local process, an internet client of the remote server, …).

You should get a first answer within a week. Fixes are released as soon as they are ready, and the advisory credits
you unless you'd rather it didn't.

## Supported versions

Only the latest release on `main` gets security fixes.

## Scope

In scope: the dashboard and REST API (`src/server.ts`), the stdio MCP server (`src/mcp.ts`), the remote MCP server and
its OAuth flow (`src/remote.ts`, `src/remote/`), the Claude Code plugin's hooks, the Mac app, and the setup scripts.

Out of scope: problems that need the owner's own Unix account on the server (it is trusted by design, see
[docs/security.md](docs/security.md)), denial of service from inside the tailnet, and vulnerabilities in Tailscale,
Node.js or the operating system themselves.

How Portboard decides who can read and write, and what it records: [docs/security.md](docs/security.md). The remote
server's own review: [docs/remote-mcp/SECURITY-REVIEW.md](docs/remote-mcp/SECURITY-REVIEW.md).
