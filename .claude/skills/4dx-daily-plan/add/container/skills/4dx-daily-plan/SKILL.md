---
name: 4dx-daily-plan
version: 1.0.0
description: >
  Generate Cayadi's structured morning daily plan using the 4DX framework.
  Use this skill whenever the user says "daily plan", "morning plan", "plan my day",
  "M1", "what should I focus on today", or starts a morning session.
  Produces an actionable checklist focused on 2 WIGs selected by urgency/date logic.
  Always trigger this skill at the start of a working day — do not answer freehand.
allowed-tools:
  - Bash
  - Read
  - Write
---

# 4DX Daily Plan (M1)

## Purpose

Generate a focused, actionable morning plan for Cayadi. Surface the 2 most urgent WIGs today, commit to Lead Measure actions, and flag whirlwind blockers.

## Trigger

Use this skill when the user says:
- "daily plan", "morning plan", "plan my day", "M1"
- "what should I focus on today", "what's today", "today plan", "today"
- Any morning session opener

---

## Storage Protocol

### On startup

Read `4dx/config.json` and `4dx/state.json` from the group workspace:

```bash
cat /workspace/group/4dx/config.json 2>/dev/null || echo "NO_CONFIG"
cat /workspace/group/4dx/state.json 2>/dev/null || echo "NO_STATE"
```

Use these files as the authoritative source for WIG definitions, scoreboard, and carry_forward.
Do NOT re-derive this information from prose.

### After plan generated

Update `state.json` with today's session data:
- Set `today.date` to `DATE_ISO`
- Set `today.wig_focus` to the 2 WIGs selected
- Set `today.m1_commitments` to the lead measure commitments (array of objects: `{wig, lead_measure, action, due}`)
- Clear `today.m7_completed`, `today.m7_verdict`, `today.m7_summary` to `null`
- Preserve `scoreboard` and `carry_forward` unchanged

> **Note:** Build and run the actual Python script inline with the real values from the session.

---

## Step 1 — Get today's date

```bash
python3 -c "
from datetime import date
d = date.today()
print(f'DATE_ISO={d.isoformat()}')
print(f'DATE_LABEL={d.strftime(\"%A, %d %B %Y\")}')
print(f'WEEKDAY={d.weekday()}')
print(f'DAYS_TO_MARCH16={(date(2026,3,16)-d).days}')
"
```

Set `DATE_ISO`, `DATE_LABEL`, `WEEKDAY`, `DAYS_TO_MARCH16`.

If `WEEKDAY` is 5 or 6: note "Weekend — optional check" and produce a shortened plan (WIG Focus + Lead Measures only).

---

## Step 2 — Select Today's 2 WIGs

Use the WIG definitions from `4dx/config.json` (loaded in Storage Protocol above). Evaluate all WIGs against the urgency signals below (in order). Pick the top 2.

### Urgency Signals

| Signal | Rule |
|---|---|
| Hard deadline ≤ 7 days | Highest priority. Auto-select. |
| Hard deadline ≤ 14 days | High priority. Strong candidate. |
| Lag measure `lag_status = "at_risk"` or `"losing"` | Elevate priority. |
| `lead_streak` = 0 (missed last session) | Elevate priority. |
| `weekly_done` = 0 and it's mid-week | Elevate to prevent stall. |

> **Rule:** If a WIG has a `deadline` and it is ≤ 7 days away, always auto-select it regardless of rotation logic.

---

## Step 3 — Generate the Daily Plan

Output the plan in this exact structure:

---

### 🗓️ Daily Plan — [Day, Date]

**Today's WIG Focus:**
- WIG [X] — [Name]: [1-line urgency rationale]
- WIG [Y] — [Name]: [1-line urgency rationale]

---

#### 🕐 Daily Time Box

| Time | Focus Type | Activity | 4DX Connection |
|---|---|---|---|
| 08:30–10:00 | 🎯 WIG (Deep Work) | [action — no Slack, no email] | 🎯 Focus + 🔧 Leverage — WIG [X] Lead Measure |
| 10:30 | ⭐ Northstar Metric | [action] | 📊 Visual — Scoreboard: [lag measure check] |
| 11:30 | 🌪️ Whirlwind | [action] | — |
| 12:30 | — | Lunch | — |
| 13:30 | 🌪️ Whirlwind | [action] | — |
| 14:30 | 🎯 WIG | [action] | 🔧 Leverage — Lead Measure: [specific lead, WIG Y] |
| 15:30 | ⭐ Northstar Metric | [action] | 📊 Visual — Scoreboard: [lag measure check] |
| 16:30 | 📈 Accountability | Update scoreboard + review lead measures | 🤝 Accountability — Score the day |
| 17:30 | 📈 Accountability | EOD wrap-up + commit tomorrow's 08:30 WIG task | 🤝 Accountability — Lock tomorrow's offense |

