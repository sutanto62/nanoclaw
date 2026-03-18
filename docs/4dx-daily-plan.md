# 4DX Daily Plan Skill

The `4dx-daily-plan` skill generates a structured morning daily plan (M1) aligned to the **4 Disciplines of Execution (4DX)** framework. It selects the 2 highest-urgency WIGs for the day, builds a time-boxed schedule, defines lead measure commitments, and writes a scoreboard snapshot — all triggered from a chat message or a scheduled cron task.

---

## 4DX Framework Context

4DX is built on four disciplines:

1. **Focus on the Wildly Important Goal (WIG)** — identify 1–3 goals that matter most this quarter
2. **Act on Lead Measures** — measure the inputs (predictive behaviors) not just the outcomes (lag measures)
3. **Keep a Compelling Scoreboard** — visible tracking of lag vs. lead progress
4. **Create a Cadence of Accountability** — recurring commitment rituals (M1 morning / M7 EOD / weekly cadence)

The skill implements disciplines 2–4 daily and reads WIG configuration (discipline 1) from a file you maintain.

---

## Skill Components

| File | Purpose |
|------|---------|
| `container/skills/4dx-daily-plan/SKILL.md` | Container agent instructions (intent detection, all steps, output format) |
| `.claude/skills/4dx-daily-plan/manifest.yaml` | Install manifest — declares files added and version |
| `scripts/setup-4dx-crons.ts` | Registers M1, M7, and weekly cadence scheduled tasks in SQLite |
| `src/wig-signals.ts` | Host-side library that captures and upserts WIG signals from all channels |

Per-group data lives under `groups/{folder}/4dx/`:

| File | Created by | Purpose |
|------|-----------|---------|
| `wig.json` | You (manual) | WIG definitions — names, areas, deadlines, lead measures |
| `scoreboard.json` | Skill (auto) | Rolling scoreboard + today's session state |
| `wig-signals.json` | Host process (auto) | Real-time WIG blockers and resolutions captured from channels |

---

## Trigger Patterns

The skill detects two intents before doing anything else.

### Intent A — Generate Morning Plan (M1)

Triggers on: `daily plan`, `morning plan`, `plan my day`, `M1`, `today plan`, `what should I focus on today`

Executes Steps 1–4 (date → WIG selection → plan output → save).

### Intent B — Mutate Commitments

Triggers on: `add commitment`, `add M1`, `update M1`, `update commitment`, `new commitment`, `change commitment`, `remove commitment`, `delete M1`, `log commitment`, or any message containing `WIG [N]` plus an action verb.

Executes the Commitment Mutation Flow (CM-1 through CM-5). Steps 1–4 are skipped.

---

## Data Layer

### `wig.json` — WIG Definitions

Author and maintain this file manually. It is the authoritative source for WIG configuration.

```json
{
  "quarter": "Q2 2025",
  "wigs": [
    {
      "id": 1,
      "name": "ERP Delivery — Go-live by March 16",
      "area": "Whirlwind",
      "deadline": "2026-03-16",
      "description": "From not live to live (current: in-progress)",
      "lag": {
        "metric": "Go-live date",
        "baseline": "not live",
        "target": "live",
        "current": "in-progress"
      },
      "leads": [
        { "name": "Sprint blocker resolved", "unit": "count/day", "weekly_target": 5 },
        { "name": "Stakeholder alignment session", "unit": "session/week", "weekly_target": 1 },
        { "name": "UAT completion", "unit": "%", "weekly_target": 80 }
      ]
    }
  ]
}
```

Key fields:

| Field | Type | Notes |
|-------|------|-------|
| `id` | integer | Stable identifier used in scoreboard and signals |
| `area` | string | e.g. `Whirlwind`, `Farmer` — shown next to WIG name in output |
| `deadline` | ISO date or `null` | Drives auto-selection urgency signals |
| `description` | string | Lag narrative in "from X to Y (current: Z)" format |
| `lag.current` | any | Current lag measure value — used in scoreboard display |
| `leads[].name` | string | Matched during commitment mutations (CM-2) |

