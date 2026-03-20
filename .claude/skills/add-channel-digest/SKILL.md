# add-channel-digest

Installs a **host-side digest runner** that pre-processes Lark and Gmail messages from `messages.db` into flat markdown cache files. The 4DX M1 and M7 skills read these files via `cat` — zero extra API calls, zero extra tokens.

---

## Pre-flight

1. Confirm at least one channel is installed:
   - Lark: check for `src/channels/lark.ts`
   - Gmail: check for `src/channels/gmail.ts`

   If neither exists, install a channel first (`/add-lark` or `/add-gmail`).

2. Ensure the service is **stopped** before applying:
   ```bash
   # macOS
   launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
   # Linux
   systemctl --user stop nanoclaw
   ```

---

## Apply

```bash
git fetch upstream skill/add-channel-digest
git merge upstream/skill/add-channel-digest
npm run build
```

This:
- Adds `src/digest-runner.ts`
- Adds `DIGEST_INTERVAL_MS` and `DIGEST_LOOKBACK_HOURS` to `src/config.ts`
- Hooks `startDigestRunner()` into `src/index.ts` after `startSchedulerLoop()`

---

## Verify

1. Start (or restart) the service:
   ```bash
   # macOS
   launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
   # Linux
   systemctl --user start nanoclaw
   ```

2. Wait ≤ 60 seconds, then check:
   ```bash
   cat groups/main/lark/latest.md
   ```
   You should see a Lark digest with recent messages.

3. Run the M7 skill (`EOD`) in the main group — the Lark section should be populated instead of `NO_LARK_CACHE`.

---

## Optional: tune the refresh interval

Add to `.env`:
```
DIGEST_INTERVAL_MS=900000   # 15-minute refresh (default: 3600000 = 1 hour)
DIGEST_LOOKBACK_HOURS=12    # Shorter lookback (default: 24h)
```

---

## How it works

- Runs once at startup, then every `DIGEST_INTERVAL_MS` milliseconds
- For each registered group:
  - **Sub-group** (e.g. `jid = lark:oc_abc123`): writes `groups/{folder}/lark/latest.md` with messages from its own Lark chat
  - **Main group**: aggregates all `lark:*` chats → `groups/main/lark/latest.md`; aggregates all `gmail:*` chats → `groups/main/gmail/latest.md`
- Only stores messages from the lookback window (default: last 24h)
- Bot messages are excluded

---

## Cache file format

### `lark/latest.md`
```markdown
# Lark Digest — 2026-03-15T09:00:00Z
# Lookback: 24h

## Ops team (lark:oc_abc123)
- [10:30] Budi: Sprint Planning moved to Wednesday
- [11:15] Cayadi: Approved budget for infra upgrade
```

### `gmail/latest.md`
```markdown
# Gmail Digest — 2026-03-15T09:00:00Z
# Lookback: 24h (urgent/VIP only — non-urgent emails not stored)

- [09:12] vendor@aws.com: AWS invoice overdue (Subject: RE: Invoice #4821)
```

Note: Gmail only captures urgent/VIP emails as delivered by the gmail channel. Non-urgent emails are marked read by the channel and not stored in `messages.db`.
