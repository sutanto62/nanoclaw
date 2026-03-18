# Plan: `add-channel-digest` skill

> **Status: Implemented** — `src/digest-runner.ts` is live and running in production.

This skill installs a **host-side digest runner** that pre-processes stored data into structured cache files — zero LLM tokens, no API calls per M1/M7 invocation.

---

## How add-gmail and add-lark store data

### Lark
- **All messages** → `store/messages.db` `messages` table, `chat_jid = lark:{chat_id}`
- **Chat metadata** → `messages.db` `chats` table (`last_message_time` used as poll cursor)
- **Credentials** → `.env` (`LARK_APP_ID`, `LARK_APP_SECRET`)

### Gmail
- **Urgent/VIP emails only** → `store/messages.db` `messages` table, `chat_jid = gmail:{threadId}`
- **Non-urgent emails** → marked read, never stored in messages.db
- **Thread metadata** → `~/.gmail-mcp/thread-meta.json` (sender, subject, messageId for replies)
- **OAuth tokens** → `~/.gmail-mcp/credentials.json`

---

## How M1/M7 use this data

Before the digest runner existed, M7 expected:
```bash
cat /workspace/group/lark/latest.md    # Lark summary cache
cat /workspace/group/calendar/today.md # Calendar cache
```

These files were missing and M7 fell back to `NO_LARK_CACHE`. The digest runner fills this gap — files are now written on startup and refreshed every `DIGEST_INTERVAL_MS`.

---

## Architecture

```
messages.db (Lark rows, Gmail rows)
       │
       ▼
[src/digest-runner.ts — TypeScript, runs on schedule]
       │
       ├── groups/{name}/lark/latest.md      (per group, using getNewMessages / getMessagesSince)
       ├── groups/{name}/gmail/latest.md     (main group only)
       └── groups/{name}/4dx/wig-context.md  (main group only, if 4dx/wig.json exists)
       │
       ▼
Container agent reads via cat (M1, M7, weekly-cadence)
```

---

## What the digest runner does

### Lark

Uses `getNewMessages(allLarkJids, since, ASSISTANT_NAME, 500)` (main group) or
`getMessagesSince(groupJid, since, ASSISTANT_NAME, 200)` (sub-group).

Groups messages by `chat_jid`, formats output:

```markdown
# Lark Digest — 2026-03-15T08:30:00.000Z
# Lookback: 24h

## Ops team (lark:oc_abc123)
🔗 Open in Lark: https://applink.larksuite.com/client/chat_detail?chat_id=oc_abc123
- [10:30] Budi: Sprint Planning moved to Wednesday
- [11:15] Cayadi: Approved budget for infra upgrade

## Engineering (lark:oc_def456)
🔗 Open in Lark: https://applink.larksuite.com/client/chat_detail?chat_id=oc_def456
- [14:00] Rina: Deployment blocked — waiting on DB migration
```

- Main group: aggregates **all** Lark JIDs (up to 500 messages)
- Sub-group: only its own `lark:` JID (up to 200 messages)
- Each section header includes a `🔗 Open in Lark:` deep link line for one-tap navigation
- Deep link base is derived from `LARK_DOMAIN` in `.env` (feishu → `applink.feishu.cn`, otherwise `applink.larksuite.com`)
- Returns `null` (skips write) only when no Lark JIDs exist (channel not configured)
- Writes `(No messages in the last Nh)` placeholder if JIDs exist but no messages in lookback window

### Gmail

Uses `getNewMessages(allGmailJids, since, ASSISTANT_NAME, 200)`.

Only urgent/VIP emails are in messages.db — no section split between urgent and non-urgent:

```markdown
# Gmail Digest — 2026-03-15T08:30:00.000Z
# Lookback: 24h (urgent/VIP only — non-urgent emails not stored)

- [09:15] vendor@aws.com: Invoice overdue — payment required
- [11:00] boss@company.com: ERP staging down — need update
```

- Written to **main group only** (`group.isMain === true`)
- Returns `null` (skips write) only when no Gmail JIDs exist (channel not configured)
- Writes `(No urgent/VIP emails in the last Nh)` placeholder if JIDs exist but no emails in lookback window

### WIG Channel Context (`4dx/wig-context.md`)

Uses `getNewMessages([...allLarkJids, ...allGmailJids], since, ASSISTANT_NAME, 500)`.

Filters for messages that match any of:
- `[WIG]` explicit tag
- `whirlwind` keyword (case-insensitive)
- Token overlap with WIG names/leads from `wig.json` (via `loadWigKeywordMap` / `tagWigIds`)

Groups results by WIG ID with a "Whirlwind / Untagged Mentions" catchall bucket:

```markdown
# WIG/Whirlwind Channel Context
Generated: 2026-03-17T14:00:00Z
Lookback: 48h

## WIG 1 — ERP Delivery
- [2026-03-17 14:54] lark/proj-shopify · ou_ba71: nitip raise ke Techmarbles...

## WIG 2 — Mid-Farmer CSAT ≥ 4.2
(no entries)

## Whirlwind / Untagged Mentions
- [2026-03-17 10:09] lark/team-tech · ou_5d5: planning meet.google.com/wxw-rphj-yyu
```

