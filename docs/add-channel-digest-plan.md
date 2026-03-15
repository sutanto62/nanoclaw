# Plan: `add-channel-digest` skill

This skill installs a **host-side digest runner** that pre-processes stored data into structured cache files — zero LLM tokens, no API calls per M1/M7 invocation.

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

## How M1/M7 want to use this data

The M7 skill already expects:
```bash
cat /workspace/group/lark/latest.md    # Lark summary cache
cat /workspace/group/calendar/today.md # Calendar cache
```

But these files don't exist — M7 falls back to `NO_LARK_CACHE`. That's the gap.

## Architecture

```
messages.db (Lark rows, Gmail rows)
       │
       ▼
[digest runner — TypeScript, runs on schedule]
       │
       ├── groups/{name}/lark/latest.md
       ├── groups/{name}/gmail/latest.md
       └── groups/{name}/github/latest.md  ← future
       │
       ▼
Container agent reads via cat (M1, M7, weekly-cadence)
```

## What the digest runner does

### Lark — queries `messages.db`

```sql
SELECT sender_name, content, timestamp
FROM messages
WHERE chat_jid LIKE 'lark:%'
  AND timestamp > (now - 24h)
  AND is_bot_message = 0
ORDER BY timestamp DESC
LIMIT 50
```

Groups by thread/chat, summarizes decisions/actions, writes `lark/latest.md`:

```markdown
# Lark Digest — 2026-03-15

## oc_abc123 (Ops team)
- [10:30] Budi: Sprint Planning moved to Wednesday
- [11:15] Cayadi: Approved budget for infra upgrade

## oc_def456 (Engineering)
- [14:00] Rina: Deployment blocked — waiting on DB migration
```

### Gmail — reads `~/.gmail-mcp/thread-meta.json` + queries messages.db

```markdown
# Gmail Digest — 2026-03-15

## Urgent threads
- [Vendor escalation] AWS invoice overdue — replied, waiting response
- [Blocker] ERP staging down — escalated to infra team

## Read & archived
- 8 non-urgent emails marked read
```

### GitHub (future) — calls GitHub API, writes `github/latest.md`

```markdown
# GitHub Digest — 2026-03-15

## PRs opened
## PRs merged
## Issues assigned to me
```

## Files to install

| File | Purpose |
|------|---------|
| `src/digest-runner.ts` | Core digest logic, queries messages.db, writes cache files |
| `src/channels/digest.ts` | Channel-like registration, runs on schedule |
| Hook in `src/index.ts` | Register digest runner at startup |

## Schedule

Runs:
- At startup (catch up on overnight)
- Every 60 min (configurable via `DIGEST_INTERVAL_MS`)
- On-demand via IPC from container (`ipc: digest refresh`)

## Container skill snippet (added to group CLAUDE.md)

```markdown
## Channel Digest Cache

Before M1/M7, read pre-processed summaries:
- Lark: `cat /workspace/group/lark/latest.md`
- Gmail: `cat /workspace/group/gmail/latest.md`
- GitHub: `cat /workspace/group/github/latest.md`

These are updated hourly by the host. No API calls needed.
```

## Why this beats burning tokens

| Current M7 | With digest |
|---|---|
| Calls `mcp__gmail__*` each run | Reads a flat file |
| `NO_LARK_CACHE` → asks user | Lark cache always fresh |
| GitHub: not implemented | Reads flat file |
| Token cost: ~2K/run | Token cost: ~0 extra |
