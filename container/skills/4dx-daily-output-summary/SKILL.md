---
name: 4dx-daily-output-summary
version: 1.0.0
description: >
  Generate Cayadi's structured EOD output summary using the 4DX framework.
  Use this skill whenever the user says "EOD", "end of day", "daily summary",
  "daily output", "wrap up my day", "M7", "how did today go", or starts an
  evening wrap-up session. Cross-references morning M1 commitments to produce
  a Whirlwind Ledger, WIG Output, Scoreboard delta, and a binary Win/Loss verdict.
  Always trigger this skill at the end of a working day — do not answer freehand.
allowed-tools:
  - Bash
  - Read
  - Write
  - mcp__gmail__*
---

# 4DX Daily Output Summary (M7)

## Purpose

Close the day with a high-contrast view of what was **maintained** (Whirlwind)
vs. what was **advanced** (WIG). Cross-reference morning M1 commitments.
Deliver a binary Win/Loss verdict. Keep the illusion of productivity honest.

## Trigger

Use this skill when the user says:
- "EOD", "end of day", "daily summary", "daily output", "wrap up my day", "M7"
- "how did today go", "close the day", "day wrap"
- Any evening session opener

---

## Storage Protocol

### On startup

Read structured state and config from the group workspace:

```bash
cat /workspace/group/4dx/scoreboard.json 2>/dev/null || echo "NO_STATE"
cat /workspace/group/4dx/wig.json 2>/dev/null || echo "NO_CONFIG"
cat /workspace/group/north-star.json 2>/dev/null || echo "NO_NORTHSTAR"
```

If `north-star.json` is present: for each WIG in today's `wig_focus`, look up linked KRs via `wig_ids`. After the summary is generated and the user confirms any lag measure updates, recompute KR `score` and `verdict` and write back to `north-star.json` (see "After summary generated" below).

If `north-star.json` returns `NO_NORTHSTAR`: proceed without it — skip the KR Impact column and north-star write-back.

From `scoreboard.json` extract:
- `today.m1_commitments` — the morning commitments to cross-reference (use instead of re-reading the markdown file)
- `today.wig_focus` — the WIGs selected this morning
- `scoreboard` — current lag_status, lag_current, weekly_done, weekly_target, lead_streak per WIG
- `carry_forward` — items from prior sessions

From `wig.json` extract WIG definitions (name, description, area, lag metric, leads with weekly_target). Use `description` when printing WIG focus context and `area` to label each WIG.

### After summary generated

Write back to `scoreboard.json`:

```python
import json
from datetime import date

with open('/workspace/group/4dx/scoreboard.json') as f:
    state = json.load(f)

# Set M7 fields
state['today']['m7_completed'] = [
    # one entry per commitment:
    {'wig': WIG_ID, 'lead_measure': 'Lead name', 'status': '✅ Done|➕ Bonus|❌ Missed', 'note': '...'}
]
state['today']['m7_verdict'] = '🏆 WIN'  # or '❌ LOSS'
state['today']['m7_summary'] = 'One-line quotable summary.'

# Update scoreboard per WIG
for wig_key in ['wig1', 'wig2', 'wig3', 'wig4']:
    sb = state['scoreboard'][wig_key]
    # Increment weekly_done if lead measure was completed today for this WIG
    # Update lead_streak: +1 if done, reset to 0 if missed
    # Update lag_current if user provided new value
    # Update lag_status: 'winning' | 'at_risk' | 'losing' based on lag trend

# Replace carry_forward with newly identified unresolved items
state['carry_forward'] = ['Unresolved item 1', ...]

state['updated'] = date.today().isoformat()

with open('/workspace/group/4dx/scoreboard.json', 'w') as f:
    json.dump(state, f, indent=2)

print('scoreboard.json updated with M7 data')
```

If `north-star.json` was loaded and the user provided updated lag measure values during Step 1D, also write back to `north-star.json`. Build and run an inline Python script:

