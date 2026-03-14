# Lark / Feishu App Setup

NanoClaw uses a **custom app** with WebSocket long connection to receive messages. No public URL is needed.

## Step 1: Create the app

1. Go to the Lark/Feishu Open Platform:
   - **Lark (international):** https://open.larksuite.com/app
   - **Feishu (China):** https://open.feishu.cn/app
2. Click **Create App** → **Custom App**
3. Fill in the app name (e.g., "Andy Assistant") and description
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
| `im:chat` | Read chat metadata |

Click **Save**.

## Step 4: Subscribe to events

Go to **Event Subscriptions**. Enable **Use long connection to receive events** (WebSocket mode — no public URL needed).

Add event:
- `im.message.receive_v1` — triggered when the bot receives a message

Click **Save**.

## Step 5: Enable the bot capability

Go to **Bot** → Enable **Bot**. This allows the app to act as a chat bot.

## Step 6: Publish / activate the app

- **Single-workspace (standard app):** Go to **Version Management & Release** and publish. The app is available immediately in your workspace.
- **Enterprise app:** Submit for review if required by your organization.

After publishing, add the bot to a group or start a DM with it to verify it's working.

## Step 7: Get the chat ID

Once the bot is connected (after running NanoClaw with the new credentials), send any message to the bot or in a group where it's a member. The chat ID will appear in the NanoClaw logs:

```
tail -f logs/nanoclaw.log
```

Look for lines like:
```
Message from unregistered Lark chat {"chatJid":"lark:oc_xxxxxxxx"}
```

The `oc_xxxxxxxx` part is the chat ID. The full JID is `lark:oc_xxxxxxxx`.

## Token reference

| Variable | Where to find it |
|----------|-----------------|
| `LARK_APP_ID` | App dashboard → **Credentials & Basic Info** → App ID |
| `LARK_APP_SECRET` | App dashboard → **Credentials & Basic Info** → App Secret |

## Troubleshooting

### Bot not receiving messages

1. Check that `im.message.receive_v1` event is subscribed
2. Check that **long connection** mode is enabled (not webhook URL mode)
3. Verify the bot capability is enabled under **Bot**
4. Confirm the app is published/activated
5. Check NanoClaw logs: `tail -f logs/nanoclaw.log`

### Bot not in the group

Add the bot to the group manually: in Lark/Feishu, open the group → **Members** → **Add bot** → search for your bot name.

### "App not activated" error in logs

The app needs to be published before it can receive events. Go to **Version Management & Release** and publish it.

### Permission errors

If you see permission errors when sending messages, ensure `im:message:send_as_bot` scope is added and the app is re-published after adding the scope.
