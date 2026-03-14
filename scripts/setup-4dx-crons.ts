#!/usr/bin/env tsx
/**
 * setup-4dx-crons.ts
 *
 * Creates the three 4DX scheduled tasks in SQLite for the target group:
 *   - M1 Daily Plan:    08:30 Mon–Fri
 *   - M7 EOD Summary:   16:00 Mon–Fri
 *   - Weekly Cadence:   09:00 Friday
 *
 * Usage:
 *   npx tsx scripts/setup-4dx-crons.ts [group-folder]
 *
 * If group-folder is omitted, defaults to "telegram_main".
 * Skips creation if tasks already exist for the group.
 */

import { randomUUID } from 'crypto';

import { CronExpressionParser } from 'cron-schedule';

import { TIMEZONE } from '../src/config.js';
import {
  initDatabase,
  getAllRegisteredGroups,
  getTasksForGroup,
  createTask,
} from '../src/db.js';

const TARGET_FOLDER = process.argv[2] || 'telegram_main';

initDatabase();

// Resolve chat_jid from registered groups
const groups = getAllRegisteredGroups();
const entry = Object.entries(groups).find(
  ([, g]) => g.folder === TARGET_FOLDER,
);

if (!entry) {
  console.error(
    `Group "${TARGET_FOLDER}" is not registered. Register the group first.`,
  );
  process.exit(1);
}

const [chatJid] = entry;

// Check for existing 4DX tasks
const existing = getTasksForGroup(TARGET_FOLDER);
const has4dx = existing.some(
  (t) =>
    t.prompt.includes('4DX') ||
    t.prompt.includes('daily plan') ||
    t.prompt.includes('M1') ||
    t.prompt.includes('M7') ||
    t.prompt.includes('EOD') ||
    t.prompt.toLowerCase().includes('weekly cadence'),
);

if (has4dx) {
  console.log(
    `4DX cron tasks already exist for "${TARGET_FOLDER}" — skipping.`,
  );
  process.exit(0);
}

const tasks = [
  {
    prompt: 'Generate my 4DX morning daily plan (M1) for today.',
    cron: '30 8 * * 1-5',
    label: 'M1 Daily Plan',
  },
  {
    prompt: 'Generate my 4DX end-of-day summary (M7) for today.',
    cron: '0 16 * * 1-5',
    label: 'M7 EOD Summary',
  },
  {
    prompt: 'Generate my weekly 4DX cadence review.',
    cron: '0 9 * * 5',
    label: 'Weekly Cadence',
  },
];

for (const task of tasks) {
  const interval = CronExpressionParser.parse(task.cron, { tz: TIMEZONE });
  const nextRun = interval.next().toISOString();

  createTask({
    id: randomUUID(),
    group_folder: TARGET_FOLDER,
    chat_jid: chatJid,
    prompt: task.prompt,
    schedule_type: 'cron',
    schedule_value: task.cron,
    context_mode: 'group',
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  console.log(`✓ ${task.label} scheduled: ${task.cron} (next: ${nextRun})`);
}

console.log(`\nAll 4DX cron tasks created for group "${TARGET_FOLDER}".`);
