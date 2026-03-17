---
name: 4dx-daily-plan
description: Morning 4DX daily plan (M1) and surface 2 of most urgent WIGs today, commit to Lead Measure actions, and flag whirlwind blockers. Trigger on: "daily plan", "morning plan", "plan my day", "M1", "today plan", "what should I focus on today", or start of working day.
---

## Storage Protocol

### On startup

Read `4dx/wig.json` and `4dx/scoreboard.json` from the group workspace:

```bash
cat /workspace/group/4dx/wig.json 2>/dev/null || echo "NO_CONFIG"
cat /workspace/group/4dx/scoreboard.json 2>/dev/null || echo "NO_STATE"
cat /workspace/group/4dx/wig-signals.json 2>/dev/null || echo "NO_SIGNALS"
```

Use these files as the authoritative source for WIG definitions, scoreboard, and carry_forward.
`wig-signals.json` provides real-time WIG blockers and resolutions — use it in Step 2 and Step 3 instead of hallucinating Whirlwind content.

If `wig-signals.json` returns `NO_SIGNALS`: proceed without signals — Whirlwind Watch falls back to inference.
Do NOT re-derive this information from prose.

If `wig.json` returns `NO_CONFIG`: stop and reply — "⚠️ WIG configuration not found. Create `4dx/wig.json` in your group workspace before running the daily plan."

If `scoreboard.json` returns `NO_STATE`: initialize a fresh scoreboard with empty `scoreboard` array and empty `carry_forward`. Do not abort — this is expected on first run.

### After plan generated

