/**
 * Receipt tracking helpers — host-side module added by add-receipt skill.
 * Writes a JSON snapshot of receipts into the group workspace so the
 * container agent can read them without an IPC round-trip.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getReceipts } from './db.js';
import { logger } from './logger.js';

/**
 * Write the current receipt list for a group to
 * groups/{folder}/receipts.json so the agent can read it via Read tool.
 */
export function writeReceiptsSnapshot(groupFolder: string): void {
  const receipts = getReceipts(groupFolder);
  const dir = path.join(GROUPS_DIR, groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  const snapshotPath = path.join(dir, 'receipts.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(receipts, null, 2));
  logger.debug(
    { groupFolder, count: receipts.length },
    'Receipts snapshot written',
  );
}
