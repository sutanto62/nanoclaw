---
name: 4dx-daily-plan
description: Morning 4DX daily plan (M1) and surface 2 of most urgent WIGs today, commit to Lead Measure actions, and flag whirlwind blockers. Trigger on: "daily plan", "morning plan", "plan my day", "M1", "today plan", "what should I focus on today", or start of working day. Also handles commitment mutations: "add commitment", "update M1", "remove commitment", etc.
---

## Intent Detection

Detect intent before doing anything else:

**INTENT A — Generate Morning Plan**
Triggers: "daily plan", "morning plan", "plan my day", "M1", "today plan",
          "what should I focus on today"
→ Execute Steps 1–4 (existing flow).

**INTENT B — Mutate Commitments**
Triggers: message contains "add commitment", "add M1", "update M1",
          "update commitment", "new commitment", "change commitment",
          "remove commitment", "delete M1", "log commitment",
          or free-form text with "WIG [N]" + an action verb.
→ Execute Commitment Mutation Flow (below). Skip Steps 1–4.

---

## Storage Protocol

### On startup

Read `4dx/wig.json`, `4dx/scoreboard.json`, `north-star.json`, and `4dx/wig-signals.json` from the group workspace:

```bash
cat /workspace/group/4dx/wig.json 2>/dev/null || echo "NO_CONFIG"
cat /workspace/group/4dx/scoreboard.json 2>/dev/null || echo "NO_STATE"
cat /workspace/group/north-star.json 2>/dev/null || echo "NO_NORTHSTAR"
cat /workspace/group/4dx/wig-signals.json 2>/dev/null || echo "NO_SIGNALS"
cat /workspace/group/4dx/wig-context.md 2>/dev/null || echo "NO_CONTEXT"
```

Use these files as the authoritative source for WIG definitions, scoreboard, and carry_forward.
`wig-signals.json` provides real-time WIG blockers and resolutions — use it in Step 2 and Step 3 instead of hallucinating Whirlwind content.
`wig-context.md` is a pre-filtered channel cache scan (Lark + Gmail) for WIG/Whirlwind-related messages — use it to supplement `wig-signals.json` in Step 2 and Step 3.
`north-star.json` provides yearly objectives and quarterly Key Results — use it to show KR progress in Step 3 and to elevate WIGs whose parent KR is `at_risk` or `losing` in Step 2.

If `wig-signals.json` returns `NO_SIGNALS`: proceed without signals — Whirlwind Watch falls back to inference.
If `wig-context.md` returns `NO_CONTEXT`: proceed without it — no error, `wig-signals.json` still applies.
If `north-star.json` returns `NO_NORTHSTAR`: skip the North Star Pulse section in Step 3.
Do NOT re-derive this information from prose.

If `wig.json` returns `NO_CONFIG`: stop and reply — "⚠️ WIG configuration not found. Create `4dx/wig.json` in your group workspace before running the daily plan."

If `scoreboard.json` returns `NO_STATE`: initialize a fresh scoreboard with empty `scoreboard` array and empty `carry_forward`. Do not abort — this is expected on first run.

**North Star linkage:** For each WIG id, find matching `wig_ids` entries in `north-star.json` objectives → key_results. A WIG whose parent KR has `verdict: "at_risk"` or `"losing"` is treated the same as `lag_status = "at_risk"` in the urgency signal table (Step 2).

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
| WIG id has entries in `wig-context.md` (last 24h) | Elevate priority — active channel discussion. |
| WIG id appears in 3+ entries in `wig-context.md` | Strong candidate — sustained discussion. |
| Parent KR in `north-star.json` has `verdict: "at_risk"` | Elevate priority — quarterly target at risk. |
| Parent KR in `north-star.json` has `verdict: "losing"` | Highest priority — quarterly target falling behind. |

> **Rule:** If a WIG has a `deadline` and it is ≤ 7 days away, always auto-select it regardless of rotation logic.

---

## Step 3 — Generate the Daily Plan

Output the plan in Telegram-compatible format. Use *bold* (single asterisk) for section headers. Do NOT use markdown tables — Telegram does not render them. Use structured lists instead.

**IMPORTANT: Output ALL sections below in full. Do NOT skip, abbreviate, or omit any section — especially the Daily Time Box.**

---

*🗓️ Daily Plan — [Day, Date]*

*Today's WIG Focus:*
• WIG [X] — [Name] ([Area]): [description as lag context] — [1-line urgency rationale]
• WIG [Y] — [Name] ([Area]): [description as lag context] — [1-line urgency rationale]

---

🕐 *Daily Time Box*

`08:00` 🎯 WIG Deep Work — [action, no Slack/email] _([WIG X] Lead Measure)_
`10:00` ⭐ Northstar — [action] _(Scoreboard: [lag measure check])_
`11:30` 🌪️ Whirlwind — [action]
`12:30` 🍽️ Lunch
`13:30` 🌪️ Whirlwind — [action]
`14:00` 🎯 WIG — [action] _(Lead Measure: [WIG Y])_
`15:00` ⭐ Northstar — [action] _(Scoreboard: [lag measure check])_
`16:00` 📈 Update scoreboard + review lead measures
`17:00` 📈 EOD wrap-up + lock tomorrow's 08:00 WIG task

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
- For each signal with `status: "open"` AND `first_ts` within last 7 days: one bullet — `snippet` as blocker, `channel + sender` as source, `first_ts` as raised date. If `source_url` is set, append `[Open in Lark](source_url)` inside the italics.
- For each signal with `status: "resolved"` AND `updated_ts` = today: one ✅ bullet with `resolution_snippet`.
- If no signals: write "_No open blockers_".