```python
import json

VERDICT_THRESHOLDS = {'winning': 0.7, 'on_track': 0.4, 'at_risk': 0.2}

def compute_verdict(score):
    if score >= 0.7: return 'winning'
    if score >= 0.4: return 'on_track'
    if score >= 0.2: return 'at_risk'
    return 'losing'

def suggest_next_action(kr, verdict):
    # Return a concrete one-line next action based on verdict and KR description
    if verdict in ('at_risk', 'losing'):
        return f"Urgent: close gap on {kr['description']} — escalate blockers now."
    if verdict == 'on_track':
        return f"Maintain pace on {kr['description']} — check lead measure streak."
    return f"On track for {kr['description']} — protect WIG time."

with open('/workspace/group/north-star.json') as f:
    ns = json.load(f)

# Determine current quarter from today's date
from datetime import date
month = date.today().month
current_quarter = f"Q{(month - 1) // 3 + 1}"

# For each KR in current quarter, find linked WIGs updated today and refresh score
for obj in ns['objectives']:
    for kr in obj['key_results']:
        if kr['quarter'] != current_quarter:
            continue
        # Substitute real updated current value if the user reported a new lag measure for any linked WIG
        # new_current = <actual value from session or leave unchanged>
        # kr['progress']['current'] = new_current

        target = kr['progress']['target']
        current = kr['progress']['current']
        score = round(current / target, 3) if target else 0.0
        kr['score'] = score
        kr['verdict'] = compute_verdict(score)
        kr['next_action'] = suggest_next_action(kr, kr['verdict'])

ns_tmp = '/workspace/group/north-star.json.tmp'
with open(ns_tmp, 'w') as f:
    json.dump(ns, f, indent=2)
import os; os.rename(ns_tmp, '/workspace/group/north-star.json')
print('north-star.json updated with KR scores and verdicts')
```

> **Note:** Build the actual Python script with real values — do not use the placeholders above verbatim. Only update `kr['progress']['current']` lines for WIGs where the user reported a new lag measure value today.

---

## Step 1 — Collect EOD Data

**Do not ask the user to fill a form. Gather first, confirm second.**

### 1A — Get today's date

```bash
python3 -c "
from datetime import date
d = date.today()
print(f'DATE_ISO={d.isoformat()}')
print(f'DATE_LABEL={d.strftime(\"%A, %d %B %Y\")}')
print(f'DAYS_TO_MARCH16={(date(2026,3,16)-d).days}')
"
```

### 1B — Pull from available tools (run in parallel where possible)

| Tool | What to extract |
|---|---|
| Gmail (`mcp__gmail__*`) | Key threads actioned, escalations sent/resolved |
| Lark cache | Decisions made, async threads closed |
| Calendar cache | Meetings attended, events completed today |

```bash
cat /workspace/group/calendar/today.md 2>/dev/null | head -50 || echo "NO_CALENDAR_CACHE"
cat /workspace/group/lark/latest.md 2>/dev/null | head -50 || echo "NO_LARK_CACHE"
```

### 1C — Retrieve morning M1 commitments

Prefer `scoreboard.json` (already loaded in Storage Protocol) — use `today.m1_commitments` and `today.wig_focus` directly.

If `scoreboard.json` has no `today.m1_commitments` or the date doesn't match, fall back to the markdown file:

```bash
cat /workspace/group/daily/${DATE_ISO}.md 2>/dev/null || echo "NO_M1_FILE"
```

If neither source has M1 data: ask the user to paste or confirm today's lead measure commitments.

### 1D — Ask only for what tools can't provide

After pulling tool data, ask targeted gap-fill questions. Use this checklist — ask only what's missing:

- [ ] "Any critical incidents or fires handled today?"
- [ ] "Which of this morning's lead measures did you complete? (full / partial / none)"
- [ ] "Any WIG actions taken that weren't on the morning plan?"
- [ ] "Scoreboard update: any lag measure numbers changed today?"

Keep to ≤ 4 questions. Never ask for information already visible in tools or context.

---

## Step 2 — Classify Output into Two Buckets

Sort everything collected into:

| Bucket | Label | Description |
|---|---|---|
| 🌪️ Whirlwind Ledger | Maintained | Ops, incidents, meetings, comms — the price of admission |
| 🚀 WIG Output | Advanced | Lead measure actions that moved a WIG forward |

**Classification rule:** If an activity kept the system running → Whirlwind.
If it moved a lag measure or fulfilled a lead measure commitment → WIG Output.
If ambiguous, ask: *"Would the ERP adoption score be different because of this?"*

---

## Step 3 — Generate the Daily Output Summary

If WIG 1 deadline ≤ 7 days (`DAYS_TO_MARCH16 ≤ 7`), add this banner at the top:

```
⚠️ ERP Go-Live in [N] days — every WIG 1 miss compounds.
```

Output in this exact structure:

---

### 📋 Daily Output Summary — [Day, Date]

**Day Verdict: 🏆 WIN / ❌ LOSS**

> Win = Whirlwind stable (no unresolved P1 issues) + ≥ 1 WIG lead measure completed.

---

#### 🌪️ Whirlwind Ledger (Maintained)

| # | Activity | Category | Status |
|---|---|---|---|
| 1 | [description] | Incident / Hiring / Comms / Ops | ✅ Resolved / ⚠️ Ongoing |
| 2 | [description] | | |

**Whirlwind Status: 🟢 Stable / 🟡 Managed / 🔴 Overloaded**

> 🟢 No P1s unresolved · 🟡 Issues managed, no escalation needed · 🔴 Unresolved P1 or team capacity exceeded

---

#### 🚀 WIG Output (Advanced)

