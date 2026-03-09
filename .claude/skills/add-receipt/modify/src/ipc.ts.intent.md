# Intent: src/ipc.ts

## What Changed
- Added `storeReceipt` to the import from `./db.js`
- Added `import { writeReceiptsSnapshot } from './receipt.js'`
- Added `Receipt` to the import from `./types.js`
- Added `receipt?: Partial<Receipt>` field to the `data` parameter type in `processTaskIpc`
- Added `case 'save_receipt'` handler in the switch statement — placed first for clarity, before `schedule_task`

## Key Sections
- **save_receipt handler**: validates required fields (date, store, amount, currency, category), resolves chat_jid from registered groups, generates a unique id, calls `storeReceipt()`, then calls `writeReceiptsSnapshot()` to update the agent-readable JSON file

## Invariants (must-keep)
- All existing case handlers unchanged: schedule_task, pause_task, resume_task, cancel_task, update_task, refresh_groups, register_group
- IPC watcher loop, directory scanning, error handling, and file cleanup logic unchanged
- Authorization model (isMain check, sourceGroup identity) unchanged
- `IpcDeps` interface unchanged
