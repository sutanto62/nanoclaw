---
name: add-weekly-cadence
version: 0.0.1
description: |
  Structured weekly review: highlights, lowlights, risks, business observations,
  next actions, and requests. Saves a dated summary to /workspace/group/weekly/YYYY-WXX.md.
allowed-tools:
  - Read
  - Write
  - Bash
---

# Weekly Cadence

Guide the user through a structured weekly review across 6 sections. Save the result to `/workspace/group/weekly/YYYY-WXX.md`.

## Trigger

Use this skill whenever the user says:
- "weekly cadence", "weekly review", "do my weekly", "weekly summary"
- "let's do the weekly", "weekly report", "weekly wrap-up"

---

## Step 1: Determine week label

```bash
python3 -c "from datetime import date; d=date.today(); print(f'{d.isocalendar()[0]}-W{d.isocalendar()[1]:02d}')"
```

Also compute the Monday and Sunday of the current week:

```bash
python3 -c "
from datetime import date, timedelta
today = date.today()
mon = today - timedelta(days=today.weekday())
sun = mon + timedelta(days=6)
print(f'{mon.strftime(\"%d %b\")} – {sun.strftime(\"%d %b %Y\")}')
"
```

Set `WEEK_LABEL` (e.g. `2026-W11`) and `WEEK_RANGE` (e.g. `09 Mar – 15 Mar 2026`).

Check if a file already exists for this week:

```bash
test -f /workspace/group/weekly/${WEEK_LABEL}.md && echo "exists" || echo "new"
```

If it exists, read it and offer to continue editing or start fresh.

---

## Step 2: Read context from workspace

### 2A — Read 4DX structured data

```bash
cat /workspace/group/4dx/scoreboard.json 2>/dev/null || echo "NO_STATE"
cat /workspace/group/4dx/wig.json 2>/dev/null || echo "NO_CONFIG"
cat /workspace/group/north-star.json 2>/dev/null || echo "NO_NORTHSTAR"
```

From `scoreboard.json` extract: `scoreboard` (weekly_done, weekly_target, lead_streak, lag_current, lag_status per WIG), `carry_forward`.
From `wig.json` extract: WIG names, lag metrics, lead measure names and weekly_targets.
From `north-star.json` extract: current-quarter KRs (filter by `quarter` matching current quarter), their `progress`, `score`, `verdict`, and `next_action`. Use WIG → KR linkage (`wig_ids`) to connect WIG weekly performance to KR trajectory.

If `north-star.json` returns `NO_NORTHSTAR`: proceed without north star context. Section 4 falls back to manual observations.

Use this structured data to pre-fill the Highlights, Lowlights, and Business Observations sections (WIG progress, streaks, lag measure movements, KR trajectory).

### 2B — Read workspace notes

Check for any notes or task files in the group workspace:

```bash
ls /workspace/group/*.md 2>/dev/null || echo "none"
```

Read any found files (skip files > 150 lines). Use their content to pre-fill drafts below.

---

## Step 3: Section walkthrough (sequential, one reply per section)

For each section, send a message with the draft pre-filled from workspace context (bullets numbered for reference). Wait for the user's reply before moving to the next section.

### Reply options

| Reply | Action |
|-------|--------|
| `ok` / `confirm` / `yes` | Use draft as-is |
| `skip` | Leave section blank |
| `add: <text>` | Append a new bullet |
| `update <N>: <text>` | Replace bullet N with new text |
| `remove <N>` | Delete bullet N |
| Any freeform text | Replace entire section with that text |

Multiple update commands can be sent in one reply (one per line). After each update command, show the revised list and ask to confirm or continue editing.

Keep each prompt short. Bullets numbered, no paragraphs.

---

### Section 1 — Highlights

What went well this week? Completed work, shipped output, positive signals.

Reply format:
```
*Week {{WEEK_LABEL}} — Section 1 of 6: Highlights*

Draft:
1. [pre-filled from notes, or "Nothing found — add your wins"]

ok / skip / add: … / update N: … / remove N
```

---

### Section 2 — Lowlights

Blockers, stalled work, cancelled plans, anything that dragged.

Reply format:
```
*Section 2 of 6: Lowlights*

Draft:
1. [pre-filled, or "None found — any blockers or stalls?"]

ok / skip / add: … / update N: … / remove N
```

---

### Section 3 — Major Risks

Patterns or cross-cutting issues that could affect the team or business.

Reply format:
```
*Section 3 of 6: Major Risks*

Draft:
1. [pre-filled from recurring themes in notes, or "None detected — any risks to flag?"]

ok / skip / add: … / update N: … / remove N
```

---

### Section 4 — Business Observations

Insights tied to the north star KRs from `north-star.json`. Pre-fill from current-quarter KR data:
- For each objective, show: KR description, current vs. target, score, verdict, and whether this week's WIG activity moved the needle.
- Flag any KR with `verdict: "at_risk"` or `"losing"` as a risk bullet.
- If `NO_NORTHSTAR`: fall back to the three known metrics (FFB volume, fertilizer sales, active farmers) and ask the user to provide numbers.

Reply format:
```
*Section 4 of 6: Business Observations*

Draft:
1. [Objective name] — [KR description]: [current] / [target] [unit] ([score × 100]%) [verdict emoji]
   WIGs this week: [weekly_done]/[weekly_target] lead measures hit
2. [next objective...]
3. [or risk flag: ⚠️ KR X at_risk — gap is N units, N weeks to quarter end]

ok / skip / add: … / update N: … / remove N
```

---

### Section 5 — Next Actions

What needs to happen next week? Open tasks, follow-ups, continuations.

Reply format:
```
*Section 5 of 6: Next Actions*

Draft:
1. [pre-filled from open items in notes]

ok / skip / add: … / update N: … / remove N
```

