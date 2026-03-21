---
name: backlog-collector
description: Install the backlog collector skill into container agents. Records and validates product backlog ideas with CPO perspective — web research, business English refinement, north-star.json linkage. Triggered by "backlog this", "backlog", "show backlog", or "BL-". Output feeds prd-groomer skill.
---

# Backlog Collector

Installs the backlog collector skill into the container agent, enabling it to record and validate product backlog ideas with a Chief of Product perspective — web research, business English refinement, and north-star.json linkage. Items stored at `backlog/backlog.json` in the group workspace, ready for the prd-groomer skill.

## Phase 1: Pre-flight

Check if already installed:

```bash
test -f container/skills/backlog-collector/SKILL.md && echo "already installed" || echo "not installed"
```

Skip if already installed.

## Phase 2: Apply

```bash
git fetch upstream skill/backlog-collector
git merge upstream/skill/backlog-collector
```

Verify the skill was placed:

```bash
test -f container/skills/backlog-collector/SKILL.md && echo "OK" || echo "ERROR: file missing"
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

2. Send a message to a registered group: `add backlog: KebunPRO — farmer bulk upload`
3. The agent should confirm the item and reply with `✅ BL-001 added`.
4. Send `show backlog` — the agent should list open items grouped by product.

## Removal

```bash
rm -rf container/skills/backlog-collector/
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