### `scoreboard.json` — Rolling State

Written by the skill after each M1 and M7 session. Do not edit manually during a live day.

```json
{
  "updated": "2026-03-17",
  "week": "2026-W12",
  "scoreboard": {
    "wig1": {
      "lag_status": "winning",
      "lag_current": "live",
      "lead_streak": 5,
      "weekly_done": 6,
      "weekly_target": 5
    }
  },
  "today": {
    "date": "2026-03-17",
    "wig_focus": [1, 3],
    "m1_commitments": [
      {
        "wig": 1,
        "lead_measure": "UAT completion",
        "action": "Confirm Odoo live/delayed status and update scoreboard",
        "due": "09:00"
      }
    ],
    "m7_completed": null,
    "m7_verdict": null,
    "m7_summary": null
  },
  "carry_forward": [
    "Decide overpayment edge case strategy — no decision yet since Mar 9"
  ]
}
```

`lag_status` values: `winning` | `on_track` | `at_risk` | `losing`

`today` is reset each M1 run. `m7_*` fields are populated by the EOD summary skill (M7).

### `wig-signals.json` — Real-time Blockers

Written by the host process (`src/wig-signals.ts`) as messages arrive on any channel. Read by the skill during Step 2 (WIG selection) and Step 3 (Whirlwind Watch section).

```json
{
  "generated": "2026-03-17T14:29:19.039Z",
  "signals": [
    {
      "id": "lark:lark:oc_ef503...:1773627541145",
      "first_ts": "2026-03-13T04:52:33.453Z",
      "updated_ts": "2026-03-17T14:29:18.994Z",
      "channel": "lark",
      "correlation_key": "lark:oc_ef50369c238108d5fe871bc2aaa5f78f",
      "sender": "ou_ecbffc73f144ee7b8f952c4672d4da5a",
      "wig_ids": [2],
      "status": "open",
      "snippet": "nitip raise ke Techmarbles related discount order line...",
      "resolution_snippet": null
    }
  ]
}
```

| Field | Notes |
|-------|-------|
| `wig_ids` | WIG IDs this signal was tagged to (via keyword matching against `wig.json`) |
| `status` | `open` or `resolved` |
| `snippet` | Latest message content (truncated) |
| `resolution_snippet` | Set when a resolution keyword is detected in a follow-up message |
| `first_ts` | When the signal was first seen |
| `updated_ts` | Last write time |

Resolved signals older than 7 days are pruned automatically.

---

## M1 Generation Flow

### Step 1 — Get Today's Date

The agent runs a Python one-liner to get `DATE_ISO`, `DATE_LABEL`, and `WEEKDAY`. It computes days remaining to each WIG deadline from `wig.json` for urgency scoring.

If `WEEKDAY` is 5 or 6 (Saturday/Sunday): a shortened plan is produced — WIG Focus and Lead Measures only, no full time box.

### Step 2 — Select Today's 2 WIGs

All WIGs from `wig.json` are evaluated against urgency signals in priority order:

| Signal | Rule |
|--------|------|
| Deadline ≤ 7 days | Highest priority — auto-select regardless of rotation |
| Deadline ≤ 14 days | High priority — strong candidate |
| `lag_status = "at_risk"` or `"losing"` | Elevate priority |
| `lead_streak = 0` (missed last session) | Elevate priority |
| `weekly_done = 0` and it's mid-week | Elevate to prevent stall |
| WIG id in `wig-signals.json` with `status: "open"` | Elevate — active blocker |
| WIG appears in 2+ open signals | Strong candidate — repeated blocker |

The top 2 WIGs by this evaluation become today's focus.

### Step 3 — Generate the Daily Plan

Output is Telegram-compatible (single `*asterisk*` bold, no markdown tables). The plan always contains all of these sections:

