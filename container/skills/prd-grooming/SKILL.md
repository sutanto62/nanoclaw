---
name: prd-grooming
description: Interactive PRD drafting for sprint grooming. Scans last 14 days of messages, emails, and action items; extracts and ranks topic candidates against north-star.json and wig.json; walks through topic selection, web research, and section-by-section PRD drafting (problem, user stories, acceptance criteria, OKR impact). Saves PRD to prd/YYYY-WNN-{slug}.md. Trigger on: "prd grooming", "sprint grooming", "write prd", "feature ideas", "prd planning", "grooming session".
---

## Intent Detection

Detect intent before doing anything else:

**INTENT A — Start Session (no topic specified)**
Triggers: "prd grooming", "sprint grooming", "feature ideas", "grooming session", "prd planning"
→ Execute Steps 1–4 (scan sources, extract themes, score, present candidates), then wait for topic selection before continuing to Step 5.

**INTENT B — Direct PRD (topic already named)**
Triggers: message matches trigger AND includes a specific topic (e.g. "write prd for CST rating", "prd grooming for farmer onboarding")
→ Skip Steps 1–4. Extract topic from message. Go directly to Step 5 (web research).

---

## Storage Protocol

### On startup

Read strategic context from the group workspace:

```bash
cat /workspace/group/north-star.json 2>/dev/null || echo "NO_NORTHSTAR"
cat /workspace/group/4dx/wig.json 2>/dev/null || echo "NO_WIG"
```

Use these as the authoritative source for OKR alignment scoring in Step 3.

If `north-star.json` returns `NO_NORTHSTAR`: skip OKR alignment in Step 3 and Step 6 — proceed with theme extraction only.
If `wig.json` returns `NO_WIG`: skip WIG scoring in Step 3 — use north-star only, or skip alignment entirely.

---

## Step 1 — Scan Message Sources

Compute date range:

```bash
python3 -c "
from datetime import date, timedelta
cutoff = (date.today() - timedelta(days=14)).strftime('%Y-%m-%d')
gmail_cutoff = (date.today() - timedelta(days=14)).strftime('%Y/%m/%d')
print(f'CUTOFF={cutoff}')
print(f'GMAIL_CUTOFF={gmail_cutoff}')
"
```

### 1A — Lark digest

```bash
cat /workspace/group/lark/latest.md 2>/dev/null || echo "NO_LARK"
```

### 1B — SQLite messages (last 14 days)

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT sender_name, content, timestamp
  FROM messages
  WHERE timestamp >= '${CUTOFF}'
    AND is_from_me = 0
  ORDER BY timestamp DESC
  LIMIT 200;
" 2>/dev/null || echo "NO_DB"
```

### 1C — Action items and projects

```bash
cat /workspace/group/action-items.md 2>/dev/null || echo "NO_ACTIONS"
cat /workspace/group/projects.md 2>/dev/null || echo "NO_PROJECTS"
```

### 1D — Gmail (last 14 days, product-related)

```
mcp__gmail__search_emails(
  query: "after:${GMAIL_CUTOFF} -from:me category:primary",
  maxResults: 30
)
```

For each result, call `mcp__gmail__read_email` to get the body. Skip emails that are clearly non-product (invoices, logistics, HR admin). Collect subject + first 200 chars of body per email.

If Gmail MCP is unavailable: skip 1D and continue with 1A–1C.

---

## Step 2 — Extract Themes with Ollama

Combine all content from Step 1 into a single string (truncate to ~8000 chars if needed — most recent first). Call Ollama:

```
ollama_generate(
  model: "qwen3:30b",
  system: "You are a product analyst for an agtech B2B platform serving palm oil farmers and field officers in Indonesia. Extract distinct product themes or pain points from team messages. Focus on recurring complaints, feature requests, process friction, and user frustrations. Return ONLY valid JSON array — no markdown, no explanation.",
  prompt: "Messages and emails:\n{combined_content}\n\nExtract up to 8 distinct themes. Each theme must appear in at least 2 different messages or have a strong signal. Return:\n[{\"theme\": \"Short name\", \"frequency\": N, \"pain_point\": \"1-sentence description of the pain\", \"example_quote\": \"Verbatim or near-verbatim excerpt\", \"personas\": [\"field officer\"|\"farmer\"|\"ops team\"|\"management\"]}]"
)
```

Parse the JSON. If parsing fails or returns empty: set `themes = []` and skip to Step 4 with a note that no themes were extracted.

---

## Step 3 — Score Against North Star

Read (already loaded in Storage Protocol):
- `north-star.json` → objectives + key_results (current quarter)
- `wig.json` → WIG definitions with `lag_status`

For each theme, call Ollama to compute alignment:

```
ollama_generate(
  model: "qwen3:30b",
  system: "You are a product strategist. Score each theme's alignment to OKRs and WIGs. Return ONLY valid JSON array — no markdown, no explanation.",
  prompt: "Themes:\n{themes_json}\n\nNorth Star Objectives:\n{north_star_json}\n\nWIGs:\n{wig_json}\n\nFor each theme, return:\n[{\"theme\": \"...\", \"wig_id\": N_or_null, \"objective_id\": \"obj-N_or_null\", \"alignment_score\": 0.0_to_1.0, \"rationale\": \"1 sentence why\", \"boost\": true_or_false}]\n\nSet boost=true if the matched WIG has lag_status='at_risk' or 'losing', or if the matched KR has verdict='at_risk' or 'losing'."
)
```

Apply boost: for any theme with `boost: true`, add 0.15 to `alignment_score` (cap at 1.0).

Sort themes by `alignment_score` descending. Take top 8.

If Ollama is unavailable: skip scoring, rank by `frequency` only, set `alignment_score = null` for all.

---

## Step 4 — Present Candidates (Intent A only)

Compute week label:

```bash
python3 -c "from datetime import date; d=date.today(); print(f'{d.isocalendar()[0]}-W{d.isocalendar()[1]:02d}')"
```

Build score bar: `alignment_score * 10` filled blocks (█) + empty blocks (░) to 10 total. If `alignment_score` is null, show `freq: N` instead.

Send to chat (Telegram Markdown — single asterisk bold, no GFM tables):

```
*🔍 PRD Grooming — Topic Candidates*
Week: {WEEK_LABEL} | Scanned: last 14 days

