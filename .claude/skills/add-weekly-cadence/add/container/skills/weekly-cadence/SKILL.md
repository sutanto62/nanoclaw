--
name: add-weekly-cadence
version: 0.1.0
description: Weekly cadence skill structured as a 4DX "20-Minute Win" — audit past WIG commitments, update and study the scoreboard, then commit to next week's lead measure actions. Produces a personal WIG cadence file and a shareable team update. Use when user asks for "weekly cadence", "weekly review", "weekly wrap up", or "cadence".
---

# Weekly Cadence — 20-Minute Win

Three phases: **Report the Past → Update the Scoreboard → New Commitments**. Two outputs: personal WIG cadence and team update.

---

## Step 0: Compute Week Labels

```bash
python3 -c "
from datetime import date, timedelta
import sys

today = date.today()
iso = today.isocalendar()
year, week = iso[0], iso[1]

# Current week label
print(f'{year}-W{week:02d}')

# Week range (Mon–Sun)
mon = today - timedelta(days=today.weekday())
sun = mon + timedelta(days=6)
print(f'{mon.strftime(\"%d %b\")} \u2013 {sun.strftime(\"%d %b %Y\")}')

# Previous week label
prev = today - timedelta(weeks=1)
p_iso = prev.isocalendar()
print(f'{p_iso[0]}-W{p_iso[1]:02d}')
"
```

Set:
- `WEEK_LABEL` — e.g. `2026-W12`
- `WEEK_RANGE` — e.g. `16 Mar – 22 Mar 2026`
- `PREV_WEEK_LABEL` — e.g. `2026-W11`

Check if a file already exists for this week:

```bash
test -f /workspace/group/weekly/${WEEK_LABEL}.md && echo "exists" || echo "new"
```

If it exists, read it and offer to continue from where the user left off or start fresh.

---

## Phase 1 — Report the Past (~5 min)

Audit last week's WIG commitments. Show what was committed, what was done.

### 1A — Read prior session data

```bash
cat /workspace/group/4dx/sessions/${PREV_WEEK_LABEL}.json 2>/dev/null || echo "NO_SESSION"
cat /workspace/group/weekly/${PREV_WEEK_LABEL}.md 2>/dev/null || echo "NO_WEEKLY"
```

- If `sessions/{PREV_WEEK_LABEL}.json` exists: extract `lead_completions`, `lag_snapshots`, `weekly_summary`, and any `next_week.commitments` saved at the end of that session.
- If no session JSON but weekly `.md` exists: read the `## Next WIG Commitments` section from that file.
- If neither exists: skip Phase 1 and note "First session — no prior commitment data."

### 1B — Present commitment audit table

Show one message with the audit table. Wait for user's reply before proceeding.

```
*Phase 1 — Past Commitment Audit (Week {PREV_WEEK_LABEL})*

| WIG | Commitment | Status |
|-----|------------|--------|
| WIG 1 | [commitment from prior session] | ✅ Met / ❌ Missed / 🔄 Partial |
| WIG 2 | [commitment] | ✅ / ❌ / 🔄 |

Carry-forward items:
- [any carry_forward from prior scoreboard that were resolved or persist]

ok to confirm / correct any row (e.g. "WIG 2 was partial") / skip
```

After user confirms or corrects, proceed to Phase 2.

---

## Phase 2 — Update + Study the Scoreboard (~10 min)

### 2A — Prompt for lag measure updates

Before reading any data, ask:

```
*Phase 2A — Scoreboard Update*

Before we review — any lag measure numbers to update this week?
(e.g. ERP go-live %, CSAT score, active farmers, sales volume)

Enter updates or "ok" to skip.
```

If the user provides updates, apply them to `/workspace/group/4dx/scoreboard.json`:

```python
import json

with open('/workspace/group/4dx/scoreboard.json') as f:
    state = json.load(f)

# Apply user-provided updates — example:
# state['scoreboard']['wig1']['lag_current'] = NEW_VALUE
# state['scoreboard']['wig1']['lag_status'] = 'on_track'  # or 'at_risk' or 'losing'

state['updated'] = date.today().isoformat()
with open('/workspace/group/4dx/scoreboard.json', 'w') as f:
    json.dump(state, f, indent=2)
```

