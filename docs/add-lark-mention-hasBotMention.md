# Lark Mention Detection & `latest.md` — How It Works

## How `mentions` and `hasBotMention` work

**`lark.ts` lines 401–411:**
```ts
const mentions: Array<{
  id?: { user_id?: string; open_id?: string };
  name?: string;
}> = item.mentions || [];

const hasBotMention = this.botOpenId
  ? mentions.some((m) => m.id?.open_id === this.botOpenId)
  : mentions.some(
      (m) =>
        !m.id?.user_id &&
        m.name?.toLowerCase() === ASSISTANT_NAME.toLowerCase(),
    );
```

Lark embeds `@mention` metadata directly in the message payload. `mentions` is an array of every person tagged in that message. Each entry has `id.open_id` (unique Lark user ID) and `name`.

`hasBotMention` has two detection paths:
1. **Primary** (if `botOpenId` was resolved at startup): matches by `open_id` — precise, no false positives
2. **Fallback** (if bot open_id fetch failed): matches by name == `"Brain"` AND no `user_id` — heuristic, fragile (a human named "Brain" with no `user_id` would trigger it)

---

## How `@Brain` gets prepended

**Lines 412–413:**
```ts
if (hasBotMention && !TRIGGER_PATTERN.test(content)) {
  content = `@${ASSISTANT_NAME} ${content}`;
}
```

Lark sends the raw text as-is — `@Brain` in Lark chat becomes `@Brain` in the text but the actual trigger check (`TRIGGER_PATTERN`) looks for the literal string. If the bot was mentioned but the content doesn't already match the trigger pattern, the code prepends `@Brain ` to force-trigger the agent.

So if someone in Lark types:
> `@Brain what's the status?`

The raw `content` from Lark is `@Brain what's the status?`. `hasBotMention = true`, and if `TRIGGER_PATTERN` doesn't already match, it becomes `@Brain @Brain what's the status?` — a minor double-prepend bug for messages that already have the literal string.

For WIG-related messages (no bot mention), it instead prepends `@Brain [WIG]` at line 451.

---

## What `latest.md` is

`latest.md` is a **digest cache file** — a snapshot of recent channel messages written to disk so the container agent can read it without querying the database or live APIs.

**Write path** (`digest-runner.ts`):
```
runDigest() → buildLarkDigest() → writeCacheFile(groupFolder, 'lark', content)
              → writes to: groups/{folder}/lark/latest.md
```

It runs once at startup and then every `DIGEST_INTERVAL_MS`. The file contains the last N hours of messages from that channel, grouped by chat.

**Read path**: the container agent's group folder is bind-mounted at `/workspace/group`. So when the agent runs, it can read `/workspace/group/lark/latest.md` directly. The `CLAUDE.md` for that group instructs the agent to consult it for channel context.

**Example content** (from `groups/lark_dm/lark/latest.md`):
```
# Lark Digest — 2026-03-18T01:01:43.952Z
# Lookback: 48h

## team-tech-leadership (lark:oc_...)
- [12:42] ou_343...: @Brain [WIG] maaf pak dadakan...
```

In short: `latest.md` is a pre-rendered, file-based context window for the agent — avoiding the need for live API calls inside the container while keeping the agent informed of recent activity.