Based on messages, emails, and action items:

*1. {theme}* — WIG-{N} ({wig_name})
   Pain: {pain_point}
   Score: {bar} {score:.1f}

*2. {theme}* — {objective_id} ({objective_name})
   Pain: {pain_point}
   Score: {bar} {score:.1f}

...

Reply with a number to select a topic, or describe your own topic.
If no topic resonates, reply `skip` to draft a PRD from scratch.
```

Wait for user reply. Parse reply:
- Integer 1–N → use that theme as selected topic
- Free text → use as custom topic description
- "skip" → ask "What feature or problem do you want to build a PRD for?" and wait

Set `SELECTED_TOPIC` = theme name or user-provided description.
Set `SELECTED_WIG_ID` and `SELECTED_OBJ_ID` from the matched theme (or null for custom topics).

---

## Step 5 — Web Research

Build search queries from `SELECTED_TOPIC`. Run 2 searches:

```
WebSearch: "{SELECTED_TOPIC} best practices agtech B2B 2025"
WebSearch: "{SELECTED_TOPIC} UX patterns mobile farmers Indonesia"
```

Read the top 2 results from each search (use `agent-browser` for pages that require JS rendering if needed). Extract relevant insights only — discard generic content.

Summarize into 3–5 bullets:
- Each bullet: one concrete insight, practice, or pattern
- Source label in parentheses
- No AI filler language

Set `MARKET_CONTEXT` = bullet list.

If WebSearch is unavailable: set `MARKET_CONTEXT = "(web research unavailable — add market context manually)"` and continue.

---

## Step 6 — Interactive PRD Draft

Walk through 5 sections sequentially. After each section: send output to chat and ask "Looks good? Or adjust before moving on?" Wait for reply before continuing.

Reply options for each section:

| Reply | Action |
|-------|--------|
| `ok` / `yes` / `confirm` | Accept draft, move to next |
| `skip` | Leave section as draft placeholder |
| `add: <text>` | Append to section |
| `update: <text>` | Replace section with new text |
| Any freeform | Replace section with that text |

---

### Section 1 — Problem Statement

Pre-fill from the selected theme's `pain_point` and `example_quote`. Ask:

```
*PRD Draft — Section 1 of 5: Problem Statement*

Draft:
{pain_point}

Example from team: "{example_quote}"

ok / update: <text> / skip
```

---

### Section 2 — Target Users

Infer from the theme's `personas` array. Ask:

```
*Section 2 of 5: Target Users*

Draft:
{personas as bullet list}

ok / update: <text> / skip
```

---

### Section 3 — User Stories

Generate 3–5 user stories using Ollama:

```
ollama_generate(
  model: "qwen3:30b",
  system: "You are a product manager writing user stories for an agtech B2B platform. Write concise, testable user stories. No filler language.",
  prompt: "Problem: {problem_statement}\nPersonas: {target_users}\nTopic: {SELECTED_TOPIC}\n\nWrite 3-5 user stories in format:\nAs a [persona], I want [action], so that [outcome].\n\nReturn as a numbered list only."
)
```

Send with edit options:

```
*Section 3 of 5: User Stories*