### 2B — Prompt for WIG config updates

Ask:

```
*Phase 2B — WIG Config Check*

Any WIG config changes this week?
- Deadlines moved
- Lag measure targets revised
- Lead measure weekly_target adjusted
- WIG description updated (the "from X to Y by date" narrative)

Enter changes or "ok" to proceed with existing config.
```

If the user provides changes, write them to `/workspace/group/4dx/wig.json` before proceeding. If "ok" or no changes, skip.

### 2C — Read and display scoreboard

```bash
cat /workspace/group/4dx/scoreboard.json 2>/dev/null || echo "NO_STATE"
cat /workspace/group/4dx/wig.json 2>/dev/null || echo "NO_CONFIG"
```

Present the scoreboard in one message:

```
*Phase 2C — Scoreboard*

| WIG | Lag Measure | Current | Target | Status | Lead Streak |
|-----|-------------|---------|--------|--------|-------------|
| WIG 1 | [metric name] | [lag_current] | [lag_target] | 🟢/🟡/🔴 | [n days] |
| WIG 2 | … | … | … | … | … |

Status key: 🟢 on_track  🟡 at_risk  🔴 losing
```

Status mapping:
- `on_track` → 🟢
- `at_risk` → 🟡
- `losing` → 🔴

### 2D — Query messages for signals

```bash
python3 -c "
import sqlite3, json
from datetime import date, timedelta

db_path = '/data/messages.db'
cutoff = (date.today() - timedelta(days=7)).isoformat()

try:
    conn = sqlite3.connect(db_path)
    rows = conn.execute('''
        SELECT sender_name, content, timestamp
        FROM messages
        WHERE timestamp >= ?
          AND is_bot_message = 0
        ORDER BY timestamp DESC
        LIMIT 200
    ''', (cutoff,)).fetchall()
    conn.close()
    print(json.dumps([{'sender': r[0], 'content': r[1], 'ts': r[2]} for r in rows]))
except Exception as e:
    print(f'NO_DB: {e}')
"
```

If `NO_DB`: skip message analysis, note "Message analysis unavailable — proceeding with scoreboard only."

If messages retrieved: cluster content into themes. For each WIG where `lag_status` is `at_risk` or `losing`, generate 2–3 specific, actionable suggestions sourced from message patterns, carry_forward items, and WIG context. Suggestions must be concrete (name an action, artifact, or person) — not generic advice.

Present suggestions:

```
*Phase 2D — Lead Measure Suggestions*

WIG [N] (🟡/🔴 [status]):
1. [Specific action grounded in message signals or carry_forward]
2. [Another specific action]

ok / adjust
```

Wait for user acknowledgment before Phase 3.

---

## Phase 3 — New Commitments (~5 min)

Walk through each WIG in priority order (at_risk / losing first). For each:

```
*Phase 3 — WIG [N] Commitment*

Lead measure: [lead_measure_name] (weekly target: [weekly_target])
Suggestions from Phase 2:
1. [suggestion]
2. [suggestion]

What is the one or two most important things you can do next week to impact this lead measure?

Commitments must:
- Start with a verb
- Name a specific artifact, action, or person
- Be completable in one week

Enter commitment(s) or "skip" to leave WIG [N] without a commitment.
```

After collecting commitments for all WIGs, confirm with user, then save to `scoreboard.json`:

```python
import json
from datetime import date

with open('/workspace/group/4dx/scoreboard.json') as f:
    state = json.load(f)

# Build next_week commitments from user input
state['next_week'] = {
    'week': WEEK_LABEL,
    'commitments': [
        # Example entry — build one per WIG commitment collected:
        # {'wig': 1, 'lead_measure': '...', 'action': '...', 'due': '2026-03-22'}
    ]
}

state['updated'] = date.today().isoformat()
with open('/workspace/group/4dx/scoreboard.json', 'w') as f:
    json.dump(state, f, indent=2)

print('Commitments saved to scoreboard.json next_week field.')
```

---

## Edge Cases

- **Interrupted mid-flow**: If the user sends an unrelated message before all 6 sections are done, save partial progress to the file and note which sections are still pending.
- **Re-run same week**: Read existing file, show current content per section, allow the user to update any section.
- **No workspace notes**: Skip pre-fill, ask open-ended questions instead.
