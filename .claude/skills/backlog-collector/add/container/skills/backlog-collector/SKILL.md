---
name: backlog-collector
description: Collect, view, prioritize, and groom product backlog items linked to north-star.json objectives and products (AgenPRO, KebunPRO, PetaniPRO, TimPRO). Triggers on "backlog", "add backlog", "show backlog", "groom backlog", "BL-", or product name + feature/bug/idea.
---

## Intent Detection

Detect intent before doing anything else:

**INTENT A — Add item**
Triggers: "add backlog", "backlog:", "log this as backlog", "capture backlog", "new backlog item",
          free-form message ending with "(backlog)" or starting with a product name + feature/bug/idea
→ Execute Add Flow.

**INTENT B — List / View**
Triggers: "show backlog", "backlog list", "what's in backlog", "list backlog",
          "backlog for [product]", "backlog [product]"
→ Execute List Flow.

**INTENT C — Update item**
Triggers: "update backlog", "update BL-", "groom BL-", "prioritize BL-", "close BL-", "done BL-"
→ Execute Update Flow.

**INTENT D — Groom backlog**
Triggers: "groom backlog", "backlog grooming", "prioritize backlog", "triage backlog"
→ Execute Groom Flow.

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
      "title": "Short title",
      "description": "Details, user story, or acceptance criteria",
      "product": "AgenPRO",
      "type": "feature|bug|idea|tech-debt|research",
      "priority": "critical|high|medium|low",
      "status": "new|groomed|ready|in-progress|done|dropped",
      "objective_id": "obj-1",
      "kr_id": "kr-1-q1",
      "tags": [],
      "source": "user|email|lark|meeting",
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

AgenPRO, KebunPRO, PetaniPRO, TimPRO — match case-insensitively. Accept partial matches
("Agen" → AgenPRO, "Kebun" → KebunPRO). Prompt to confirm if ambiguous.

---

## Add Flow

### A-1 — Parse the message

Extract:
- **title**: short imperative phrase ("Add bulk upload for farmer CSV")
- **product**: match from known products list; ask if none detected
- **type**: infer from keywords (bug/error/crash → `bug`, idea/explore/research → `idea`,
  refactor/clean/debt → `tech-debt`, default → `feature`)
- **priority**: look for urgency words (critical/urgent/blocker → `critical`, important/soon → `high`,
  nice-to-have/someday → `low`, default → `medium`)
- **objective linkage**: scan `north-star.json` — match by product area or keyword in title.
  If a KR clearly maps, set `objective_id` and `kr_id`. If unclear, set both to `null`.
- **description**: any additional detail the user provided; leave blank if not given

### A-2 — Confirm before saving

Show a confirmation card:

```
*New Backlog Item*

ID: BL-[N] (to be assigned)
Product: [product]
Title: [title]
Type: [type]
Priority: [priority]
Objective: [obj name → KR description] or _None_

ok / edit [field]: [value] / cancel
```

Wait for reply. Accept `ok` or a one-liner edit command before writing.

### A-3 — Write item

Generate the next ID from `next_id`, increment it, append item to `items`, write back:

```python
import json
from datetime import date

path = '/workspace/group/backlog/backlog.json'
with open(path) as f:
    store = json.load(f)

item = {
    "id": f"BL-{store['next_id']:03d}",
    "title": "TITLE",
    "description": "DESCRIPTION",
    "product": "PRODUCT",
    "type": "TYPE",
    "priority": "PRIORITY",
    "status": "new",
    "objective_id": "OBJ_ID_OR_NULL",
    "kr_id": "KR_ID_OR_NULL",
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

Reply: `✅ BL-[N] added — [product] · [priority] priority`

---

## List Flow

### L-1 — Build filters from message

Extract optional filters:
- **product**: named product in message
- **status**: "new", "ready", "groomed", "in-progress" (default: exclude done/dropped)
- **priority**: "critical", "high", etc.
- **objective**: if user says "for obj-1" or KR name

### L-2 — Load and filter

```python
import json

with open('/workspace/group/backlog/backlog.json') as f:
    store = json.load(f)

