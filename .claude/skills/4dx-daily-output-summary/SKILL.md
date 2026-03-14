---
name: 4dx-daily-output-summary
description: Install the 4DX EOD output summary skill into container agents. Generates a structured end-of-day summary (M7) — Whirlwind Ledger, WIG Output, M1 commitment review, scoreboard delta, carry-forward, and binary Win/Loss verdict — triggered by "EOD", "end of day", "daily summary", "M7", or "wrap up my day".
---

# 4DX Daily Output Summary

Installs the 4DX EOD output summary skill into the container agent, enabling it to generate a structured end-of-day debrief appended to `daily/YYYY-MM-DD.md` in the group workspace.

## Phase 1: Pre-flight

Check if already installed:

```bash
test -f container/skills/4dx-daily-output-summary/SKILL.md && echo "already installed" || echo "not installed"
```

Skip if already installed.

## Phase 2: Apply

```bash
npx tsx scripts/apply-skill.ts .claude/skills/4dx-daily-output-summary
```

Verify the skill was placed:

```bash
test -f container/skills/4dx-daily-output-summary/SKILL.md && echo "OK" || echo "ERROR: file missing"
```

## Phase 3: Rebuild container

```bash
./container/build.sh
```

## Phase 4: Verify

1. Restart the service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

2. Send a message to a registered group: `EOD` or `wrap up my day`
3. The agent should gather context, ask ≤ 4 gap-fill questions, then output the full summary.
4. After completing, confirm the file exists:

```bash
ls groups/*/daily/
```

## Removal

```bash
rm -rf container/skills/4dx-daily-output-summary/
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
