# Runbooks: rotating Portboard's secrets

c10dev/portboard#31. Each secret Portboard holds has one page with the same parts: **when** to rotate it, the **steps**, how to **verify** it in Portboard (which setup-checklist item or self-watch row turns green), and **rollback**.

| Secret | Where it lives | Runbook |
|---|---|---|
| Proxmox API token | `~/.config/portboard/proxmox.json` (600) | [proxmox-token.md](proxmox-token.md) |
| Read-only SSH key for pve1/CTs and Windows | `~/.ssh/portboard_ro` + forced-command lines on pve1 and the desktop | [ssh-readonly-keys.md](ssh-readonly-keys.md) |
| ntfy topic (down alerts, self-watch, 새 기기, digest) | `~/.local/state/compute-pool/alerts.json` (compute-pool's) | [ntfy-topic.md](ntfy-topic.md) |
| Remote connector tokens (claude.ai, ChatGPT, Claude Code) | `~/.config/portboard/remote.json` (600, hashes only) | [remote-connector.md](remote-connector.md) |

Where the dashboard links here:
- 설정 체크리스트 (header chip 설정 n/m): the 알림 채널, Proxmox API 토큰, pve1·CT 읽기 키, Windows 읽기 키 and claude.ai 커넥터 items each carry a "교체 절차" link.
- 데이터 수집 dialog (self-watch chip): every row under 토큰 만료 has a "교체 절차" link.
- Self-watch alerts: the expiry warning for a credential ends with `Runbook: <url>`, and a down alert for the proxmox, pve-ports or win-ports collector ends with "If its credential was rotated or rejected: <url>".

The connector's tokens are also managed one by one on the dashboard (원격 커넥터, on the 기기 tab when these were taken, on the 설정 tab since; 1200 px and 390 px, from a preview pair):



Rules for all of them:
- Never paste a secret into a chat, an issue, a commit or a log. The commands below read secrets from files or prompts and print fingerprints or lengths only.
- Write secret files with `umask 077` and replace them with `mv` (atomic), so a reader never sees half a file.
- Keep the old credential working until the new one is verified; remove it last. Every rollback below relies on that.
- Do it on the production files only from the server itself (devbox). A preview (`PORTBOARD_PORT` ≠ 8790) reads the same `proxmox.json`, SSH key and ntfy channel read-only, but has its own `remote.json`.