```
🗓️ Daily Plan — [Day, Date]

Today's WIG Focus
  • WIG [X] — [Name] ([Area]): [lag context] — [urgency rationale]
  • WIG [Y] — [Name] ([Area]): [lag context] — [urgency rationale]

🕐 Daily Time Box
  08:00  WIG Deep Work — [action]  (WIG X Lead Measure)
  10:00  Northstar — [action]  (lag measure check)
  11:30  Whirlwind — [action]
  12:30  Lunch
  13:30  Whirlwind — [action]
  14:00  WIG — [action]  (Lead Measure: WIG Y)
  15:00  Northstar — [action]  (lag measure check)
  16:00  Update scoreboard + review lead measures
  17:00  EOD wrap-up + lock tomorrow's 08:00 WIG task

✅ Lead Measure Commitments
  WIG [X] — [Name]
  • [Specific action] — Cayadi · EOD/[time]
  WIG [Y] — [Name]
  • [Specific action] — Cayadi · EOD/[time]

⚠️ Whirlwind Watch
  (populated from wig-signals.json — open signals from last 7 days)

📊 4DX Scoreboard
  • WIG [X] — [Name] ([Area]) | Q: 🟢/🟡/🔴 | Week: ✅/❌

🏆 Binary Win Check
  ☐ Protected 08:00–09:30 WIG block?
  ☐ Moved ≥ 1 Lead Measure today?
```

**Whirlwind Watch** rules:
- Open signal with `first_ts` within last 7 days → one bullet with snippet, channel, sender, date
- Resolved signal with `updated_ts` = today → `✅` bullet with `resolution_snippet`
- No signals → `_No open blockers_`

### Step 4 — Save the Plan

Two writes happen:

1. `/workspace/group/daily/{DATE_ISO}.md` — full plan text
2. `/workspace/group/4dx/scoreboard.json` — `today` object set with `wig_focus`, `m1_commitments`, and cleared `m7_*` fields

The scoreboard update is done with an inline Python script that uses real values from the session (not hardcoded).

---

## Commitment Mutation Flow

Runs when Intent B is detected. Steps 1–4 are skipped entirely.

### CM-1 — Load State

Reads `wig.json` and `scoreboard.json` from the group workspace.

### CM-2 — Parse Intent

Extracts from the message:

| Field | Parsing rule |
|-------|-------------|
| `operation` | `add` / `update` / `remove` |
| `wig_id` | Match by number ("WIG 2") or name alias from `wig.json` |
| `lead_measure` | Match against `wig.json leads[].name`; fall back to literal text |
| `action` | Specific commitment text |
| `due` | Parses "EOD", "15:00", "end of day" — defaults to `"EOD"` |

### CM-3 — Validate

| Case | Response |
|------|----------|
| WIG ID not in `wig.json` | Lists valid WIGs, asks to clarify |
| `today.date` ≠ today | Blocks write: "Run M1 first to initialize today's session." |
| Duplicate action on same WIG (add) | Asks: "This action already exists for WIG N. Update or add as new?" |
| `remove` — no match | Lists current commitments 1–N, asks which to remove |
| WIG not in `today.wig_focus` | Allows write, notes: "WIG N isn't in today's focus (WIGs X, Y). Added anyway." |

### CM-4 — Write Back

An inline Python script performs the operation (`append` / keyword-match replace / filter) on `scoreboard.json['today']['m1_commitments']` and writes the file atomically. If `today.date` doesn't match the current date, the script prints `DATE_MISMATCH` and no write happens.

### CM-5 — Confirm to User

Displays a confirmation message followed by the full commitments table in a code block:

```
✅ Commitment added to today's M1:

🎯 WIG 1 — ERP Delivery
• Confirm Odoo go-live status — 09:00

Commitments — March 2026

WIG 1  Confirm Odoo go-live status               09:00
WIG 3  Review KebunPRO onboarding funnel          15:30
────────────────────────────────────────────────────────
Total  2 commitments
```

For **update**: shows changed row (before → after) then the updated table.
For **remove**: confirms which entry was removed, then shows remaining commitments.

