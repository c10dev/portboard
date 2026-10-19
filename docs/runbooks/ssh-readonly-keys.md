# Runbook: rotate the read-only SSH key (pve1/CTs and Windows)

One key, `~/.ssh/portboard_ro` (ed25519, no passphrase), reads listening ports on two machines. On both it is a **forced-command** key, so it can run nothing but one script:

| Machine | authorized_keys | Forced command |
|---|---|---|
| pve1 (192.168.1.201, root) | `/root/.ssh/authorized_keys` | `command="/usr/local/bin/portboard-ports",restrict` |
| desktop Windows (192.168.1.7, Dev) | `C:\ProgramData\ssh\administrators_authorized_keys` (admin account), else `%USERPROFILE%\.ssh\authorized_keys` | `command="powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\portboard\ports.ps1"` |

Background: [docs/operations.md](../operations.md) → "Proxmox ports over SSH" and "Desktop Windows ports over SSH". The key path can be set per target in `~/.config/portboard/pveports.json` and `winports.json` (`"key"`), which this runbook uses to test the new key before switching.

## When

- The private key may have leaked (copied off the server, in a backup, permissions loosened).
- devbox is rebuilt or its home directory restored from somewhere you don't trust.
- Routinely (SSH keys don't expire; the self-watch lists it as **SSH key portboard_ro · 만료 없음**), e.g. yearly.

Not this runbook: a **host key** change on pve1 or the desktop (collector error `host-key`) is the other side's key. Check why it changed before replacing the line in `~/.ssh/known_hosts`.

## Steps

1. **Make the new key** (on devbox), next to the old one:
   ```bash
   ssh-keygen -t ed25519 -N '' -C portboard-ro@devbox -f ~/.ssh/portboard_ro.new
   ssh-keygen -lf ~/.ssh/portboard_ro.new.pub     # note the new fingerprint
   ssh-keygen -lf ~/.ssh/portboard_ro.pub         # and the old one
   cat ~/.ssh/portboard_ro.new.pub                # the public half: safe to copy
   ```
2. **Add it on pve1, with the same forced command** (pve1 → Shell). Append, don't replace: the old line keeps working.
   ```bash
   echo 'command="/usr/local/bin/portboard-ports",restrict ssh-ed25519 AAAA…new… portboard-ro@devbox' >> /root/.ssh/authorized_keys
   ```
3. **Add it on Windows** (PowerShell as Administrator on the desktop), same idea:
   ```powershell
   $f = 'C:\ProgramData\ssh\administrators_authorized_keys'
   Add-Content -Path $f -Value 'command="powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\portboard\ports.ps1" ssh-ed25519 AAAA…new… portboard-ro@devbox'
   icacls $f /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'   # sshd ignores the file if others can write it
   ```
4. **Test the new key directly** (on devbox). Each should print port lines and nothing else; asking for another command must still run only the script:
   ```bash
   o='-F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes'
   ssh $o -i ~/.ssh/portboard_ro.new root@192.168.1.201 | head -3
   ssh $o -i ~/.ssh/portboard_ro.new Dev@192.168.1.7 | head -3
   ssh $o -i ~/.ssh/portboard_ro.new root@192.168.1.201 'id' | head -3   # prints ports, not uid=0: the forced command won
   ```
5. **Switch Portboard to it.** Either point the configs at the new file first (read on every attempt, no restart):
   ```bash
   cd ~/.config/portboard
   for f in pveports.json winports.json; do [ -f $f ] || echo '{}' > $f; node -e 'const fs=require("fs"),f=process.argv[1];const c=JSON.parse(fs.readFileSync(f));c.key="~/.ssh/portboard_ro.new";fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' $f; done
   ```
   or, once you are satisfied, move it into the default name, which needs no config at all:
   ```bash
   cd ~/.ssh && mv portboard_ro portboard_ro.old && mv portboard_ro.pub portboard_ro.old.pub \
     && mv portboard_ro.new portboard_ro && mv portboard_ro.new.pub portboard_ro.pub
   ```
   (and drop the `"key"` you added in the first variant).
6. **Verify** (below), then **remove the old key on both machines**, matching its key body so the new line (same comment) stays:
   ```bash
   old=$(awk '{print $2}' ~/.ssh/portboard_ro.old.pub)   # on devbox; copy this value, it's the public half
   ```
   pve1: `grep -vF "<old body>" /root/.ssh/authorized_keys > /root/.ssh/ak.new && mv /root/.ssh/ak.new /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`
   Windows: `(Get-Content $f) | Where-Object { $_ -notlike '*<old body>*' } | Set-Content $f`
   Then on devbox `rm ~/.ssh/portboard_ro.old ~/.ssh/portboard_ro.old.pub`, and check the old key is refused: `ssh $o -i …` with a copy of it should say `Permission denied (publickey)` (skip if already deleted).

## Verify in Portboard

- Header **데이터 수집** → **pve1 포트 (SSH)** and **Windows 포트 (SSH)** collectors are 정상 within a minute (새로고침 on the 기기 tab re-checks at once, at most every 20 s).
- Setup checklist → **pve1·CT 읽기 키** and **Windows 읽기 키** are 완료 (…를 SSH로 읽고 있어요).
- 기기 tab: pve1, nas, jellyfin and the desktop show their port lists again.
- On pve1, `journalctl -u ssh --since -5min | grep Accepted` shows the **new** fingerprint (sshd logs keys by fingerprint).

## Rollback

Until step 6 the old key is still installed on both machines:
- Variant "config": remove the `"key"` lines again (or set them back to `~/.ssh/portboard_ro`).
- Variant "rename": `cd ~/.ssh && mv portboard_ro portboard_ro.new && mv portboard_ro.pub portboard_ro.new.pub && mv portboard_ro.old portboard_ro && mv portboard_ro.old.pub portboard_ro.pub`.

Then delete the new line from both authorized_keys files. Collector error codes if something is off: `not-installed` (key not in authorized_keys, or the file's permissions make sshd ignore it), `host-key` (known_hosts), `no-key` (the file the config points at is missing).
