# Intent: src/types.ts

## What Changed
- Added `Receipt` interface between `TaskRunLog` and the channel abstraction section

## Key Sections
- **Receipt interface**: `id`, `chat_jid`, `group_folder`, `date` (YYYY-MM-DD), `store`, `amount` (number), `currency`, `category` (union type), `notes`, `created_at`

## Invariants (must-keep)
- All existing interfaces unchanged: AdditionalMount, MountAllowlist, AllowedRoot, ContainerConfig, RegisteredGroup, NewMessage, ScheduledTask, TaskRunLog, Channel, OnInboundMessage, OnChatMetadata
- No changes to channel abstraction
