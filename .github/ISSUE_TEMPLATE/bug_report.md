---
name: Bug report
about: Something doesn't work as documented
labels: bug
---

**What happened**

**What you expected**

**How to reproduce**

1.
2.

**Environment**

- Portboard version or commit (설정 tab → 정보, or `git rev-parse --short HEAD`):
- Node.js version (`node --version`):
- OS and distribution:
- Tailscale version, and whether you use `tailscale serve`:
- Where you see it: dashboard (browser?), Mac app, Claude Code plugin, MCP, remote connector

**Logs**

`journalctl --user -u portboard -n 50` around the time, with host names, addresses and tokens removed.

<!-- Security problems: please don't file them here. See SECURITY.md. -->
