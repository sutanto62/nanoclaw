---
name: prd-grooming
description: Install the PRD grooming skill into container agents. Scans message sources for recurring themes, scores against north-star.json and WIGs, walks through interactive topic selection, web research, and section-by-section PRD drafting. Triggered by "prd grooming", "sprint grooming", "write prd", "feature ideas", "prd planning", or "grooming session".
---

# PRD Grooming

Installs the PRD grooming skill into the container agent, enabling it to run interactive sprint grooming sessions and save structured PRDs to `prd/YYYY-WNN-{slug}.md` in the group workspace.

## Phase 1: Pre-flight

Check if already installed:

```bash
test -f container/skills/prd-grooming/SKILL.md && echo "already installed" || echo "not installed"
```

Skip if already installed.

## Phase 2: Apply

```bash
git fetch upstream skill/prd-grooming
git merge upstream/skill/prd-grooming
```

Verify the skill was placed:

```bash
test -f container/skills/prd-grooming/SKILL.md && echo "OK" || echo "ERROR: file missing"
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

2. Send a message to a registered group: `prd grooming`
3. The agent should scan message sources and present topic candidates.
4. Select a topic, verify web research runs.
5. Walk through PRD sections interactively.
6. Confirm the file exists:

```bash
ls groups/*/prd/
```

## Removal

```bash
rm -rf container/skills/prd-grooming/
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
