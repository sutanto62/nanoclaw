---
name: add-lark
description: Add Lark/Feishu as a channel. Uses WebSocket long connection (no public URL needed). Works with both Lark (international) and Feishu (China).
---

# Add Lark Channel

This skill adds Lark/Feishu support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `lark` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you already have a Lark/Feishu custom app with App ID and App Secret, or do you need to create one?

If they have credentials, collect them now. If not, we'll create the app in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-lark
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

If the user doesn't have an app, share [LARK_SETUP.md](LARK_SETUP.md) which has step-by-step instructions for creating a custom app, enabling the bot capability, and subscribing to events.

Quick summary:
1. Go to https://open.larksuite.com/app (Lark) or https://open.feishu.cn/app (Feishu)
2. Create a **Custom App**, enable the **Bot** capability
3. Add permissions: `im:message`, `im:message:send_as_bot`, `im:chat`
4. Subscribe to event `im.message.receive_v1` with **long connection** mode (no URL needed)
5. Publish/activate the app
6. Copy **App ID** and **App Secret** from Credentials page

Wait for the user to provide both credentials.

### Configure environment

Add to `.env`:

```bash
LARK_APP_ID=cli_your_app_id
LARK_APP_SECRET=your_app_secret
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

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
> 2. Send any message in the group (or DM the bot directly)
> 3. NanoClaw will log the unregistered chat:
>    ```
>    tail -f logs/nanoclaw.log
>    ```
>    Look for: `Message from unregistered Lark chat {"chatJid":"lark:oc_xxxxxxxx"}`
> 4. The JID is the full `lark:oc_xxxxxxxx` value

Wait for the user to provide the chat ID.

### Register the chat

For a main chat (responds to all messages):

```typescript
registerGroup("lark:<chat-id>", {
  name: "<chat-name>",
  folder: "lark_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("lark:<chat-id>", {
  name: "<chat-name>",
  folder: "lark_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Lark/Feishu chat:
> - For main chat: Any message works
> - For non-main: @mention the bot using the trigger name from `.env` `ASSISTANT_NAME` (e.g., `@Brain hello`)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `LARK_APP_ID` and `LARK_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'lark:%'"`
3. For non-main chats: message must include trigger pattern or @mention the bot
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Bot connected but not receiving messages

1. Verify `im.message.receive_v1` event is subscribed in the app settings
2. Verify **long connection** mode is enabled (not webhook URL)
3. Confirm the bot capability is enabled
4. Confirm the app is published/activated
5. Make sure the bot is added to the group

### "App not activated" in logs

The app must be published before it can receive events. Go to **Version Management & Release** in the app dashboard and publish it.

### Permission errors when sending

Add `im:message:send_as_bot` scope in **Permissions & Scopes**, then re-publish the app.

## After Setup

The Lark channel supports:
- **Group chats** — Bot must be added as a member
- **Direct messages** — Users can DM the bot directly
- **Multi-channel** — Can run alongside WhatsApp, Telegram, or other channels (auto-enabled by credentials)

## Known Limitations

- **No typing indicator** — Lark does not expose a typing indicator API. `setTyping()` is a no-op.
- **No sender display name** — The event payload does not include the user's display name. `sender_name` is set to the internal `user_id` (employee ID). To show real names, an additional User API call per message would be needed.
- **Text-only send** — `sendMessage()` sends plain text. Rich card or interactive message support would require additional Lark message types.
- **Message splitting is naive** — Long messages are split at 30,000 characters, which may break mid-sentence.
- **No file/image handling** — Non-text messages (images, files, audio, video) are delivered as `[Image]`, `[File]`, etc. placeholders.

## Removal

1. Delete `src/channels/lark.ts` and `src/channels/lark.test.ts`
2. Remove `import './lark.js'` from `src/channels/index.ts`
3. Remove `LARK_APP_ID` and `LARK_APP_SECRET` from `.env`
4. Remove Lark registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'lark:%'"`
5. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
