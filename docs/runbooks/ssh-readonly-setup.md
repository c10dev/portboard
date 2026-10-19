# Runbook: set up the read-only SSH port readers (Proxmox and Windows)

Portboard can list the listening TCP ports of two kinds of machine it doesn't run on:

- a **Proxmox VE host** and its running LXC containers, and
- the **Windows side** of a desktop (outside WSL).

Both are read over SSH with one dedicated key, `~/.ssh/portboard_ro`. On the other machine that key is a **forced-command** key: whatever the client asks for, sshd runs one script that prints the listening sockets, with no shell, pty or forwarding. Nothing is changed on that machine. Both readers are off until you name their host in `portboard.json` ([config.md](../config.md)).

How the readers behave once set up (intervals, backoff, logs, revoking): [operations.md](../operations.md#proxmox-ports-over-ssh-read-only). Rotating the key later: [ssh-readonly-keys.md](ssh-readonly-keys.md).

## 1. The key (on the Portboard server)

```bash
ssh-keygen -t ed25519 -N '' -C "portboard-ro@$(hostname -s)" -f ~/.ssh/portboard_ro
cat ~/.ssh/portboard_ro.pub
```

Keep the public key line for the steps below. The private key never leaves this server.

## 2. Proxmox VE host

On the Proxmox host as root (web UI → the node → **Shell**), paste this with your public key in place of `ssh-ed25519 AAAA… portboard-ro@yourserver`:

```bash
cat > /usr/local/bin/portboard-ports <<'SCRIPT'
#!/bin/sh
# Portboard (read-only): listening TCP ports of this Proxmox host and its running containers.
echo "## host"
ss -ltnpH 2>/dev/null || ss -ltnH
for id in $(pct list 2>/dev/null | awk 'NR>1 && $2=="running" {print $1}'); do
  echo "## ct $id"
  pct exec "$id" -- sh -c 'ss -ltnpH 2>/dev/null || ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null' </dev/null
done
SCRIPT
chmod 755 /usr/local/bin/portboard-ports
PUB='ssh-ed25519 AAAA… portboard-ro@yourserver'
grep -qF "$PUB" /root/.ssh/authorized_keys || echo "command=\"/usr/local/bin/portboard-ports\",restrict $PUB" >> /root/.ssh/authorized_keys
/usr/local/bin/portboard-ports | head -5
```

VMs (qemu) are not covered; only the host and LXC containers.

Then, on the Portboard server, accept the host key once and turn the reader on:

```bash
ssh-keyscan -H <proxmox-ip> >> ~/.ssh/known_hosts
```

```json
{ "pve": { "host": "<proxmox-ip>", "user": "root", "node": "<node name>", "enabled": true } }
```

in `~/.config/portboard/portboard.json`. The 기기 tab shows the host's and each container's ports within a minute.

**Undo** on the Proxmox host: `sed -i '/portboard-ro@yourserver/d' /root/.ssh/authorized_keys && rm /usr/local/bin/portboard-ports`.

## 3. Windows desktop

Needs the OpenSSH server (Settings → System → Optional features → OpenSSH Server, then `Start-Service sshd`). In an administrator PowerShell:

```powershell
New-Item -ItemType Directory -Force C:\ProgramData\portboard | Out-Null
@'
# Portboard (read-only): one line per listening TCP socket, LocalAddress<TAB>LocalPort<TAB>PID<TAB>ProcessName
Get-NetTCPConnection -State Listen | ForEach-Object {
  $name = ''
  try { $name = (Get-Process -Id $_.OwningProcess -ErrorAction Stop).ProcessName } catch {}
  "{0}`t{1}`t{2}`t{3}" -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess, $name
}
'@ | Set-Content -Encoding ascii C:\ProgramData\portboard\ports.ps1
$pub = 'ssh-ed25519 AAAA… portboard-ro@yourserver'
$line = 'command="powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\portboard\ports.ps1" ' + $pub
# An administrator account reads this file; a standard account reads %USERPROFILE%\.ssh\authorized_keys instead
Add-Content -Encoding ascii C:\ProgramData\ssh\administrators_authorized_keys $line
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

Then, on the Portboard server:

```bash
ssh-keyscan -H <windows-ip> >> ~/.ssh/known_hosts
```

```json
{ "windows": { "host": "<windows-ip>", "user": "<windows account>", "device": "<its Tailscale name>", "enabled": true } }
```

`device` is the tailnet device whose card on the 기기 tab gets the ports. If compute-pool already reports the machine's WSL side, both lists merge on that card.

**Undo** on Windows: remove the `portboard-ro@yourserver` line from the authorized_keys file and delete `C:\ProgramData\portboard\`.

## Checking it

The 설정 tab's setup checklist and `GET /api/settings` show each reader's state: `not-installed` (the key isn't accepted yet), `host-key` (the host key isn't in `known_hosts` or changed), `no-user` (Windows without a user) or ok. The script's output format is what `src/core/pveports.ts` and `src/core/winports.ts` parse; the Windows script above was written from that parser, so check its first lines once (`ssh -i ~/.ssh/portboard_ro <user>@<windows-ip>`) on your machine.
