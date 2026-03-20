---
name: add-weekly-cadence
description: Add weekly cadence skill to container agents. Guides the user through a structured 4DX weekly review — audit past WIG commitments, update the scoreboard, and commit to next week's lead measures. Saves a dated summary to the group workspace.
---

# Add Weekly Cadence

Installs the weekly cadence skill into the container agent, enabling it to walk through a structured 4DX 20-Minute Win review and save `weekly/YYYY-WXX.md` to the group workspace.

## Phase 1: Pre-flight

Check if already installed:

```bash
test -f container/skills/weekly-cadence/SKILL.md && echo "already installed" || echo "not installed"
```

Skip if already installed.

## Phase 2: Apply

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-weekly-cadence
```

Verify the skill was placed:

```bash
test -f container/skills/weekly-cadence/SKILL.md && echo "OK" || echo "ERROR: file missing"
```

## Phase 3: Rebuild container

The container image must be rebuilt so the new skill is included:

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

2. Send a message to a registered group: `weekly cadence`, `weekly review`, or `cadence`
3. The agent should start the guided walkthrough and reply with Phase 1 — Past Commitment Audit.
4. After completing all 3 phases, confirm the file exists:

```bash
ls groups/*/weekly/
```

## Removal

```bash
rm -rf container/skills/weekly-cadence/
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
