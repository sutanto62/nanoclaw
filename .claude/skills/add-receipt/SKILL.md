---
name: add-receipt
description: Add receipt extraction and expense tracking with SQLite storage. Agents extract date, store, and amount; categorize into Transportation, Travel Claim, or Medical; confirm with the user; then save via IPC to the host database. Includes receipts.json snapshot for agent reporting.
---

# Add Receipt Tracker

Installs host-side TypeScript for receipt storage (SQLite + IPC) and a streamlined agent skill that delegates persistence to the host.

## Phase 1: Pre-flight

1. Check `.nanoclaw/state.yaml` — skip if `add-receipt` is already applied
2. Ensure `.nanoclaw/` is initialized:
   ```bash
   npx tsx -e "import { initNanoclawDir } from './skills-engine/init.ts'; initNanoclawDir();"
   ```

## Phase 2: Apply Code Changes

1. Apply the skill:
   ```bash
   npx tsx scripts/apply-skill.ts add-receipt
   ```

2. Build:
   ```bash
   npm run build
   ```

3. Validate:
   ```bash
   npm run typecheck
   ```

## Phase 3: Clean Up Old Skill

Remove the original Type 1 skill directory (replaced by the version shipped in this skill's `add/` tree):

```bash
rm -rf container/skills/receipt-tracker/
```

Restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

1. Send a test message to a registered group: `log receipt MYR 25 Grab 2026-03-09`
2. Agent should extract, categorize (Transportation), and confirm
3. Reply `yes` — agent writes IPC file
4. Check the database:
   ```bash
   sqlite3 data/store/messages.db "SELECT * FROM receipts;"
   ```
5. Check the snapshot was written:
   ```bash
   cat groups/*/receipts.json
   ```
6. Send `show my expenses` — agent reads receipts.json and replies with a summary

## Troubleshooting

- **"Unknown IPC task type: save_receipt"**: Service is running old code — rebuild (`npm run build`) and restart
- **receipts.json not created**: Check host logs for `save_receipt` IPC processing errors
- **Agent writes to CSV instead of IPC**: Old SKILL.md still in `container/skills/receipt-tracker/` — remove it and restart
