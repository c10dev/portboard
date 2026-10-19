# Runbook: rotate the Proxmox API token

The dashboard reads pve1 (VM/CT tree, host load) with an API token in `~/.config/portboard/proxmox.json`:

```json
{"url": "https://192.168.1.201:8006", "tokenId": "root@pam!portboard", "secret": "…", "fingerprint": "32:A5:…"}
```

The token has role **PVEAuditor** on `/` (read-only), with privilege separation. The first token is made the same way as in the steps below.

## When

- The self-watch warns `Proxmox API token expires soon` (7 days before) or `expired`; the setup checklist's **Proxmox API 토큰** item says 곧 만료돼요 / 만료됐어요.
- The proxmox collector is down with `HTTP 401` (token deleted or its secret regenerated on pve1).
- The secret may have leaked (the file was readable by others, a backup went somewhere, it was pasted somewhere).
- Routinely, if you set an expiry on the token: before it.

## Steps

1. **Make the new token on pve1** (web UI, `https://192.168.1.201:8006`): Datacenter → Permissions → API Tokens → Add.
   - User `root@pam`, Token ID with the month in it, e.g. `portboard-2610` (a new ID, so the old token keeps working until step 5).
   - Keep **Privilege Separation** checked. Set an **Expire** date if you want the self-watch to remind you next time.
   - Copy the secret; it is shown once.
2. **Give it read-only rights:** Datacenter → Permissions → Add → API Token Permission: path `/`, token `root@pam!portboard-2610`, role **PVEAuditor**, Propagate on.
3. **Write the new file next to the old one, then swap it in** (on devbox; the secret is read from a prompt, not the command line):
   ```bash
   cd ~/.config/portboard && umask 077
   read -rsp 'new token secret: ' S; echo
   S="$S" node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("proxmox.json"));c.tokenId=process.argv[1];c.secret=process.env.S;fs.writeFileSync("proxmox.json.new",JSON.stringify(c)+"\n",{mode:0o600})' 'root@pam!portboard-2610'
   unset S
   cp -p proxmox.json proxmox.json.old && mv proxmox.json.new proxmox.json && chmod 600 proxmox.json
   ```
   `url` and `fingerprint` stay. If pve1's certificate was renewed at the same time, update `fingerprint` too (`openssl s_client -connect 192.168.1.201:8006 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`).
4. **Verify** (below). No restart is needed: the file is read again on the next status call (cached 30 s).
5. **Delete the old token on pve1:** Datacenter → Permissions → API Tokens → select `root@pam!portboard` (the old ID) → Remove. Its permission entry goes with it. Then `rm ~/.config/portboard/proxmox.json.old`.

## Verify in Portboard

- 기기 tab: the pve1 card shows the VM/CT list again (not "Proxmox 토큰을 넣으면…" or an error line).
- Header **데이터 수집** chip → the **Proxmox API** collector is 정상 within a minute.
- Setup checklist → **Proxmox API 토큰** is 완료 (연결됨 · n일 남음, or 만료 없음).
- Self-watch → 토큰 만료 → **Proxmox API token** shows the new expiry. The expiry is re-read once an hour, so this row can lag up to an hour (or until the dashboard next restarts).
- From the shell, without printing the secret: `curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8790/api/devices"` answers 200, and `journalctl --user -u portboard --since -5min | grep -i proxmox` shows no `401`.

## Rollback

The old token still exists until step 5, so:

```bash
cd ~/.config/portboard && mv proxmox.json.old proxmox.json && chmod 600 proxmox.json
```

and remove the new token on pve1 if it is broken. After step 5 there is no way back to the old secret: make another new token (steps 1–4).