- Written to **main group only** (`group.isMain === true`), after the Gmail digest
- Skipped silently if `groups/{folder}/4dx/wig.json` does not exist (not a 4DX group)
- Skipped if no Lark or Gmail JIDs are registered

The `4dx-daily-plan` skill reads this file in its Storage Protocol (`NO_CONTEXT` fallback) and uses it to supplement `wig-signals.json` in Step 2 urgency scoring and Step 3 Whirlwind Watch.

### WIG Signals (`4dx/wig-signals.json`) — deep links

Each signal now carries an optional `source_url` field:

```json
{
  "id": "lark:lark:oc_abc123:1234567890",
  "channel": "lark",
  "correlation_key": "lark:oc_abc123",
  "source_url": "https://applink.larksuite.com/client/chat_detail?chat_id=oc_abc123",
  "status": "open",
  "snippet": "ERP migration blocked — waiting on vendor sign-off",
  ...
}
```

- `source_url` is set when a signal is first created and updated on subsequent upserts.
- The `4dx-daily-plan` skill renders it as `[Open in Lark](source_url)` in Whirlwind Watch bullets.

### Lark — unregistered chat polling

`src/channels/lark.ts` now polls **all** bot-accessible Lark chats, not just registered groups:

- `fetchAllBotChatIds()` paginates `im.chat.list` to collect every chat the bot is a member of.
- The list is refreshed every 4th poll (~1×/hr at 15-min interval).
- Registered and unregistered chat IDs are merged into `allJids` before polling.
- Unregistered chats write WIG signals (with `source_url`) but never trigger agent routing — `processItem()` returns early after the upsert when `group` is not found.

### GitHub — not implemented

Noted as future work. No `github/latest.md` is written.

---

## Implemented files

| File | Status | Purpose |
|------|--------|---------|
| `src/digest-runner.ts` | ✅ Live | Core digest logic — queries messages.db via db helpers, writes cache files (lark, gmail, wig-context); adds `🔗 Open in Lark:` deep link per chat section |
| `src/wig-signals.ts` | ✅ Live | `WigSignal.source_url` and `UpsertOpts.sourceUrl` fields; `upsertWigSignal()` stores and updates the deep link |
| `src/channels/lark.ts` | ✅ Live | Polls all bot-accessible Lark chats (registered + unregistered); computes `deepLinkBase` from `LARK_DOMAIN`; passes `sourceUrl` to `upsertWigSignal()` |
| `container/skills/4dx-daily-plan/SKILL.md` | ✅ Live | Whirlwind Watch renders `[Open in Lark](source_url)` in signal bullets when `source_url` is set |
| `src/index.ts` | ✅ Live | Calls `startDigestRunner({ registeredGroups: () => registeredGroups })` at startup |
| `src/channels/digest.ts` | ❌ Not created | Not needed — digest runner is a standalone module, not a channel |

---

## Schedule

| Trigger | Behavior |
|---------|----------|
| Startup | Runs once immediately |
| Interval | Every `DIGEST_INTERVAL_MS` ms (default 60 min) |
| On-demand IPC | **Not implemented** — `ipc: digest refresh` was planned but not built |

---

## Container skill snippet (in group CLAUDE.md)

Live in `groups/main/CLAUDE.md`:

```markdown
## Channel Digest Cache

Pre-built summaries updated by the host on schedule:
- Lark: `/workspace/group/lark/latest.md` — updated hourly (Lark polls every 15 min)
- Gmail: `/workspace/group/gmail/latest.md` — updated hourly (urgent/VIP only)
- WIG context: `/workspace/group/4dx/wig-context.md` — updated hourly (main group, 4DX groups only)

Use these files directly. No API calls needed. If the file is absent, the channel is not configured.
```

Daily Briefing Step 2 now reads `cat /workspace/group/lark/latest.md` directly — no SQLite query.

Note: GitHub digest is not implemented — no `github/latest.md` is written.

---

## Why this beats burning tokens

| Before digest runner | With digest runner |
|---|---|
| Calls `mcp__gmail__*` each run | Reads a flat file |
| `NO_LARK_CACHE` → asks user | Lark cache always fresh |
| GitHub: not implemented | Still not implemented |
| Token cost: ~2K/run | Token cost: ~0 extra |

---

## What remains to implement (optional)

| Item | Notes |
|------|-------|
| GitHub digest | Future — calls GitHub API, writes `github/latest.md` |
| IPC on-demand refresh | `ipc: digest refresh` trigger from container agent |
| Gmail non-urgent count | Show "N non-urgent emails marked read" in Gmail digest |
| Calendar digest | Requires a `add-calendar` channel skill (Google Calendar OAuth, event polling, storage in messages.db). Once built, digest-runner.ts adds a `buildCalendarDigest` builder writing `groups/{folder}/calendar/today.md`. The M7 skill already references this path. |
