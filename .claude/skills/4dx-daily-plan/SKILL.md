---
name: 4dx-daily-plan
description: Install the 4DX daily plan skill into container agents. Generates a structured morning daily plan (M1) — WIG focus, time box, lead measures, scoreboard, and binary win check — triggered by "daily plan", "what's today", "today plan", or "today".
---

# 4DX Daily Plan

Installs the 4DX daily plan skill into the container agent, enabling it to generate a structured morning briefing at `daily/YYYY-MM-DD.md` in the group workspace.

## Phase 1: Pre-flight

Check if already installed:

```bash
test -f container/skills/4dx-daily-plan/SKILL.md && echo "already installed" || echo "not installed"
```

Skip if already installed.

## Phase 2: Apply

```bash
npx tsx scripts/apply-skill.ts .claude/skills/4dx-daily-plan
```

Verify the skill was placed:

```bash
test -f container/skills/4dx-daily-plan/SKILL.md && echo "OK" || echo "ERROR: file missing"
```

## Phase 3: Create scheduled tasks

Run the setup script to register the three 4DX cron tasks in SQLite (idempotent — skips if already present):

```bash
npx tsx scripts/setup-4dx-crons.ts telegram_main
```

Expected output:
```
✓ M1 Daily Plan scheduled: 30 8 * * 1-5 (next: ...)
✓ M7 EOD Summary scheduled: 0 16 * * 1-5 (next: ...)
✓ Weekly Cadence scheduled: 0 9 * * 5 (next: ...)
```

If the group is not yet registered (service not started), skip this step and run it after the service is up.

## Phase 4: Rebuild container

```bash
./container/build.sh
```

## Phase 5: Verify

1. Restart the service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

2. Send a message to a registered group: `daily plan` or `what's today`
3. The agent should reply with a structured daily plan.
4. After completing, confirm the file exists:

```bash
ls groups/*/daily/
```

## Removal

```bash
rm -rf container/skills/4dx-daily-plan/
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