> **Focus types:** 🎯 WIG = deep work on WIGs · 🌪️ Whirlwind = meetings, ops, reactive · ⭐ Northstar Metric = lag measures & dashboards · 📈 Accountability = score + commit

---

#### ✅ Lead Measure Commitments

| WIG | Action | Owner | Due |
|---|---|---|---|
| WIG [X] — [Name] | [Specific action] | Cayadi | EOD / [time] |
| WIG [X] — [Name] | [Specific action] | Cayadi | EOD / [time] |
| WIG [Y] — [Name] | [Specific action] | Cayadi | EOD / [time] |
| WIG [Y] — [Name] | [Specific action] | Cayadi | EOD / [time] |

---

#### ⚠️ Whirlwind Watch

| Blocker / Risk | Unblock By |
|---|---|
| [Blocker description] | [Action to unblock] |

---

#### 📊 4DX Scoreboard

| WIG | Quarterly | This Week |
|---|---|---|
| WIG 1 — ERP Delivery | 🟢/🟡/🔴 | ✅/❌ |
| WIG 2 — Mid-Farmer CSAT | 🟢/🟡/🔴 | ✅/❌ |
| WIG 3 — Smallholder Growth | 🟢/🟡/🔴 | ✅/❌ |
| WIG 4 — Engineering Culture | 🟢/🟡/🔴 | ✅/❌ |

> 🟢 On track · 🟡 At risk · 🔴 Behind · ✅ Lead measures hit this week · ❌ Missed

---

#### 🏆 Binary Win Check

> Answer before closing the day.

| Question | Yes / No |
|---|---|
| Did I protect the 08:30–10:00 WIG block? (no Slack, no email) | |
| Did I move at least 1 Lead Measure today? | |

> Both Yes = 🏆 WIN. Either No = ❌ LOSS — you were a passenger in your own schedule.

---

*Plan generated: [timestamp] | Module: M1 Daily Plan*

---

## Output Rules

- Every action item: specific, starts with a verb, has owner + deadline.
- Lead Measures must name the specific process or artifact being changed — not "work on ERP" but "retire the Excel billing tracker for the Ops team."
- If today is Monday: add a one-line reminder → "📌 Weekly cadence: commit Lead Measures for the week."
- If WIG 1 deadline is ≤ 7 days away: always auto-select WIG 1 regardless of rotation logic.

## Time Box Rules

- Slots: 08:30–17:30. Lunch fixed at 12:30. EOD wrap at 17:30.
- WIG deep work: 08:30–10:00 = one continuous block. No interruptions. This is offense.
- Afternoon WIG: 14:30 — one focused slot for WIG Y lead measure.
- Northstar Metric: 10:30, 15:30 — review lag measures, dashboards, data.
- Whirlwind: 11:30, 13:30 — meetings, ops, reactive tasks.
- Accountability: 16:30 (scoreboard update) + 17:30 (EOD commit + tomorrow's 08:30 task locked).
- Never leave activity column blank — infer from context if not explicit.

---

## Step 4 — Save the plan

```bash
mkdir -p /workspace/group/daily
mkdir -p /workspace/group/4dx
```

Write `/workspace/group/daily/${DATE_ISO}.md` with the full plan output.

Then update `state.json` with today's commitments. Build a Python script that writes the real values:

```python
import json

with open('/workspace/group/4dx/state.json') as f:
    state = json.load(f)

state['updated'] = DATE_ISO  # actual date string
state['today'] = {
    'date': DATE_ISO,
    'wig_focus': [WIG_A_ID, WIG_B_ID],  # actual WIG ids (int)
    'm1_commitments': [
        # one entry per Lead Measure Commitment row:
        {'wig': WIG_ID, 'lead_measure': 'Lead name', 'action': 'Action text', 'due': 'HH:MM or EOD'},
    ],
    'm7_completed': None,
    'm7_verdict': None,
    'm7_summary': None
}

with open('/workspace/group/4dx/state.json', 'w') as f:
    json.dump(state, f, indent=2)

print('state.json updated')
```

Confirm: `Daily plan saved: daily/${DATE_ISO}.md | state.json updated`
