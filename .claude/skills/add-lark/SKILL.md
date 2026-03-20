---
name: add-lark
description: Add Lark/Feishu as a channel. Uses poll mode (like Gmail) — connects on demand, fetches missed messages since last run, no persistent connection needed. Works with both Lark (international) and Feishu (China).
---

# Add Lark Channel

This skill adds Lark/Feishu support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

Lark runs in **poll mode** — it fetches messages via `im.message.list` API on a schedule, not a persistent WebSocket. NanoClaw does not need to run 24/7. On each startup it automatically backfills messages missed since the last run.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `lark` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you already have a Lark/Feishu custom app with App ID and App Secret, or do you need to create one?

If they have credentials, collect them now. If not, we'll create the app in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Apply the skill

```bash
git fetch upstream skill/add-lark
git merge upstream/skill/add-lark
```

This deterministically:
- Adds `src/channels/lark.ts` (LarkChannel class with self-registration via `registerChannel`)
- Adds `src/channels/lark.test.ts` (unit tests)
- Appends `import './lark.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new lark tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Lark App (if needed)

If the user doesn't have an app, share [LARK_SETUP.md](LARK_SETUP.md) which has step-by-step instructions for creating a custom app, enabling the bot capability, and adding permissions.

Quick summary:
1. Go to https://open.larksuite.com/app (Lark) or https://open.feishu.cn/app (Feishu)
2. Create a **Custom App**, enable the **Bot** capability
3. Add permissions: `im:message`, `im:message:readonly`, `im:message:send_as_bot`, `im:chat`
4. No event subscription needed — poll mode uses the REST API, not WebSocket events
5. Publish/activate the app
6. Copy **App ID** and **App Secret** from Credentials page

Wait for the user to provide both credentials.

### Configure environment

Add to `.env`:

```bash
LARK_APP_ID=cli_your_app_id
LARK_APP_SECRET=your_app_secret
# Optional: poll interval in ms (default: 900000 = 15 min)
# LARK_POLL_INTERVAL_MS=900000
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Configure schedule (macOS)

NanoClaw is scheduled via launchd to start at **7:30am daily** by default. To change the time, edit `~/Library/LaunchAgents/com.nanoclaw.plist`:

```xml
<key>StartCalendarInterval</key>
<dict>
    <key>Hour</key>
    <integer>7</integer>   <!-- change this -->
    <key>Minute</key>
    <integer>30</integer>  <!-- change this -->
</dict>
```

Then reload: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist`

To start manually at any time: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Add the bot to a Lark/Feishu group (in the group → Members → Add bot → search your bot name)
> 2. Start NanoClaw manually: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
> 3. NanoClaw will poll the group and log any unregistered chats it discovers:
>    ```
>    tail -f logs/nanoclaw.log
>    ```
>    Look for: `Lark message.list failed` or check the chats table:
>    ```bash
>    sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE 'lark:%';"
>    ```
> 4. The JID is the full `lark:oc_xxxxxxxx` value

Wait for the user to provide the chat ID.

### Register the chat

Use the `register_group` MCP tool or insert directly into the DB:

```sql
INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main)
VALUES ('lark:<chat-id>', '<chat-name>', 'lark_<group-name>', '@Brain', datetime('now'), 1, 0);
```

For a main chat (responds to all messages, no trigger needed):
- Set `requires_trigger = 0`, `is_main = 1`, folder = `lark_main`

For additional chats (trigger-only):
- Set `requires_trigger = 1`, `is_main = 0`, folder = `lark_<group-name>`

Use `ASSISTANT_NAME` from `.env` as the trigger value (e.g. `@Brain`).

Create the group folder:
```bash
mkdir -p groups/lark_<group-name>/logs
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Start NanoClaw and check logs for the poll output:
> ```bash
> launchctl kickstart -k gui/$(id -u)/com.nanoclaw
> tail -f logs/nanoclaw.log
> ```
> Look for: `Lark messages fetched {"chatJid":"lark:oc_xxx","fetched":N}`
>
> Then send a message in your registered Lark/Feishu chat:
> - For main chat: Any message works
> - For non-main: Use trigger from `.env` `ASSISTANT_NAME` (e.g., `@Brain hello`)
>
> NanoClaw polls every 15 min by default. To test immediately, restart NanoClaw — it always polls on startup.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### No messages fetched on startup

1. Check `LARK_APP_ID` and `LARK_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'lark:%'"`
3. Verify `im:message:readonly` permission is added in the Lark app and app is re-published
4. Service is running: `launchctl list | grep nanoclaw` (macOS)

### Messages fetched but agent not responding

1. For non-main chats: message must start with `@Brain` (or your `ASSISTANT_NAME`)
2. Check that the group folder exists: `ls groups/lark_<group-name>/`
3. Check for agent errors: `tail -f logs/nanoclaw.error.log`

### "App not activated" in logs

The app must be published before it can call the API. Go to **Version Management & Release** in the app dashboard and publish it.

### Permission errors when fetching messages

Add `im:message:readonly` scope in **Permissions & Scopes**, then re-publish the app.

### Permission errors when sending

Add `im:message:send_as_bot` scope in **Permissions & Scopes**, then re-publish the app.

## After Setup

The Lark channel supports:
- **Group chats** — Bot must be added as a member
- **Direct messages** — Users can DM the bot directly
- **Multi-channel** — Can run alongside WhatsApp, Telegram, or other channels (auto-enabled by credentials)
- **On-demand** — NanoClaw does not need to run 24/7; startup backfills missed messages automatically

## Known Limitations

- **Poll delay** — New messages are picked up at the next poll (default 15 min) or on next startup, not instantly
- **No typing indicator** — Lark does not expose a typing indicator API. `setTyping()` is a no-op.
- **No sender display name** — `sender_name` is set to the internal `user_id` (employee ID). Real names require an additional User API call.
- **Text-only send** — `sendMessage()` sends plain text. Rich card or interactive message support would require additional Lark message types.
- **Message splitting is naive** — Long messages are split at 30,000 characters, which may break mid-sentence.
- **No file/image handling** — Non-text messages (images, files, audio, video) are delivered as `[Image]`, `[File]`, etc. placeholders.

## Removal

1. Delete `src/channels/lark.ts` and `src/channels/lark.test.ts`
2. Remove `import './lark.js'` from `src/channels/index.ts`
3. Remove `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_POLL_INTERVAL_MS` from `.env`
4. Remove Lark registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'lark:%'"`
5. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