Also check `wig-context.md` "Whirlwind / Untagged Mentions" section. For each entry not already covered by a `wig-signals.json` open signal (match by snippet similarity): add as a bullet with channel, sender, and timestamp. Label source as _(Source: cache scan)_.

• [Blocker / Risk] _(Source: [channel — sender] · Raised: [first_ts date] · [Open in Lark](source_url))_ → [Action to unblock]
✅ [Resolution note] _(resolved today)_

_No open blockers_ — if no active blockers

---

📊 *4DX Scoreboard*

• WIG [X] — [Name] ([Area]) | Q: 🟢/🟡/🔴 | Week: ✅/❌
• WIG [Y] — [Name] ([Area]) | Q: 🟢/🟡/🔴 | Week: ✅/❌

_🟢 On track · 🟡 At risk · 🔴 Behind · ✅ Lead measures hit this week · ❌ Missed_

---

🌟 *North Star Pulse*

(Omit this section if `north-star.json` returned `NO_NORTHSTAR`.)

For each objective in `north-star.json`, show the current-quarter KR only. Format:

• [Objective name] → [KR description] | [current] / [target] [unit] | [score × 100]% | [verdict emoji]
  ↳ WIGs driving this: WIG X, WIG Y

Verdict emoji: 🏆 winning · 🟢 on_track · 🟡 at_risk · 🔴 losing

_Source: north-star.json — update `current` values via M7 or weekly cadence._

---

🏆 *Binary Win Check*

☐ Protected 08:00–09:30 WIG block? (no Slack, no email)
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

---

## Commitment Mutation Flow

Execute this flow when **INTENT B** is detected. Skip Steps 1–4.

### CM-1 — Load state

```bash
cat /workspace/group/4dx/wig.json 2>/dev/null || echo "NO_CONFIG"
cat /workspace/group/4dx/scoreboard.json 2>/dev/null || echo "NO_STATE"
```

### CM-2 — Parse intent from message

Extract:
- **operation**: `add` | `update` | `remove`
- **wig_id**: integer. Match by number ("WIG 2") or name alias from `wig.json`
- **lead_measure**: match against `wig.json leads[].name`; fall back to user's literal text
- **action**: specific commitment text
- **due**: parse time expressions ("EOD", "15:00", "end of day"); default to `"EOD"`

### CM-3 — Validate

| Case | Response |
|------|----------|
| WIG ID not in wig.json | List valid WIGs, ask to clarify |
| `today.date` ≠ today | Block write: "Run M1 first to initialize today's session." |
| Duplicate action on same WIG (add) | Ask: "This action already exists for WIG N. Update or add as new?" |
| `remove` — no match | List current commitments numbered 1–N, ask which to remove |
| WIG not in `today.wig_focus` | Allow write, note: "WIG N isn't in today's focus (WIGs X, Y). Added anyway." |

### CM-4 — Write back

Build and run an inline Python script with the real operation substituted:

```python
import json
from datetime import date

today = date.today().isoformat()

with open('/workspace/group/4dx/scoreboard.json') as f:
    state = json.load(f)

if state.get('today', {}).get('date') != today:
    print('DATE_MISMATCH')
else:
    commitments = state['today'].get('m1_commitments') or []

    # ADD: append new entry
    # new_entry = {'wig': WIG_ID, 'lead_measure': 'LEAD', 'action': 'ACTION', 'due': 'DUE'}
    # commitments.append(new_entry)

    # UPDATE: find by wig + approximate action match, replace fields
    # for c in commitments:
    #     if c['wig'] == WIG_ID and 'KEYWORD' in c['action'].lower():
    #         c['action'] = 'NEW_ACTION'
    #         c['due'] = 'NEW_DUE'
    #         break

    # REMOVE: filter out matched entry
    # commitments = [c for c in commitments if not (c['wig'] == WIG_ID and 'KEYWORD' in c['action'].lower())]

    state['today']['m1_commitments'] = commitments
    state['updated'] = today

    with open('/workspace/group/4dx/scoreboard.json', 'w') as f:
        json.dump(state, f, indent=2)
    print('COMMIT_DONE')
```

If output is `DATE_MISMATCH`: reply "Run M1 first to initialize today's session."

### CM-5 — Confirm to user

Build the commitments table using this Python snippet (run inline after CM-4):

```python
from datetime import date

def fmt_table(commitments):
    date_label = date.today().strftime('%B %Y')
    sep = '─' * 52
    lines = [
        f"Commitments — {date_label}",
        '',
    ]
    for c in commitments:
        action = c['action'][:35] + '…' if len(c['action']) > 35 else c['action']
        lines.append(f"WIG {c['wig']}  {action:<37}{c['due']:>5}")
    total = len(commitments)
    lines.append(sep)
    lines.append(f"Total  {total} commitment{'s' if total != 1 else ''}")
    return '\n'.join(lines)
```

Wrap the result in triple backticks when printing to the reply.

For **add**:

✅ Commitment added to today's M1:

🎯 WIG [N] — [Name]
• [Action] — [due]

```
Commitments — [Month Year]

WIG X  [action]                              [due]
WIG Y  [action]                              [due]
────────────────────────────────────────────────────
Total  [N] commitments
```

For **update**: show the changed row (before → after), then the full updated table wrapped in triple backticks.

For **remove**: confirm which entry was removed by name, then show remaining commitments in the same table format wrapped in triple backticks.
