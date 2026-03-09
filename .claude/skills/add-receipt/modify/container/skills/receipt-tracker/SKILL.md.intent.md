# Intent: container/skills/receipt-tracker/SKILL.md

## What Changed
- Bumped version to 2.0.0
- Replaced CSV storage (Write tool) with IPC-based storage (Bash writes JSON to /workspace/ipc/tasks/)
- Removed `Write` and `Edit` from allowed-tools (no longer writes files directly)
- Simplified from ~170 lines to ~100 lines
- Viewing now reads `/workspace/group/receipts.json` (written by host) instead of `/workspace/expenses.csv`
- Removed curl/Drive download logic from steps (kept minimal)

## Invariants (must-keep)
- Trigger conditions unchanged
- Category table (Transportation, Travel Claim, Medical, Other) unchanged
- Confirmation flow (triple backtick formatting, yes/no/correct) unchanged
- Edge cases section preserved
