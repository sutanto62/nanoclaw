---
name: receipt-tracker
version: 2.0.0
description: |
  Extract and categorize expense receipts. Parses date, store name, and total
  amount from receipt images or text. Categorizes into Transportation, Travel Claim,
  Medical, or Other. Saves via IPC to host SQLite. Read receipts.json for reporting.
allowed-tools:
  - Read
  - Bash
---

# Receipt Tracker

Extract receipt data, confirm with the user, then save via IPC. The host stores records in SQLite and keeps `/workspace/group/receipts.json` up to date.

## Trigger

Use this skill whenever the user:
- Sends a receipt image link (Google Drive, Dropbox, or any direct image URL)
- Sends text containing a receipt (totals, store name, date)
- Says "add receipt", "log expense", "track this receipt", or similar
- Asks to view, search, or export their expense records

---

## Step 1: Obtain the Receipt

**Image URL or Google Drive link** — download and read visually:

```bash
# Convert Drive sharing link: extract FILE_ID from the URL, then:
curl -L "https://drive.google.com/uc?export=download&id=FILE_ID" \
  -o /tmp/receipt.jpg 2>/dev/null
```

Then `Read /tmp/receipt.jpg` — Claude sees the image and can extract data from it.

**Plain text** — parse directly from the message.

---

## Step 2: Extract Data

Extract these four fields:

| Field | Format | Example |
|-------|--------|---------|
| `date` | YYYY-MM-DD | `2026-03-09` |
| `store` | Merchant name | `Grab`, `Clinic Sejahtera` |
| `amount` | Number only | `45.50` |
| `currency` | Code | `IDR`, `MYR`, `SGD`, `USD` |

Amounts may use `,` or `.` as thousand separator — normalize to a plain number.

If any field is unclear, ask the user before continuing.

---

## Step 3: Determine Category

| Category | When to use |
|----------|-------------|
| **Transportation** | Grab, taxi, bus, train, toll, parking, fuel, flight |
| **Travel Claim** | Hotel, meals during travel, airport transfers, travel insurance |
| **Medical** | Doctor, clinic, pharmacy, hospital, medicine, dental, optical |
| **Other** | Anything that does not fit the above |

If ambiguous (e.g. Grab ride during a business trip), ask the user.

---

## Step 4: Confirm with User

Send the summary wrapped in triple backticks before saving:

```
Receipt ready to save:

  Date:      2026-03-09
  Store:     Grab
  Amount:    MYR 25.00
  Category:  Transportation

Save this? Reply yes/no, or correct any field.
```

- **yes / ok / save** → Step 5
- **no / cancel** → discard, stop
- **correction** → update and re-confirm

---

## Step 5: Save via IPC

Write a JSON file to `/workspace/ipc/tasks/` — the host processes it and saves to SQLite:

```bash
cat > "/workspace/ipc/tasks/receipt-$(date +%s%N).json" << 'EOF'
{
  "type": "save_receipt",
  "receipt": {
    "date": "2026-03-09",
    "store": "Grab",
    "amount": 25.00,
    "currency": "MYR",
    "category": "Transportation",
    "notes": ""
  }
}
EOF
```

After writing the file, confirm to the user wrapped in triple backticks:

```
Saved. Check your expenses with "show my expenses".
```

---

## Viewing and Reporting

Read `/workspace/group/receipts.json` (updated by host after each save) and present a summary wrapped in triple backticks:

```
Expenses — March 2026

Transportation   MYR  75.00  (3 items)
Medical          MYR  80.00  (1 item)
Travel Claim     MYR 320.00  (2 items)
─────────────────────────────────────
Total            MYR 475.00
```

Filter by category or date range when requested.

---

## Edge Cases

- **Duplicate**: If same date + store + amount exists in receipts.json, warn before saving
- **Multiple receipts in one image**: Process one at a time
- **Missing amount**: Do not save — ask the user
- **Drive download fails**: Ask the user to paste receipt details as text