1. As a [persona], I want [action], so that [outcome].
2. ...

ok / add: <story> / update N: <story> / remove N / skip
```

---

### Section 4 — Acceptance Criteria

For each user story, generate 2–3 acceptance criteria using Ollama:

```
ollama_generate(
  model: "qwen3:30b",
  system: "Write specific, testable acceptance criteria as checklist items. No filler. Start each with a verb (Given/When/Then pattern or plain action).",
  prompt: "User stories:\n{user_stories}\n\nFor each story, write 2-3 acceptance criteria. Return as:\nStory N:\n- [ ] criterion\n- [ ] criterion"
)
```

Send with edit options:

```
*Section 4 of 5: Acceptance Criteria*

Story 1:
- [ ] {criterion}
- [ ] {criterion}

Story 2:
...

ok / update N: <criteria> / skip
```

---

### Section 5 — OKR Impact

Map to north-star KR and estimate delta. If `SELECTED_WIG_ID` or `SELECTED_OBJ_ID` is set, use the matched KR. Otherwise, use Ollama to infer the best match.

```
ollama_generate(
  model: "qwen3:30b",
  system: "You are a product strategist. Estimate the OKR impact of a feature in 2-3 sentences. Be specific about the metric and realistic about the delta. No filler language.",
  prompt: "Feature: {SELECTED_TOPIC}\nProblem: {problem_statement}\nUser stories: {user_stories}\nNorth Star KR: {kr_description}\nCurrent KR value: {current} / {target} {unit}\n\nEstimate: which metric moves, by how much, and why."
)
```

Send with edit options:

```
*Section 5 of 5: OKR Impact*

Objective: {objective_name}
WIG: WIG-{N} — {wig_name}
KR: {kr_description} ({current}/{target} {unit})

Estimated impact:
{impact_text}

ok / update: <text> / skip
```

---

## Step 7 — Save PRD + Send Summary

### Compute file path

```bash
python3 -c "
from datetime import date
import re
d = date.today()
week = f'{d.isocalendar()[0]}-W{d.isocalendar()[1]:02d}'
slug = re.sub(r'[^a-z0-9]+', '-', '{SELECTED_TOPIC}'.lower()).strip('-')[:40]
print(f'{week}-{slug}')
"
```

Set `FILENAME = {output}.md`. Set `FILEPATH = /workspace/group/prd/${FILENAME}`.

### Write file

```bash
mkdir -p /workspace/group/prd
```

Write `${FILEPATH}`:

```markdown
# PRD: {Feature Title}

Sprint: {WEEK_LABEL}
Status: draft
Author: Brain (assisted)
Date: {DATE_ISO}

## North Star Alignment

- Objective: {objective_name}
- WIG: WIG-{N} — {wig_name}
- KR: {kr_description} | {current} / {target} {unit}
- KR Impact: {okr_impact}

## Problem Statement

{problem_statement}

## Target Users

{target_users as bullet list}

## User Stories

| # | Story | Acceptance Criteria |
|---|-------|---------------------|
| 1 | {story_1} | {criteria_1 joined by "; "} |
| 2 | {story_2} | {criteria_2 joined by "; "} |

## Market Context

{MARKET_CONTEXT}

## OKR Impact Estimate

{okr_impact}
```

If `north-star.json` was `NO_NORTHSTAR`, omit the "North Star Alignment" section.

### Send chat summary (Telegram Markdown)

Count user stories (`N_STORIES`) and total acceptance criteria items (`N_CRITERIA`).

```
*📌 PRD: {Feature Title}*

WIG: WIG-{N} | Obj: {objective_name}

User Stories: {N_STORIES} drafted
Acceptance Criteria: {N_CRITERIA} items

File saved: `prd/{FILENAME}`
```

---

## Output Rules

- All chat output uses Telegram Markdown: `*bold*` (single asterisk), no GFM tables in chat.
- No AI filler language ("It's worth noting…", "In summary…", "As an AI…").
- Every user story: testable, specific, names a real persona from the platform.
- Every acceptance criterion: starts with a verb or Given/When/Then, testable by a QA engineer.
- File output uses standard markdown (GFM tables allowed in the saved `.md` file).
- If Ollama is unavailable at any step: generate that section yourself using the context already loaded — do not abort.
- If the user abandons mid-session: save the partial PRD with `Status: draft (incomplete)` and note which sections are pending.
