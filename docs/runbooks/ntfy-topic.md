# Runbook: rotate the ntfy topic

All of Portboard's push messages go through **compute-pool's** alert channel, `~/.local/state/compute-pool/alerts.json`:

```json
{"ntfy": {"topic": "…", "server": "https://ntfy.sh"}}
```

(`server` is optional; `webhook.url` may sit next to it.) An ntfy topic has no password: **whoever knows the name can read and send** on it. One topic carries:
- compute-pool's host-out alerts (its monitor),
- Portboard's down/recovered alerts for watched ports and devices, 새 기기 messages, the self-watch's collector and expiry warnings, and the daily/weekly digest.

Both programs read the file on every send (compute-pool every monitor round, Portboard per message), so a change needs no restart. A preview never sends: its channel points at a file that doesn't exist (`docs/operations.md` → Profiles).

## When

- The topic may have leaked: it was in a screenshot, a chat, an issue, a log, a shared phone.
- Strangers' messages show up on it, or you get alerts you didn't expect.
- A phone that was subscribed is lost or handed on.

ntfy topics don't expire, so the self-watch lists it as **ntfy topic · 만료 없음** and never warns about it.

## Steps

1. **Make the new topic** (on devbox) without printing the old one:
   ```bash
   t=$(openssl rand -hex 16); echo "새 토픽: pb-$t"
   ```
2. **Subscribe first** on every phone/Mac that should get alerts: ntfy app → + → topic `pb-…` (same server as before, ntfy.sh unless `server` says otherwise). Keep the old subscription for now.
3. **Swap it in**, keeping every other field (server, webhook):
   ```bash
   cd ~/.local/state/compute-pool && umask 077 && cp -p alerts.json alerts.json.old
   node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("alerts.json"));c.ntfy={...(c.ntfy||{}),topic:process.argv[1]};fs.writeFileSync("alerts.json.new",JSON.stringify(c)+"\n",{mode:0o600})' "pb-$t" \
     && mv alerts.json.new alerts.json && unset t
   ```
4. **Send a test:** dashboard → 🔔 → **테스트 알림 보내기**. It should arrive on the new subscription only.
5. **Unsubscribe the old topic** on every device, then `rm ~/.local/state/compute-pool/alerts.json.old`. Nothing can "delete" a topic on ntfy.sh; once nobody publishes or listens, it is dead.

## Verify in Portboard

- 🔔 dialog: 알림 채널 shows **ntfy**, and the test message arrives.
- Setup checklist → **알림 채널** is 완료 (ntfy로 다운 알림을 보내요).
- Self-watch → 토큰 만료 → **ntfy topic** · 만료 없음 (it lists only that a topic exists, never its name).
- Server log has no topic: `journalctl --user -u portboard --since -10min | grep -c "$(jq -r .ntfy.topic ~/.local/state/compute-pool/alerts.json)"` prints `0`.
- compute-pool: its next host-out alert lands on the new topic.

## Rollback

```bash
cd ~/.local/state/compute-pool && mv alerts.json.old alerts.json
```

and keep (or re-add) the old subscription. If the old topic leaked, rolling back means using a public channel again: pick another new topic instead.
