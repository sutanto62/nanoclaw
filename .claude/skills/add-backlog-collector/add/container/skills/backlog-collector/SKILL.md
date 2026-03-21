---
name: backlog-collector
description: Record and validate product backlog ideas with Chief of Product perspective. Searches the web, refines to business English, links to north-star.json. Triggered by "backlog this", "backlog", "show backlog", "BL-". Output feeds prd-groomer skill.
---

## Intent Detection

Detect intent before doing anything else:

**INTENT A — Record idea**
Triggers: message starts with "backlog this", "backlog:", "add backlog", "log this",
          or any message containing "backlog" + a feature/problem description
→ Execute Record Flow.

**INTENT B — List / View**
Triggers: "show backlog", "backlog list", "what's in backlog", "list backlog",
          "backlog for [product]"
→ Execute List Flow.

**INTENT C — Update item**
Triggers: "update BL-", "done BL-", "drop BL-", "prioritize BL-", "link BL-"
→ Execute Update Flow.

---

## Trigger Grammar

The primary trigger follows this pattern:

```
backlog this [IDEA] for [PRODUCT] then [EXPECTED OUTCOME]
```

Examples:
- "backlog this farmer can upload CSV in bulk for KebunPRO then reduce manual data entry by 80%"
- "backlog this agents need real-time stock visibility for AgenPRO then cut order rejection rate"
- "backlog this we keep losing farmers after first transaction for PetaniPRO then improve 30-day retention"

All three parts are optional — infer what you can, ask for what's missing.

---

## Storage Protocol

### Backlog file: `/workspace/group/backlog/backlog.json`

Schema:
```json
{
  "next_id": 1,
  "items": [
    {
      "id": "BL-001",
      "title": "Short imperative title in business English",
      "problem": "What user pain or business gap this addresses",
      "outcome": "Expected measurable outcome",
      "product": "AgenPRO",
      "type": "feature|bug|idea|tech-debt|research",
      "priority": "critical|high|medium|low",
      "status": "new|validated|ready|in-progress|done|dropped",
      "objective_id": "obj-1",
      "kr_id": "kr-1-q1",
      "cpo_verdict": "Short CPO assessment — why this matters or doesn't",
      "market_context": "Key finding from web research",
      "tags": [],
      "source": "user",
      "created": "YYYY-MM-DD",
      "updated": "YYYY-MM-DD"
    }
  ]
}
```

On startup, load:
```bash
cat /workspace/group/backlog/backlog.json 2>/dev/null || echo "NO_BACKLOG"
cat /workspace/group/north-star.json 2>/dev/null || echo "NO_NORTHSTAR"
```

If `NO_BACKLOG`: initialize empty store `{ "next_id": 1, "items": [] }` before proceeding.

### Known products

AgenPRO, KebunPRO, PetaniPRO, TimPRO, SupirPRO, MitraPRO — match case-insensitively. Accept partial matches
("Agen" → AgenPRO, "Kebun" → KebunPRO). Ask if none detected.

---

## Record Flow

This is the core flow. You are acting as **Chief of Product** — validate the idea, research it, refine it, and link it to the north star.

### R-1 — Parse the raw idea

Extract from the user's message:
- **raw_idea**: the unprocessed idea as stated
- **product**: match from known products list; ask if none detected
- **expected_outcome**: the "then ..." part; may be absent

### R-2 — Web research

Search the web to gather context on the idea. Look for:
- How competitors or similar products solve this problem
- Industry benchmarks or best practices
- Market size or demand signals for this capability

Use WebSearch to find 2-3 relevant sources. Summarize the key finding in one sentence — this becomes `market_context`.

### R-3 — Validate against north-star.json

Load `north-star.json` and check:
1. Does this idea directly support an objective? Which KR does it map to?
2. How strong is the link? (direct contributor vs. tangential)
3. What quarter's KR would this most impact?

Set `objective_id` and `kr_id` if there's a clear match. If the idea doesn't map to any objective, flag it — the CPO verdict should note this.

### R-4 — CPO assessment

Think like a Chief of Product. Evaluate:
- **Strategic fit**: Does this move a north-star needle?
- **User pain severity**: Is this a workaround, a blocker, or a nice-to-have?
- **Effort-to-impact ratio**: Based on the idea's scope, is the expected outcome proportional?

Write a 1-2 sentence `cpo_verdict`. Be direct. Examples:
- "Strong fit — directly unblocks kr-3-q1 farmer registration. High priority."
- "Valid pain point but tangential to current objectives. Park for Q3 review."
- "Overlaps with BL-004. Consider merging before prioritizing."

### R-5 — Refine to business English

Rewrite the raw idea into structured fields using clear, professional business English:
- **title**: imperative phrase, max 10 words (e.g., "Enable bulk CSV upload for farmer onboarding")
- **problem**: one sentence describing the user pain or business gap
- **outcome**: one sentence with a measurable or observable result
- **type**: infer from context (feature/bug/idea/tech-debt/research)
- **priority**: based on CPO assessment (critical/high/medium/low)

