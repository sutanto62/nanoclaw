# Lark / Feishu App Setup

NanoClaw uses a **custom app** with poll mode — it fetches messages via the REST API (`im.message.list`) on a schedule. No public URL and no persistent WebSocket connection is needed.

## Step 1: Create the app

1. Go to the Lark/Feishu Open Platform:
   - **Lark (international):** https://open.larksuite.com/app
   - **Feishu (China):** https://open.feishu.cn/app
2. Click **Create App** → **Custom App**
3. Fill in the app name (e.g., your `ASSISTANT_NAME` value) and description
4. Click **Create**

## Step 2: Copy credentials

In the app dashboard, go to **Credentials & Basic Info**:
- Copy **App ID** → this is `LARK_APP_ID`
- Copy **App Secret** → this is `LARK_APP_SECRET`

## Step 3: Enable messaging permissions

Go to **Permissions & Scopes** → **Messaging**. Add these scopes:

| Scope | Why |
|-------|-----|
| `im:message` | Read messages sent to the bot |
| `im:message:send_as_bot` | Send messages as the bot |
| `im:message:readonly` | Read message history (required for poll mode) |
| `im:chat` | Read chat metadata (resolve group names) |

Click **Save**.

## Step 4: Enable the bot capability

Go to **Bot** → Enable **Bot**. This allows the app to act as a chat bot and be added to groups.

> **Note:** No event subscription is needed. Poll mode uses the REST API directly — not WebSocket events.

## Step 5: Publish / activate the app

- **Single-workspace (standard app):** Go to **Version Management & Release** and publish. The app is available immediately in your workspace.
- **Enterprise app:** Submit for review if required by your organization.

After publishing, add the bot to a group or start a DM with it.

## Step 6: Add the bot to your groups

In Lark/Feishu, open each group you want to monitor → **Members** → **Add bot** → search for your bot name.

## Step 7: Get the chat ID

Start NanoClaw and check the chats table after the first poll:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 10
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE 'lark:%';"
```

The JID (e.g. `lark:oc_xxxxxxxx`) is what you use to register the group.

## Token reference

| Variable | Where to find it |
|----------|-----------------|
| `LARK_APP_ID` | App dashboard → **Credentials & Basic Info** → App ID |
| `LARK_APP_SECRET` | App dashboard → **Credentials & Basic Info** → App Secret |

## Optional configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LARK_POLL_INTERVAL_MS` | `900000` (15 min) | How often to poll for new messages |
| `LARK_DOMAIN` | `lark` | Set to `feishu` for Feishu (China) |

## Troubleshooting

### No messages fetched

1. Verify `im:message:readonly` scope is added and app is re-published
2. Confirm the bot is added to the group
3. Check NanoClaw logs: `tail -f logs/nanoclaw.log`

### Bot not in the group

Add the bot to the group manually: in Lark/Feishu, open the group → **Members** → **Add bot** → search for your bot name.

### "App not activated" error in logs

The app needs to be published before it can call the API. Go to **Version Management & Release** and publish it.

### Permission errors when sending messages

Ensure `im:message:send_as_bot` scope is added and the app is re-published after adding the scope.