---

### Section 6 — Requests

Tasks delegated to or waiting on someone else.

Reply format:
```
*Section 6 of 6: Requests*

Draft:
1. [pre-filled, or "None — anything waiting on others?"]

ok / skip / add: … / update N: … / remove N
```

---

## Step 4: Write the summary

Create the output directories if needed:

```bash
mkdir -p /workspace/group/weekly
mkdir -p /workspace/group/4dx/sessions
```

Write `/workspace/group/weekly/${WEEK_LABEL}.md`:

```markdown
# Weekly Cadence — {{WEEK_LABEL}}

> {{WEEK_RANGE}}

## Highlights
- …

## Lowlights
- …

## Major Risks
- …

## Business Observations
- …

## Next Actions
- …

## Requests
- …
```

Rules:
- H2 per section, bullets only — no prose paragraphs.
- No AI filler language ("It's worth noting…", "In summary…").
- Skipped sections: single bullet `- (none this week)`.

After writing the markdown, write the weekly session JSON and reset the scoreboard weekly counters:

```python
import json
from datetime import date

# Write sessions/YYYY-WNN.json
with open('/workspace/group/4dx/scoreboard.json') as f:
    state = json.load(f)
with open('/workspace/group/4dx/wig.json') as f:
    config = json.load(f)

# Build session record from current state
session = {
    'week': WEEK_LABEL,
    'win_days': WIN_DAY_COUNT,       # count of '🏆 WIN' verdicts this week
    'total_days': TOTAL_ACTIVE_DAYS, # days where M1+M7 were both completed
    'lead_completions': {
        'wig1': state['scoreboard']['wig1']['weekly_done'],
        'wig2': state['scoreboard']['wig2']['weekly_done'],
        'wig3': state['scoreboard']['wig3']['weekly_done'],
        'wig4': state['scoreboard']['wig4']['weekly_done'],
    },
    'lag_snapshots': {
        'wig1': state['scoreboard']['wig1']['lag_current'],
        'wig2': state['scoreboard']['wig2']['lag_current'],
        'wig3': state['scoreboard']['wig3']['lag_current'],
        'wig4': state['scoreboard']['wig4']['lag_current'],
    },
    'carry_forward_resolved': [],    # items from prior carry_forward now cleared
    'weekly_summary': 'One paragraph summary of the week.'
}

session_path = f'/workspace/group/4dx/sessions/{WEEK_LABEL}.json'
with open(session_path, 'w') as f:
    json.dump(session, f, indent=2)

# Reset weekly_done for new week
for wig_key in ['wig1', 'wig2', 'wig3', 'wig4']:
    state['scoreboard'][wig_key]['weekly_done'] = 0

state['updated'] = date.today().isoformat()
with open('/workspace/group/4dx/scoreboard.json', 'w') as f:
    json.dump(state, f, indent=2)

print(f'Session saved: {session_path}')
print('Scoreboard weekly_done reset for new week')
```

> **Note:** Build the actual Python script with real win_day_count, total_active_days, and weekly_summary values from the session.

If `north-star.json` was loaded, also update KR `current` values from the week's lag snapshots, recompute scores and verdicts, and generate `next_action`:

```python
import json, os
from datetime import date

VERDICT_MAP = [(0.7, 'winning'), (0.4, 'on_track'), (0.2, 'at_risk')]

def compute_verdict(score):
    for threshold, label in VERDICT_MAP:
        if score >= threshold: return label
    return 'losing'

def suggest_next_action(kr, verdict):
    weeks_left = max(1, (13 - date.today().isocalendar()[1] % 13))
    gap = kr['progress']['target'] - kr['progress']['current']
    if verdict == 'losing':
        return f"Critical: {gap} {kr['progress']['unit']} gap with ~{weeks_left} weeks left — escalate and re-plan."
    if verdict == 'at_risk':
        return f"At risk: need {gap} {kr['progress']['unit']} more — increase WIG frequency."
    if verdict == 'on_track':
        return f"On track — maintain lead measure pace to close {gap} {kr['progress']['unit']} gap."
    return f"Winning — protect WIG time, avoid Whirlwind drift."

with open('/workspace/group/north-star.json') as f:
    ns = json.load(f)

month = date.today().month
current_quarter = f"Q{(month - 1) // 3 + 1}"

for obj in ns['objectives']:
    for kr in obj['key_results']:
        if kr['quarter'] != current_quarter:
            continue
        # Update current from lag_snapshots for linked WIGs where applicable
        # kr['progress']['current'] = <new value confirmed during Section 4>
        target = kr['progress']['target']
        current = kr['progress']['current']
        score = round(current / target, 3) if target else 0.0
        kr['score'] = score
        kr['verdict'] = compute_verdict(score)
        kr['next_action'] = suggest_next_action(kr, kr['verdict'])

tmp = '/workspace/group/north-star.json.tmp'
with open(tmp, 'w') as f:
    json.dump(ns, f, indent=2)
os.rename(tmp, '/workspace/group/north-star.json')
print('north-star.json updated with weekly KR review')
```

> **Note:** Build the actual script with real `current` values confirmed in Section 4. Only update KRs where the user provided a new lag measure value.

After writing, confirm to the user:

```
Weekly summary saved: weekly/{{WEEK_LABEL}}.md
4DX session saved: 4dx/sessions/{{WEEK_LABEL}}.json
Scoreboard reset for new week.
North Star KRs updated: north-star.json
```

---

## Edge Cases

- **Interrupted mid-flow**: If the user sends an unrelated message before all 6 sections are done, save partial progress to the file and note which sections are still pending.
- **Re-run same week**: Read existing file, show current content per section, allow the user to update any section.
- **No workspace notes**: Skip pre-fill, ask open-ended questions instead.