| WIG | Lead Measure Action | Committed? | Scoreboard Impact | KR Impact |
|---|---|---|---|---|
| WIG [X] — [Name] `[Area]` | [specific action taken] | ✅ Yes / ➕ Bonus / ❌ Missed | [delta or "no change"] | [KR id — verdict emoji] |
| WIG [Y] — [Name] `[Area]` | [specific action taken] | ✅ Yes / ➕ Bonus / ❌ Missed | [delta or "no change"] | [KR id — verdict emoji] |

> ✅ Committed = was on morning M1 plan · ➕ Bonus = unplanned WIG action · ❌ Missed = committed but not done
> KR Impact: look up `wig_ids` in `north-star.json` for each WIG. Show the current-quarter KR id and its verdict emoji (🏆/🟢/🟡/🔴). If `NO_NORTHSTAR`, omit the column entirely.

---

#### 🪞 M1 Commitment Review

| Morning Commitment | Owner | Status | Note |
|---|---|---|---|
| [lead measure from M1] | Cayadi | ✅ Done / ❌ Missed / 🔄 Partial | [brief reason if missed] |

**Commitment Hit Rate: [X/Y] completed**

> **Status thresholds:** ✅ Done = ≥ 100% of target met · 🔄 Partial = 50–99% of target met · ❌ Missed = < 50% or not attempted.
> Example: UAT target ≥ 80%, actual 75% → 🔄 Partial. UAT target ≥ 80%, actual 40% → ❌ Missed.

---

#### 📊 Scoreboard Delta

| WIG | Lag Measure | Yesterday | Today | Trend |
|---|---|---|---|---|
| WIG 1 — ERP Delivery `[Whirlwind]` | Go-live readiness | [%] | [%] | ↑ / → / ↓ |
| WIG 2 — Mid-Farmer CSAT `[Farmer]` | CSAT score | [x.x] | [x.x] | ↑ / → / ↓ |
| WIG 3 — Smallholder Growth `[Farmer]` | Active users | [n] | [n] | ↑ / → / ↓ |
| WIG 4 — Eng Culture `[Whirlwind]` | Lead measure streak | [n days] | [n days] | ↑ / → / ↓ |

> If no new data is available for a lag measure, mark as `—` and note "no update today."
> If ≥ 3 WIGs show `—` in the Today column, add: `⚠️ Scoreboard blind — pull data from Metabase or flag to team before EOD.`

---

#### 🔁 Carry-Forward

| Item | Type | Action Tomorrow |
|---|---|---|
| [unresolved blocker or missed commitment] | Whirlwind / WIG | [specific action] |

> Keep this list short. If > 3 items carry forward, flag as a capacity risk.

---

#### 💬 One-Line Day Summary

> "[Whirlwind status]. [WIG progress]. [Verdict rationale in one sentence.]"
> *Example: "Managed 1 incident without escalation. Migrated Sprint Planning to ERP — adoption moved to 48%. Win: system held and the needle moved."*

---

*Summary generated: [timestamp] | Module: M7 Daily Output Summary*

---

## Verdict Logic

```
IF Whirlwind_Status IN [🟢 Stable, 🟡 Managed]
   AND WIG_Lead_Measures_Completed >= 1
THEN verdict = "🏆 WIN"
ELSE verdict = "❌ LOSS"
```

**Win does not require:** hitting all commitments, zero Whirlwind fires,
or scoreboard movement. One WIG action + system stability = Win.

**Loss does not mean failure.** It means today was purely reactive.
The carry-forward list is the recovery plan.

**Loss framing rule:** Never editorialize. State the verdict, name the cause
(Whirlwind overload / zero WIG time / missed commitment), and point forward.
One sentence max.

---

## Output Rules

- Every WIG Output row must name the specific action — not "worked on ERP" but "migrated Sprint Planning workflow to ERP module."
- Scoreboard delta requires a number or explicit `—`. Never leave blank.
- Carry-forward must have a named action tomorrow, not just a description of the problem.
- One-line summary is mandatory. It should be quotable.
- **Partial completion rule:** Use 🔄 Partial when an activity was attempted but did not hit its defined target. Use ✅ Done only when the target was fully met. A 🔄 Partial row always requires a carry-forward entry.
- **Scoreboard `—` rule:** Mark `—` when no new data was collected today. Never infer or estimate a number. Add "no update today" in the Trend column.

---

## Step 4 — Save the summary

```bash
mkdir -p /workspace/group/daily
mkdir -p /workspace/group/4dx
```

Append or write to `/workspace/group/daily/${DATE_ISO}.md` — add the M7 summary below the M1 plan if it exists, or create a new file.

Then update `scoreboard.json` as described in the Storage Protocol above. Build and run the real Python script with actual values from the session (verdict, completed list, updated scoreboard, new carry_forward).

Confirm: `EOD summary saved: daily/${DATE_ISO}.md | scoreboard.json updated`