### R-6 — Present for confirmation

Show the refined backlog item:

```
*📋 New Backlog Item*

*Title*: [title]
*Product*: [product]
*Type*: [type] · *Priority*: [priority]

*Problem*: [problem]
*Outcome*: [outcome]

*🎯 North Star*: [obj name → KR description] or _Not linked — [reason]_
*🌐 Market*: [market_context]
*🧠 CPO*: [cpo_verdict]

ID: BL-[N] (assigned on save)

Reply: ok · edit [field]: [value] · cancel
```

Wait for reply. Accept `ok`, a one-liner edit, or `cancel`.

### R-7 — Write item

Generate the next ID from `next_id`, increment, append, write back:

```python
import json
from datetime import date

path = '/workspace/group/backlog/backlog.json'
with open(path) as f:
    store = json.load(f)

item = {
    "id": f"BL-{store['next_id']:03d}",
    "title": "TITLE",
    "problem": "PROBLEM",
    "outcome": "OUTCOME",
    "product": "PRODUCT",
    "type": "TYPE",
    "priority": "PRIORITY",
    "status": "new",
    "objective_id": "OBJ_ID_OR_NULL",
    "kr_id": "KR_ID_OR_NULL",
    "cpo_verdict": "CPO_VERDICT",
    "market_context": "MARKET_CONTEXT",
    "tags": [],
    "source": "user",
    "created": date.today().isoformat(),
    "updated": date.today().isoformat()
}

store['items'].append(item)
store['next_id'] += 1

with open(path, 'w') as f:
    json.dump(store, f, indent=2)

print(f"Saved: {item['id']}")
```

Reply: `✅ BL-[N] saved — [product] · [priority] · [obj-name or "unlinked"]`

---

## List Flow

### L-1 — Build filters from message

Extract optional filters:
- **product**: named product
- **status**: default excludes done/dropped
- **priority**: if specified
- **objective**: if user says "for obj-1" or KR name

### L-2 — Load, filter, display

```python
import json

with open('/workspace/group/backlog/backlog.json') as f:
    store = json.load(f)

items = [i for i in store['items'] if i['status'] not in ('done', 'dropped')]
# apply additional filters as needed

priority_order = {'critical': 0, 'high': 1, 'medium': 2, 'low': 3}
items.sort(key=lambda i: (priority_order.get(i['priority'], 9), i['created']))
```

Format (Telegram Markdown):

```
*Backlog — [filter label or "All Open"]*

*AgenPRO* ([N] items)
• BL-001 🔴 critical — [title]
  ↳ [problem] · [obj-name or "unlinked"]
• BL-004 🟠 high — [title]
  ↳ [problem] · [obj-name or "unlinked"]

*KebunPRO* ([N] items)
• BL-002 🟡 medium — [title]
  ↳ [problem] · [obj-name or "unlinked"]

🔴 critical · 🟠 high · 🟡 medium · ⚪ low
Total: [N] open items · [N] validated · [N] ready for PRD
```

---

## Update Flow

### U-1 — Find the item

Parse `BL-NNN` from message. Load `backlog.json`, locate by id. If not found, list closest matches.

### U-2 — Parse the mutation

| Command | Action |
|---------|--------|
| `done BL-NNN` | Set `status = "done"` |
| `drop BL-NNN` | Set `status = "dropped"` |
| `prioritize BL-NNN critical` | Set `priority` field |
| `ready BL-NNN` | Set `status = "ready"` — marks as ready for PRD grooming |
| `validate BL-NNN` | Set `status = "validated"` |
| `update BL-NNN [field]: [value]` | Update named field |
| `link BL-NNN obj-2 kr-2-q1` | Set `objective_id` and `kr_id` |

### U-3 — Write back

Update the item, set `updated` to today, write back.
Reply: `✅ BL-[N] updated — [field] → [new value]`

---

## North Star Linkage

Objective-to-product heuristics:
- `obj-1` (FFB Increment) → KebunPRO, PetaniPRO
- `obj-2` (Fertilizer Sales) → AgenPRO, KebunPRO
- `obj-3` (Farmer Customer Base) → PetaniPRO, AgenPRO, TimPRO

When linking:
1. Match by product area first
2. Then by keyword overlap between the idea and KR descriptions
3. Pick the current quarter's KR unless the idea is clearly future-scoped
4. If no clear match, set both to `null` and note in `cpo_verdict`

---

## Output Rules

- IDs are immutable once assigned — never renumber.
- Always confirm before writing on Record Flow; no confirmation needed for single-field updates.
- Use Telegram/Lark Markdown (*bold*, _italic_, no tables).
- Priority emoji: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low
- Never delete items — use `dropped` status.
- All timestamps ISO format (YYYY-MM-DD).
- Write in clear business English — no jargon-stuffing, no filler.
- CPO verdict must be opinionated. Take a stance. "This is important because..." or "Park this — here's why..."