---

## Output Example

```
🗓️ Daily Plan — Monday, 17 March 2026

*Today's WIG Focus:*
• WIG 1 — ERP Delivery (Whirlwind): From not live to live — deadline was yesterday, go-live in progress
• WIG 3 — Grow Smallholder Segment (Farmer): From 200 to 500 (current: 320) — lead_streak=0, weekly_done=0 mid-week stall

---

🕐 *Daily Time Box*

`08:00` 🎯 WIG Deep Work — Resolve 3 open UAT blockers (no Slack/email) _(WIG 1 Lead Measure)_
`10:00` ⭐ Northstar — Check go-live readiness dashboard _(Scoreboard: Go-live date)_
`11:30` 🌪️ Whirlwind — Stakeholder sync + ops queue
`12:30` 🍽️ Lunch
`13:30` 🌪️ Whirlwind — Sprint review + tickets
`14:00` 🎯 WIG — Review KebunPRO onboarding funnel _(Lead Measure: WIG 3)_
`15:00` ⭐ Northstar — Check smallholder active user count _(Scoreboard: Active smallholder users)_
`16:00` 📈 Update scoreboard + review lead measures
`17:00` 📈 EOD wrap-up + lock tomorrow's 08:00 WIG task
...
```

---

## Scheduled Tasks

Run `npx tsx scripts/setup-4dx-crons.ts [group-folder]` once per group to register three cron tasks in SQLite. The default group is `telegram_main`.

| Task | Cron | Prompt sent to agent |
|------|------|---------------------|
| M1 Daily Plan | `30 8 * * 1-5` (08:30 Mon–Fri) | `Generate my 4DX morning daily plan (M1) for today.` |
| M7 EOD Summary | `0 16 * * 1-5` (16:00 Mon–Fri) | `Generate my 4DX end-of-day summary (M7) for today.` |
| Weekly Cadence | `0 9 * * 5` (09:00 Friday) | `Generate my weekly 4DX cadence review.` |

The script checks for existing 4DX tasks before creating new ones — re-running it is safe.

Timezone is taken from `src/config.ts` (`TIMEZONE`). For Asia/Jakarta the cron times are local WIB.

---

## WIG Signals Integration

`src/wig-signals.ts` runs in the host NanoClaw process and is called by channel handlers when inbound messages arrive. It:

1. **Tags WIG IDs** — tokenizes the message text and matches against keywords extracted from `wig.json` names and lead measure names
2. **Upserts a signal** — if a signal with the same `correlation_key` already exists, updates the snippet; if the new content contains a resolution keyword (resolved, approved, fixed, unblocked, etc.), marks it `resolved`
3. **Prunes stale signals** — resolved signals older than 7 days are removed on every write
4. **Writes atomically** — writes to a `.tmp` file then renames to prevent partial reads

The agent reads `wig-signals.json` at startup (Storage Protocol) and uses it in:
- **Step 2** — open signals elevate WIG priority during selection
- **Step 3** — signals populate the Whirlwind Watch section instead of hallucinated blockers

---

## Installation

### 1. Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/4dx-daily-plan
npm run build
```

### 2. Create `wig.json` for your group

```bash
mkdir -p groups/{your-group-folder}/4dx
# Write groups/{your-group-folder}/4dx/wig.json with your WIG definitions
```

Use the schema above. The `id` field must be a stable integer — do not renumber WIGs once the scoreboard has history.

### 3. Register cron tasks

```bash
npx tsx scripts/setup-4dx-crons.ts {your-group-folder}
```

### 4. Trigger manually to verify

Send `M1` or `daily plan` to the group. The agent will read `wig.json`, select 2 WIGs, generate the plan, and confirm `Daily plan saved: daily/YYYY-MM-DD.md | scoreboard.json updated`.

If `wig.json` is missing the agent will reply: `⚠️ WIG configuration not found. Create 4dx/wig.json in your group workspace before running the daily plan.`
