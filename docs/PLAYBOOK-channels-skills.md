# NanoClaw Channels & Skills Playbook

Covers: **Lark channel**, **Gmail channel**, and **4DX Daily Plan skill**.

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Core Components](#2-core-components)
3. [Lark Channel](#3-lark-channel)
4. [Gmail Channel](#4-gmail-channel)
5. [4DX Daily Plan Skill](#5-4dx-daily-plan-skill)
6. [Cross-Feature Integration](#6-cross-feature-integration)
7. [Data & Folder Structure](#7-data--folder-structure)

---

## 1. System Architecture Overview

NanoClaw is a single Node.js orchestrator process. Channels self-register at startup and push messages into a central SQLite store. A message loop polls the store and dispatches messages to Claude agents running inside Linux containers. Agent responses stream back to the originating channel.

```mermaid
graph TB
    subgraph Channels
        L[Lark<br/>poll 15 min]
        G[Gmail<br/>poll 1 hr]
        WA[WhatsApp / Telegram / Slack / Discord]
    end

    subgraph Orchestrator["Orchestrator (src/index.ts)"]
        REG[Channel Registry]
        DB[(SQLite)]
        LOOP[Message Loop]
        SCHED[Task Scheduler]
        IPC[IPC Watcher]
        DIGEST[Digest Runner]
    end

    subgraph Container["Agent Container (Linux VM)"]
        CLAUDE[Claude Agent SDK]
        SKILL[Skills / CLAUDE.md]
        WS[/workspace/group]
    end

    L -->|onMessage| REG
    G -->|onMessage VIP/urgent| REG
    WA -->|onMessage| REG
    REG --> DB
    LOOP -->|getNewMessages| DB
    LOOP -->|spawn| Container
    CLAUDE -->|stdout markers| LOOP
    LOOP -->|sendMessage| REG
    REG --> L
    REG --> G
    REG --> WA
    SCHED -->|getDueTasks| DB
    SCHED -->|spawn| Container
    IPC -->|/workspace/ipc| DB
    DIGEST -->|write cache| WS
```

---

## 2. Core Components

| File | Role |
|------|------|
| `src/index.ts` | Orchestrator — state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel self-registration at startup |
| `src/channels/lark.ts` | Lark/Feishu poll channel |
| `src/channels/gmail.ts` | Gmail poll channel |
| `src/container-runner.ts` | Spawns agent containers with volume mounts |
| `src/task-scheduler.ts` | Runs scheduled/cron tasks |
| `src/ipc.ts` | Reads agent-written IPC files, dispatches commands |
| `src/router.ts` | Formats messages as XML; routes outbound text |
| `src/wig-signals.ts` | Upserts blocker/resolution signals from all channels |
| `src/db.ts` | SQLite operations |
| `container/skills/4dx-daily-plan/SKILL.md` | In-container skill instructions |

---

## 3. Lark Channel

### How It Works

- **Transport**: REST polling via `@larksuiteoapi/node-sdk`
- **Poll interval**: 15 minutes (configurable `LARK_POLL_INTERVAL_MS`)
- **Lookback**: 24 hours on first run, then cursor-tracked per chat
- **WIG awareness**: Loads `groups/{folder}/4dx/wig.json`, tags messages that match WIG keywords, upserts signals to `wig-signals.json`
- **Bot mention detection**: Matches bot's `open_id` or display name; prepends trigger pattern if WIG-related

### Process Flow

```mermaid
flowchart TD
    A[Poll timer fires] --> B[lark.im.message.list<br/>per registered chat]
    B --> C{New messages?}
    C -- No --> A
    C -- Yes --> D[Filter bot/app messages]
    D --> E[Extract sender, timestamp, content]
    E --> F{Matches WIG keywords?}
    F -- Yes --> G[Tag WIG IDs<br/>upsertWigSignal]
    F -- No --> H[No signal]
    G --> I{Has bot mention?}
    H --> I
    I -- No, but WIG --> J[Prepend @Brain WIG trigger]
    I -- Yes --> K[Store via onMessage]
    J --> K
    K --> L[(SQLite messages)]
    L --> M[Core message loop picks up]
    M --> N[Format as XML via router.ts]
    N --> O[Spawn container agent]
    O --> P[Claude streams response]
    P --> Q[lark.im.message.create]
```

### Sequence Diagram

```mermaid
sequenceDiagram
    participant Timer
    participant Lark as Lark Channel
    participant API as Lark API
    participant DB as SQLite
    participant Loop as Message Loop
    participant Ctr as Container Agent

    Timer->>Lark: poll interval fires
    Lark->>API: im.message.list(chat_id, start_time)
    API-->>Lark: messages[]
    Lark->>Lark: filter bot messages, detect mention, tag WIG
    Lark->>DB: onMessage() — store message
    Loop->>DB: getNewMessages()
    DB-->>Loop: new messages
    Loop->>Ctr: spawn with XML prompt
    Ctr-->>Loop: stream output markers
    Loop->>API: im.message.create(chat_id, text)
```

### Key Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `LARK_APP_ID` | — | App credentials |
| `LARK_APP_SECRET` | — | App credentials |
| `LARK_DOMAIN` | larksuite.com | International vs Feishu |
| `LARK_POLL_INTERVAL_MS` | 900000 | 15 min poll |

---

## 4. Gmail Channel

### How It Works

- **Transport**: Google Gmail API v1 (OAuth2 via `googleapis`)
- **Poll interval**: 1 hour (configurable `GMAIL_DIGEST_INTERVAL_MS`)
- **Filter**: `is:unread category:primary after:{epoch}`
- **Delivery rules**: Only VIP senders or urgent emails are delivered to the agent immediately. All others are silently cached (available via MCP during briefing).
- **WIG awareness**: Checks subject + snippet for WIG keywords; upserts signals even for silent emails
- **Reply threading**: Stores thread metadata (sender, subject, message-id) for `In-Reply-To` headers

### Urgency Detection Logic

```mermaid
flowchart LR
    Email --> A{Sender in vips.md?}
    A -- Yes --> URGENT
    A -- No --> B{Subject has urgent keywords?}
    B -- Yes --> URGENT
    B -- No --> C{Subject/snippet matches WIG keywords?}
    C -- Yes --> URGENT
    C -- No --> SILENT[Cached silently]
    URGENT --> DELIVER[Deliver to agent via onMessage]
```

### Process Flow

```mermaid
flowchart TD
    A[Poll timer fires] --> B[gmail.users.messages.list<br/>unread primary after lookback]
    B --> C{Emails found?}
    C -- No --> A
    C -- Yes --> D[Fetch metadata<br/>From, Subject, Message-ID]
    D --> E{VIP or urgent?}
    E -- Yes --> F[Fetch full body]
    F --> G[Tag WIG IDs]
    G --> H[onMessage → SQLite]
    H --> I[Core message loop]
    I --> J[Spawn container agent]
    J --> K[Agent replies via IPC send_message]
    K --> L[gmail.users.messages.send<br/>with In-Reply-To header]
    E -- No --> M[Tag WIG IDs<br/>upsertWigSignal]
    M --> N[Cache metadata only<br/>mark read silently]
```

### Sequence Diagram

```mermaid
sequenceDiagram
    participant Timer
    participant Gmail as Gmail Channel
    participant GmailAPI as Gmail API
    participant VIP as vips.md / wig.json
    participant DB as SQLite
    participant Loop as Message Loop
    participant Ctr as Container Agent

    Timer->>Gmail: poll interval fires
    Gmail->>GmailAPI: messages.list(unread, primary)
    GmailAPI-->>Gmail: message IDs
    Gmail->>GmailAPI: messages.get(id, metadata)
    GmailAPI-->>Gmail: From, Subject, Message-ID
    Gmail->>VIP: check VIP list & WIG keywords
    alt VIP or urgent
        Gmail->>GmailAPI: messages.get(id, full)
        GmailAPI-->>Gmail: body text
        Gmail->>DB: onMessage() — store for agent
        Loop->>DB: getNewMessages()
        Loop->>Ctr: spawn with XML prompt
        Ctr-->>Loop: stream response
        Loop->>GmailAPI: messages.send (threaded reply)
    else silent
        Gmail->>DB: upsertWigSignal if WIG-related
        Gmail->>Gmail: cache thread metadata
    end
```

### Key Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `GMAIL_DIGEST_INTERVAL_MS` | 3600000 | 1 hr poll |
| `GMAIL_DIGEST_LOOKBACK_HOURS` | 24 | Lookback window |
| `~/.gmail-mcp/gcp-oauth.keys.json` | — | OAuth client credentials |
| `~/.gmail-mcp/credentials.json` | — | Access/refresh tokens |

---

## 5. 4DX Daily Plan Skill

### How It Works

The skill runs **inside the container agent**. It is triggered by specific phrases and reads/writes from the group's `/workspace/group/4dx/` folder. It also has cron-scheduled auto-triggers registered by `scripts/setup-4dx-crons.ts`.

### Intent Detection

| Trigger phrase | Intent | Action |
|---------------|--------|--------|
| "daily plan", "morning plan", "M1", "today plan", "what should I focus on today" | Generate plan | Run Steps 1–4 |
| "add commitment", "update M1", "WIG N + verb" | Mutate commitments | Run CM-1 to CM-5 |

### Morning Plan Generation (Steps 1–4)

```mermaid
flowchart TD
    T[Trigger: M1 phrase] --> S1[Step 1: Date Computation<br/>DATE_ISO, WEEKDAY, days-to-deadline]
    S1 --> S2[Step 2: WIG Selection<br/>Apply urgency signals from wig-signals.json<br/>Pick top 2 WIGs]
    S2 --> S3[Step 3: Plan Generation<br/>Today WIG Focus<br/>Daily Time Box<br/>Lead Measure Commitments<br/>Whirlwind Watch<br/>4DX Scoreboard<br/>Binary Win Check]
    S3 --> S4[Step 4: Save<br/>Write daily/YYYY-MM-DD.md<br/>Update scoreboard.json]
```

### WIG Priority Rules (Step 2)

```mermaid
flowchart TD
    W[Each WIG] --> D1{Deadline ≤ 7 days?}
    D1 -- Yes --> P1[AUTO-SELECT highest priority]
    D1 -- No --> D2{Deadline ≤ 14 days?}
    D2 -- Yes --> P2[High priority candidate]
    D2 -- No --> D3{Lag measure at_risk/losing?}
    D3 -- Yes --> P3[Elevate]
    D3 -- No --> D4{Lead streak = 0?}
    D4 -- Yes --> P4[Elevate]
    D4 -- No --> D5{Open signals in wig-signals.json?}
    D5 -- Yes --> P5[Elevate]
    D5 -- No --> D6[Base priority]
```

### Commitment Mutation Flow (CM-1 to CM-5)

```mermaid
flowchart TD
    T2[Trigger: add/update/remove commitment] --> CM1[CM-1: Load wig.json + scoreboard.json]
    CM1 --> CM2[CM-2: Parse intent<br/>operation, WIG id, action, due time]
    CM2 --> CM3{CM-3: Validate<br/>WIG exists? today.date = today?<br/>No duplicate?}
    CM3 -- Invalid --> ERR[Return error / list commitments]
    CM3 -- Valid --> CM4[CM-4: Execute mutation<br/>inline Python on scoreboard.json]
    CM4 --> CM5[CM-5: Confirm<br/>Show changed row or full table]
```

### Sequence Diagram — Scheduled Morning Plan

```mermaid
sequenceDiagram
    participant Cron as Cron 08:30 weekdays
    participant Sched as Task Scheduler
    participant DB as SQLite
    participant Ctr as Container Agent
    participant Skill as 4DX Skill (in container)
    participant FS as /workspace/group/4dx/
    participant Chan as Channel (Lark/WhatsApp)

    Cron->>Sched: scheduled trigger fires
    Sched->>DB: getDueTasks()
    DB-->>Sched: M1 task
    Sched->>Ctr: spawn container with prompt "daily plan"
    Ctr->>Skill: interpret SKILL.md + CLAUDE.md
    Skill->>FS: read wig.json, wig-signals.json, scoreboard.json
    FS-->>Skill: WIG data + signals
    Skill->>Skill: compute date, select WIGs, generate plan
    Skill->>FS: write daily/YYYY-MM-DD.md
    Skill->>FS: update scoreboard.json (m1_commitments)
    Ctr-->>Sched: stream output markers
    Sched->>Chan: sendMessage(plan text)
```

### Scheduled Tasks

| Task | Cron | Purpose |
|------|------|---------|
| M1 Daily Plan | `30 8 * * 1-5` | Morning plan at 08:30 weekdays |
| M7 EOD Summary | `0 16 * * 1-5` | End-of-day review at 16:00 weekdays |
| Weekly Cadence | `0 9 * * 5` | Weekly review at 09:00 Friday |

---

## 6. Cross-Feature Integration

### WIG Signals — Shared Data Bus

All three features share `wig-signals.json` as a live signal bus:

```mermaid
flowchart LR
    subgraph Channels
        L[Lark<br/>detects WIG keywords]
        G[Gmail<br/>detects WIG keywords]
    end
    subgraph Signals
        WS[(wig-signals.json<br/>open / resolved)]
    end
    subgraph 4DX Plan
        S2[Step 2: WIG Selection<br/>elevate if open signals]
        S3[Step 3: Whirlwind Watch<br/>show blockers + resolutions]
    end

    L -->|upsertWigSignal| WS
    G -->|upsertWigSignal| WS
    WS --> S2
    WS --> S3
```

### Full End-to-End Flow — Blocker to Plan

```mermaid
sequenceDiagram
    participant Lark as Lark Channel
    participant Signals as wig-signals.json
    participant Sched as Scheduler (08:30)
    participant Agent as Container Agent
    participant Plan as daily/YYYY-MM-DD.md
    participant User as User (Lark/WhatsApp)

    Note over Lark: User posts blocker message mentioning WIG keyword
    Lark->>Signals: upsertWigSignal(open, wig_id, snippet)
    Note over Sched: Next morning, M1 cron fires
    Sched->>Agent: spawn — "daily plan"
    Agent->>Signals: read wig-signals.json
    Signals-->>Agent: open blocker for WIG-2
    Agent->>Agent: elevate WIG-2 priority in Step 2
    Agent->>Agent: add blocker to Whirlwind Watch in Step 3
    Agent->>Plan: write daily plan with WIG-2 highlighted
    Agent-->>User: send formatted plan via channel

    Note over Lark: Later — user posts resolution
    Lark->>Signals: upsertWigSignal(resolved, wig_id)
    Note over Sched: Next plan generation
    Agent->>Signals: read — blocker now resolved ✅
    Agent->>Agent: show ✅ in Whirlwind Watch
```

---

## 7. Data & Folder Structure

```
groups/{folder}/
├── CLAUDE.md                 # Group memory & persistent context
├── vips.md                   # VIP sender list (Gmail urgency)
├── 4dx/
│   ├── wig.json              # WIG definitions (deadlines, leads, areas)
│   ├── scoreboard.json       # Session state (focus WIGs, M1 commitments, M7 verdict)
│   └── wig-signals.json      # Blocker/resolution signals (Lark + Gmail sourced)
├── daily/
│   └── YYYY-MM-DD.md         # Daily plan output
├── lark/
│   └── latest.md             # Lark digest cache (written by digest-runner)
└── gmail/
    └── latest.md             # Gmail digest cache (written by digest-runner)
```

### Key JSON Schemas

**`wig.json`** — WIG definitions:
```json
{
  "wigs": [
    {
      "id": "WIG-1",
      "name": "...",
      "area": "Farmer",
      "deadline": "2026-06-30",
      "lag_measure": "...",
      "lead_measures": ["...", "..."],
      "keywords": ["...", "..."]
    }
  ]
}
```

**`scoreboard.json`** — Session state:
```json
{
  "today": {
    "date": "2026-03-17",
    "wig_focus": ["WIG-1", "WIG-2"],
    "m1_commitments": [
      { "wig": "WIG-1", "lead_measure": "...", "action": "...", "due": "12:00" }
    ],
    "m7_verdict": null
  }
}
```

**`wig-signals.json`** — Active signals:
```json
{
  "signals": [
    {
      "wig_id": "WIG-1",
      "status": "open",
      "channel": "lark",
      "correlation_key": "lark:chat-abc123",
      "snippet": "...",
      "first_ts": "2026-03-17T09:00:00Z"
    }
  ]
}
```
