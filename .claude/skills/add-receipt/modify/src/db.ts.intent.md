# Intent: src/db.ts

## What Changed
- Added `Receipt` to the import from `./types.js`
- Added `receipts` table to `createSchema()` with columns: id, chat_jid, group_folder, date, store, amount, currency, category, notes, created_at
- Added index `idx_receipts_group` on `receipts(group_folder)`
- Added three exported functions at the end of the file (before `migrateJsonState`):
  - `storeReceipt(receipt)` — INSERT OR REPLACE
  - `getReceipts(groupFolder)` — SELECT ordered by date DESC
  - `deleteReceipt(id)` — DELETE by primary key

## Key Sections
- **createSchema** (line ~17): receipts table added inside the exec block alongside existing tables
- **Receipt accessors** section: new block added before the JSON migration section

## Invariants (must-keep)
- All existing table definitions unchanged (chats, messages, scheduled_tasks, task_run_logs, router_state, sessions, registered_groups)
- All existing migrations (ALTER TABLE blocks) unchanged
- All existing exported functions unchanged
- `migrateJsonState` unchanged