items = store['items']
# apply filters — substitute real filter values
items = [i for i in items if i['status'] not in ('done', 'dropped')]
# product filter: items = [i for i in items if i['product'] == 'PRODUCT']
# priority filter: items = [i for i in items if i['priority'] == 'PRIORITY']

# sort: critical first, then high, medium, low; then by created date
priority_order = {'critical': 0, 'high': 1, 'medium': 2, 'low': 3}
items.sort(key=lambda i: (priority_order.get(i['priority'], 9), i['created']))

for item in items:
    print(f"{item['id']} | {item['product']:<12} | {item['priority']:<8} | {item['status']:<12} | {item['title']}")
```

### L-3 — Format and reply

Group by product. Telegram format, no tables:

```
*Backlog — [filter label or "All Open"]*

*AgenPRO* ([N] items)
• BL-001 🔴 critical — [title] _([status])_
• BL-004 🟡 high — [title] _([status])_

*KebunPRO* ([N] items)
• BL-002 🟢 medium — [title] _([status])_

_🔴 critical · 🟠 high · 🟡 medium · ⚪ low_
_Total: [N] open items_
```

If zero items match: `_No open backlog items for [filter]._`

---

## Update Flow

### U-1 — Find the item

Parse `BL-NNN` from message. Load `backlog.json`, locate item by id. If not found, list closest matches.

### U-2 — Parse the mutation

| Command | Action |
|---------|--------|
| `done BL-NNN` | Set `status = "done"` |
| `drop BL-NNN` | Set `status = "dropped"` |
| `prioritize BL-NNN critical` | Set `priority` field |
| `ready BL-NNN` | Set `status = "ready"` |
| `groom BL-NNN` | Set `status = "groomed"` |
| `update BL-NNN [field]: [value]` | Update named field |
| `link BL-NNN obj-2 kr-2-q1` | Set `objective_id` and `kr_id` |

### U-3 — Write back

```python
import json
from datetime import date

path = '/workspace/group/backlog/backlog.json'
with open(path) as f:
    store = json.load(f)

for item in store['items']:
    if item['id'] == 'BL-NNN':
        item['FIELD'] = 'NEW_VALUE'
        item['updated'] = date.today().isoformat()
        break

with open(path, 'w') as f:
    json.dump(store, f, indent=2)
print('Updated')
```

Reply: `✅ BL-[N] updated — [field] → [new value]`

---

## Groom Flow

Walk through `new` items one by one. For each item, show:

```
*Grooming BL-[N] ([X] of [total new])*

[title]
Product: [product] · Type: [type] · Priority: [priority]
Objective: [obj name → KR] or _None_

Description:
[description or "(none)"]

Actions:
• ok [priority] — confirm as-is (change priority if specified)
• edit [field]: [value]
• link [obj-id] [kr-id]
• drop
• skip — come back later
```

After each decision, write back before moving to the next item.

When all `new` items are processed (or user says `done`):

```
*Grooming complete*
Groomed: [N] · Dropped: [N] · Skipped: [N]
Ready for sprint: [count of status = "ready"]
```

---

## North Star Linkage

When `north-star.json` is available, use it to:
1. **Suggest linkage** during Add Flow: if the title mentions an objective keyword, propose the matching KR.
2. **Display in List Flow**: show KR tag next to items that have `objective_id` set, formatted as `[obj-name → KR quarter]`.
3. **Groom Flow**: for unlinked items, suggest the most relevant objective based on product and keywords.

Objective-to-product heuristics (adjust as needed):
- `obj-1` (FFB Increment) → KebunPRO, PetaniPRO
- `obj-2` (Fertilizer Sales) → AgenPRO, KebunPRO
- `obj-3` (Farmer Customer Base) → PetaniPRO, AgenPRO, TimPRO

---

## Output Rules

- IDs are immutable once assigned — never renumber.
- Always confirm before writing on Add; no confirmation needed for single-field updates or status changes.
- Use Telegram Markdown (*bold*, _italic_, no tables).
- Priority emoji: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low
- Never delete items — use `dropped` status.
- All timestamps in ISO format (YYYY-MM-DD), no time component needed.