Update `scoreboard.json` with today's session data:
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
"
```

Set `DATE_ISO`, `DATE_LABEL`, `WEEKDAY`.

Then compute days remaining for each WIG with a `deadline` field from `wig.json`. Use these to apply urgency signals in Step 2 — do not hardcode any deadline dates here.

If `WEEKDAY` is 5 or 6: note "Weekend — optional check" and produce a shortened plan (WIG Focus + Lead Measures only).

---

## Step 2 — Select Today's 2 WIGs

Use the WIG definitions from `4dx/wig.json` (loaded in Storage Protocol above). Each WIG now has `area` (e.g. `Whirlwind`, `Farmer`) and `description` (lag narrative in "from X to Y when date" format). Evaluate all WIGs against the urgency signals below (in order). Pick the top 2. When displaying WIGs, group by `area` and show the `area` tag next to each WIG name.

### Urgency Signals

| Signal | Rule |
|---|---|
| Hard deadline ≤ 7 days | Highest priority. Auto-select. |
| Hard deadline ≤ 14 days | High priority. Strong candidate. |
| Lag measure `lag_status = "at_risk"` or `"losing"` | Elevate priority. |
| `lead_streak` = 0 (missed last session) | Elevate priority. |
| `weekly_done` = 0 and it's mid-week | Elevate to prevent stall. |
| WIG id in `wig-signals.json` with `status: "open"` | Elevate priority — active blocker. |
| WIG id appears in 2+ open signals | Strong candidate — repeated blocker. |

> **Rule:** If a WIG has a `deadline` and it is ≤ 7 days away, always auto-select it regardless of rotation logic.

---

## Step 3 — Generate the Daily Plan

Output the plan in Telegram-compatible format. Use *bold* (single asterisk) for section headers. Do NOT use markdown tables — Telegram does not render them. Use structured lists instead.

---

🗓️ *Daily Plan — [Day, Date]*

*Today's WIG Focus:*
• WIG [X] — [Name] ([Area]): [description as lag context] — [1-line urgency rationale]
• WIG [Y] — [Name] ([Area]): [description as lag context] — [1-line urgency rationale]

---

🕐 *Daily Time Box*

`08:30` 🎯 WIG Deep Work — [action, no Slack/email] _([WIG X] Lead Measure)_
`10:30` ⭐ Northstar — [action] _(Scoreboard: [lag measure check])_
`11:30` 🌪️ Whirlwind — [action]
`12:30` 🍽️ Lunch
`13:30` 🌪️ Whirlwind — [action]
`14:30` 🎯 WIG — [action] _(Lead Measure: [WIG Y])_
`15:30` ⭐ Northstar — [action] _(Scoreboard: [lag measure check])_
`16:30` 📈 Update scoreboard + review lead measures
`17:30` 📈 EOD wrap-up + lock tomorrow's 08:30 WIG task

_🎯 WIG = deep work · 🌪️ Whirlwind = meetings/ops/reactive · ⭐ Northstar = lag measures · 📈 Accountability = score + commit_

---

✅ *Lead Measure Commitments*

🎯 WIG [X] — [Name]
• [Specific action] — Cayadi · EOD/[time]
• [Specific action] — Cayadi · EOD/[time]

🎯 WIG [Y] — [Name]
• [Specific action] — Cayadi · EOD/[time]
• [Specific action] — Cayadi · EOD/[time]

---

⚠️ *Whirlwind Watch*

Populate from `wig-signals.json` (loaded in Storage Protocol):
- For each signal with `status: "open"` AND `first_ts` within last 7 days: one bullet — `snippet` as blocker, `channel + sender` as source, `first_ts` as raised date.
- For each signal with `status: "resolved"` AND `updated_ts` = today: one ✅ bullet with `resolution_snippet`.
- If no signals: write "_No open blockers_".

• [Blocker / Risk] _(Source: [channel — sender] · Raised: [first_ts date])_ → [Action to unblock]
✅ [Resolution note] _(resolved today)_

_No open blockers_ — if no active blockers

---

📊 *4DX Scoreboard*

• WIG [X] — [Name] ([Area]) | Q: 🟢/🟡/🔴 | Week: ✅/❌
• WIG [Y] — [Name] ([Area]) | Q: 🟢/🟡/🔴 | Week: ✅/❌

_🟢 On track · 🟡 At risk · 🔴 Behind · ✅ Lead measures hit this week · ❌ Missed_

---

🏆 *Binary Win Check*

☐ Protected 08:30–10:00 WIG block? (no Slack, no email)
☐ Moved ≥ 1 Lead Measure today?

_Both Yes = 🏆 WIN · Either No = ❌ LOSS — you were a passenger in your own schedule._

---

_Plan generated: [timestamp] | Module: M1 Daily Plan_

---

## Output Rules

- Every action item: specific, starts with a verb, has owner + deadline.
- Lead Measures must name the specific process or artifact being changed — not "work on ERP" but "retire the Excel billing tracker for the Ops team."
- If today is Monday: add a one-line reminder → "📌 Weekly cadence: commit Lead Measures for the week."
- Any WIG with a deadline ≤ 7 days away is always auto-selected regardless of rotation logic (derived from `deadline` in wig.json, not hardcoded).

## Time Box Rules

- Slots: 08:00–17:00. Lunch fixed at 12:30. EOD wrap at 17:00.
- WIG deep work: 08:00–09:30 = one continuous block. No interruptions. This is offense.
- Afternoon WIG: 14:00 — one focused slot for WIG Y lead measure.
- Northstar Metric: 10:00, 15:00 — review lag measures, dashboards, data.
- Whirlwind: 11:30, 13:30 — meetings, ops, reactive tasks.
- Accountability: 16:00 (scoreboard update) + 17:00 (EOD commit + tomorrow's 08:00 task locked).
- Never leave activity column blank — infer from context if not explicit.

---

## Step 4 — Save the plan

```bash
mkdir -p /workspace/group/daily
mkdir -p /workspace/group/4dx
```

Write `/workspace/group/daily/${DATE_ISO}.md` with the full plan output.

Then update `scoreboard.json` with today's commitments. Build a Python script that writes the real values:

```python
import json
from datetime import date

date_iso = date.today().isoformat()

with open('/workspace/group/4dx/scoreboard.json') as f:
    state = json.load(f)

state['updated'] = date_iso
state['today'] = {
    'date': date_iso,
    'wig_focus': [1, 2],  # substitute actual WIG id integers selected in Step 2
    'm1_commitments': [
        # one entry per row in Lead Measure Commitments table — substitute real values:
        {'wig': 1, 'lead_measure': 'Lead name', 'action': 'Action text', 'due': 'HH:MM or EOD'},
    ],
    'm7_completed': None,
    'm7_verdict': None,
    'm7_summary': None
}

with open('/workspace/group/4dx/scoreboard.json', 'w') as f:
    json.dump(state, f, indent=2)

print('scoreboard.json updated')
```

Confirm: `Daily plan saved: daily/${DATE_ISO}.md | scoreboard.json updated`
