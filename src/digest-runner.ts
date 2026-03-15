import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DIGEST_INTERVAL_MS,
  DIGEST_LOOKBACK_HOURS,
  GROUPS_DIR,
} from './config.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
} from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

interface DigestRunnerOptions {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return ts;
  }
}

function buildLarkDigest(
  groupJid: string,
  group: RegisteredGroup,
  since: string,
  allLarkJids: string[],
  chatNames: Map<string, string>,
): string | null {
  const isMain = group.isMain === true;
  const now = new Date().toISOString();
  const lines: string[] = [
    `# Lark Digest — ${now}`,
    `# Lookback: ${DIGEST_LOOKBACK_HOURS}h`,
    '',
  ];

  if (isMain) {
    // Aggregate all Lark chats for main group
    if (allLarkJids.length === 0) return null;
    const { messages } = getNewMessages(
      allLarkJids,
      since,
      ASSISTANT_NAME,
      500,
    );
    if (messages.length === 0) return null;

    // Group by chat_jid
    const byChat = new Map<string, typeof messages>();
    for (const msg of messages) {
      const existing = byChat.get(msg.chat_jid);
      if (existing) existing.push(msg);
      else byChat.set(msg.chat_jid, [msg]);
    }

    for (const [jid, msgs] of byChat) {
      const chatName = chatNames.get(jid) || jid;
      lines.push(`## ${chatName} (${jid})`);
      for (const msg of msgs) {
        lines.push(
          `- [${formatTimestamp(msg.timestamp)}] ${msg.sender_name}: ${msg.content}`,
        );
      }
      lines.push('');
    }
  } else {
    // Sub-group: only its own Lark JID
    if (!groupJid.startsWith('lark:')) return null;
    const messages = getMessagesSince(groupJid, since, ASSISTANT_NAME, 200);
    if (messages.length === 0) return null;

    const chatName = chatNames.get(groupJid) || groupJid;
    lines.push(`## ${chatName} (${groupJid})`);
    for (const msg of messages) {
      lines.push(
        `- [${formatTimestamp(msg.timestamp)}] ${msg.sender_name}: ${msg.content}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildGmailDigest(
  allGmailJids: string[],
  since: string,
): string | null {
  if (allGmailJids.length === 0) return null;
  const { messages } = getNewMessages(allGmailJids, since, ASSISTANT_NAME, 200);
  if (messages.length === 0) return null;

  const now = new Date().toISOString();
  const lines: string[] = [
    `# Gmail Digest — ${now}`,
    `# Lookback: ${DIGEST_LOOKBACK_HOURS}h (urgent/VIP only — non-urgent emails not stored)`,
    '',
  ];

  for (const msg of messages) {
    lines.push(
      `- [${formatTimestamp(msg.timestamp)}] ${msg.sender_name}: ${msg.content}`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

function writeCacheFile(
  groupFolder: string,
  channel: string,
  content: string,
): void {
  const dir = path.join(GROUPS_DIR, groupFolder, channel);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'latest.md');
  fs.writeFileSync(filePath, content, 'utf-8');
}

function runDigest(getGroups: () => Record<string, RegisteredGroup>): void {
  const groups = getGroups();
  if (Object.keys(groups).length === 0) return;

  const chats = getAllChats();
  const chatNames = new Map<string, string>();
  const allLarkJids: string[] = [];
  const allGmailJids: string[] = [];

  for (const chat of chats) {
    chatNames.set(chat.jid, chat.name);
    if (chat.jid.startsWith('lark:')) allLarkJids.push(chat.jid);
    if (chat.jid.startsWith('gmail:')) allGmailJids.push(chat.jid);
  }

  const lookbackMs = DIGEST_LOOKBACK_HOURS * 60 * 60 * 1000;
  const since = new Date(Date.now() - lookbackMs).toISOString();

  for (const [jid, group] of Object.entries(groups)) {
    try {
      // Lark digest
      const larkContent = buildLarkDigest(
        jid,
        group,
        since,
        allLarkJids,
        chatNames,
      );
      if (larkContent) {
        writeCacheFile(group.folder, 'lark', larkContent);
        logger.debug({ folder: group.folder }, 'Lark digest written');
      }

      // Gmail digest (main group only)
      if (group.isMain === true) {
        const gmailContent = buildGmailDigest(allGmailJids, since);
        if (gmailContent) {
          writeCacheFile(group.folder, 'gmail', gmailContent);
          logger.debug({ folder: group.folder }, 'Gmail digest written');
        }
      }
    } catch (err) {
      logger.warn(
        { folder: group.folder, err },
        'Digest runner error for group',
      );
    }
  }
}

export function startDigestRunner(opts: DigestRunnerOptions): void {
  // Run once at startup
  try {
    runDigest(opts.registeredGroups);
    logger.info('Digest runner: initial run complete');
  } catch (err) {
    logger.warn({ err }, 'Digest runner: initial run failed');
  }

  // Then on interval
  setInterval(() => {
    try {
      runDigest(opts.registeredGroups);
      logger.debug('Digest runner: interval run complete');
    } catch (err) {
      logger.warn({ err }, 'Digest runner: interval run failed');
    }
  }, DIGEST_INTERVAL_MS);
}
