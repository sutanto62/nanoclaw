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
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import { loadWigDefinitions } from './wig-scorer.js';

// The digest runner periodically snapshots recent channel messages to disk as
// markdown files. Container agents read these files at runtime instead of
// querying the database or live APIs — keeping agents stateless and fast.
//
// Output files:
//   groups/{folder}/lark/latest.md       — recent Lark messages
//   groups/{folder}/gmail/latest.md      — recent urgent/VIP emails (main only)
//   groups/{folder}/4dx/wig-context.md   — WIG/whirlwind-tagged messages (main only)
//
// The files are bind-mounted into the container at /workspace/group/, so the
// agent can read them directly via the filesystem without any IPC.

interface DigestRunnerOptions {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Reduces an ISO timestamp to HH:MM for compact digest display.
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

// Reads LARK_DOMAIN from .env to choose between Lark (international) and
// Feishu (China) deep link URLs. Called per digest run so domain changes
// take effect without a restart.
function getLarkDeepLinkBase(): string {
  const env = readEnvFile(['LARK_DOMAIN']);
  return env.LARK_DOMAIN === 'feishu'
    ? 'https://applink.feishu.cn/client/chat_detail?chat_id='
    : 'https://applink.larksuite.com/client/chat_detail?chat_id=';
}

// Builds the markdown content for a group's Lark digest.
//
// Behaviour differs by group type:
//   - Main group: aggregates messages from ALL Lark chats the bot has seen,
//     grouped by chat. This gives the main agent a cross-chat view.
//   - Sub-group: only includes messages from its own single Lark chat JID.
//
// Returns null if there is nothing to write (no JIDs, wrong channel type).
function buildLarkDigest(
  groupJid: string,
  group: RegisteredGroup,
  since: string,
  allLarkJids: string[],
  chatNames: Map<string, string>,
): string | null {
  const isMain = group.isMain === true;
  const now = new Date().toISOString();
  const deepLinkBase = getLarkDeepLinkBase();
  const lines: string[] = [
    `# Lark Digest — ${now}`,
    `# Lookback: ${DIGEST_LOOKBACK_HOURS}h`,
    '',
  ];

  if (isMain) {
    if (allLarkJids.length === 0) return null;

    // Fetch up to 500 messages across all Lark chats since the lookback window.
    // ASSISTANT_NAME is excluded so the agent's own replies don't appear in
    // the digest and inflate the apparent message volume.
    const { messages } = getNewMessages(
      allLarkJids,
      since,
      ASSISTANT_NAME,
      500,
    );
    if (messages.length === 0) {
      lines.push(
        '(No messages in the last ' + DIGEST_LOOKBACK_HOURS + ' hours)',
      );
      return lines.join('\n');
    }

    // Re-group flat message list by chat so the digest is readable per-chat.
    const byChat = new Map<string, typeof messages>();
    for (const msg of messages) {
      const existing = byChat.get(msg.chat_jid);
      if (existing) existing.push(msg);
      else byChat.set(msg.chat_jid, [msg]);
    }

    for (const [jid, msgs] of byChat) {
      const chatName = chatNames.get(jid) || jid;
      lines.push(`## ${chatName} (${jid})`);
      // Deep link lets the agent (or human reading the file) jump directly
      // into the Lark chat for context.
      const chatId = jid.replace(/^lark:/, '');
      lines.push(`🔗 Open in Lark: ${deepLinkBase}${chatId}`);
      for (const msg of msgs) {
        lines.push(
          `- [${formatTimestamp(msg.timestamp)}] ${msg.sender_name}: ${msg.content}`,
        );
      }
      lines.push('');
    }
  } else {
    // Sub-group digest: only meaningful if this group maps to a Lark chat.
    if (!groupJid.startsWith('lark:')) return null;

    // Fetch up to 200 messages — sub-groups are single-chat so the volume
    // is lower and a tighter cap keeps the file size manageable.
    const messages = getMessagesSince(groupJid, since, ASSISTANT_NAME, 200);
    if (messages.length === 0) {
      lines.push(
        '(No messages in the last ' + DIGEST_LOOKBACK_HOURS + ' hours)',
      );
      return lines.join('\n');
    }

    const chatName = chatNames.get(groupJid) || groupJid;
    lines.push(`## ${chatName} (${groupJid})`);
    const chatId = groupJid.replace(/^lark:/, '');
    lines.push(`🔗 Open in Lark: ${deepLinkBase}${chatId}`);
    for (const msg of messages) {
      lines.push(
        `- [${formatTimestamp(msg.timestamp)}] ${msg.sender_name}: ${msg.content}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// Builds the markdown content for the Gmail digest (main group only).
//
// Only urgent/VIP emails are stored in the DB by the Gmail channel, so this
// digest already represents a pre-filtered view — no extra filtering needed.
function buildGmailDigest(
  allGmailJids: string[],
  since: string,
): string | null {
  if (allGmailJids.length === 0) return null;

  const now = new Date().toISOString();
  const { messages } = getNewMessages(allGmailJids, since, ASSISTANT_NAME, 200);
  const lines: string[] = [
    `# Gmail Digest — ${now}`,
    `# Lookback: ${DIGEST_LOOKBACK_HOURS}h (urgent/VIP only — non-urgent emails not stored)`,
    '',
  ];

  if (messages.length === 0) {
    lines.push(
      '(No urgent/VIP emails in the last ' + DIGEST_LOOKBACK_HOURS + ' hours)',
    );
    lines.push('');
    return lines.join('\n');
  }

  for (const msg of messages) {
    lines.push(
      `- [${formatTimestamp(msg.timestamp)}] ${msg.sender_name}: ${msg.content}`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

// Writes a digest string to groups/{folder}/{channel}/latest.md.
// The directory is created if it doesn't exist (first run after a new channel
// is added or a group folder is freshly initialised).
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

// Extracts WIG IDs from semantic tags in the message content.
// Messages processed by lark.ts/gmail.ts now carry `[WIG-{id}]` tags
// (e.g. "[WIG-1] [WIG-3]") prepended by the scorer, so we read the tags
// directly instead of re-running keyword matching.
function extractWigIdsFromTags(text: string): number[] {
  const matches = text.match(/\[WIG-(\d+)\]/gi) || [];
  return [
    ...new Set(
      matches.map((m) => parseInt(m.replace(/\[WIG-/i, '').replace(']', ''))),
    ),
  ];
}

// Builds groups/{folder}/4dx/wig-context.md for the main group.
//
// Purpose: give the agent a focused, WIG-centric view of channel activity
// separate from the general Lark/Gmail digests. The agent uses this when
// generating daily plans (M1) and EOD summaries (M7).
//
// A message is included if any of these match:
//   1. Contains a `[WIG-{id}]` tag (prepended by lark.ts/gmail.ts after semantic scoring)
//   2. Contains the literal word "whirlwind"
//
// Messages are bucketed by WIG ID so the agent can see activity per WIG.
// Whirlwind mentions and untagged messages land in bucket 0.
// A message can appear in multiple WIG buckets if it has multiple WIG tags.
function buildWigChannelContext(
  groupFolder: string,
  allLarkJids: string[],
  allGmailJids: string[],
  since: string,
  chatNames: Map<string, string>,
): void {
  const wigPath = path.join(GROUPS_DIR, groupFolder, '4dx', 'wig.json');
  // Skip entirely if the group hasn't defined any WIGs yet.
  if (!fs.existsSync(wigPath)) return;

  const wigDefs = loadWigDefinitions(groupFolder);
  const allJids = [...allLarkJids, ...allGmailJids];
  if (allJids.length === 0) return;

  const { messages } = getNewMessages(allJids, since, ASSISTANT_NAME, 500);

  const WHIRLWIND_RE = /whirlwind/i;
  const WIG_TAG_RE = /\[WIG-\d+\]/i;

  // First pass: discard messages that have no WIG relevance at all.
  const relevant = messages.filter((msg) => {
    const text = msg.content || '';
    return WIG_TAG_RE.test(text) || WHIRLWIND_RE.test(text);
  });

  // Initialise buckets: one per WIG ID + bucket 0 for whirlwind/untagged.
  const byWig = new Map<number, typeof messages>();
  byWig.set(0, []);
  for (const wig of wigDefs) byWig.set(wig.id, []);

  // Second pass: route each relevant message to the appropriate bucket(s).
  // A whirlwind mention always goes to bucket 0 even if it also has WIG tags.
  for (const msg of relevant) {
    const text = msg.content || '';
    const matchedIds = extractWigIdsFromTags(text);
    if (matchedIds.length === 0 || WHIRLWIND_RE.test(text)) {
      byWig.get(0)!.push(msg);
    }
    for (const id of matchedIds) {
      const bucket = byWig.get(id);
      if (bucket) bucket.push(msg);
    }
  }

  const now = new Date().toISOString();
  const lines: string[] = [
    '# WIG/Whirlwind Channel Context',
    `Generated: ${now}`,
    `Lookback: ${DIGEST_LOOKBACK_HOURS}h`,
    '',
  ];

  let hasContent = false;

  // Render a section per WIG, in wig.json order.
  for (const wig of wigDefs) {
    const msgs = byWig.get(wig.id) || [];
    lines.push(`## WIG ${wig.id} — ${wig.name}`);
    if (msgs.length === 0) {
      lines.push('(no entries)');
    } else {
      hasContent = true;
      for (const msg of msgs) {
        const chatName = chatNames.get(msg.chat_jid) || msg.chat_jid;
        lines.push(
          `- [${msg.timestamp.slice(0, 16).replace('T', ' ')}] ${chatName} · ${msg.sender_name}: ${msg.content}`,
        );
      }
    }
    lines.push('');
  }

  // Bucket 0: whirlwind mentions and messages that matched no specific WIG.
  const untagged = byWig.get(0) || [];
  lines.push('## Whirlwind / Untagged Mentions');
  if (untagged.length === 0) {
    lines.push('(no entries)');
  } else {
    hasContent = true;
    for (const msg of untagged) {
      const chatName = chatNames.get(msg.chat_jid) || msg.chat_jid;
      lines.push(
        `- [${msg.timestamp.slice(0, 16).replace('T', ' ')}] ${chatName} · ${msg.sender_name}: ${msg.content}`,
      );
    }
  }
  lines.push('');

  if (!hasContent) {
    lines.push('_No WIG/Whirlwind-related messages in the lookback window._');
  }

  const outDir = path.join(GROUPS_DIR, groupFolder, '4dx');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'wig-context.md'),
    lines.join('\n'),
    'utf-8',
  );
  logger.debug({ folder: groupFolder }, 'WIG channel context written');
}

// Orchestrates a single digest cycle across all registered groups.
//
// Steps:
//   1. Load all known chats from DB to build a jid→name lookup and partition
//      JIDs by channel type (lark:, gmail:).
//   2. Compute the lookback window (now − DIGEST_LOOKBACK_HOURS).
//   3. For each registered group:
//      - Write groups/{folder}/lark/latest.md
//      - Write groups/{folder}/gmail/latest.md  (main group only)
//      - Write groups/{folder}/4dx/wig-context.md  (main group only)
//
// Errors per group are caught individually so one bad group doesn't abort
// the entire cycle.
function runDigest(getGroups: () => Record<string, RegisteredGroup>): void {
  const groups = getGroups();
  if (Object.keys(groups).length === 0) return;

  // Build a unified jid→name map and channel-partitioned JID lists in one
  // pass over the chats table to avoid repeated DB queries below.
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

      // Gmail and WIG context are only relevant for the main group because
      // sub-groups are scoped to a single chat and don't need cross-channel views.
      if (group.isMain === true) {
        const gmailContent = buildGmailDigest(allGmailJids, since);
        if (gmailContent) {
          writeCacheFile(group.folder, 'gmail', gmailContent);
          logger.debug({ folder: group.folder }, 'Gmail digest written');
        }
        buildWigChannelContext(
          group.folder,
          allLarkJids,
          allGmailJids,
          since,
          chatNames,
        );
      }
    } catch (err) {
      logger.warn(
        { folder: group.folder, err },
        'Digest runner error for group',
      );
    }
  }
}

// Entry point. Runs one digest immediately at startup so the agent has fresh
// context from the first invocation, then repeats on DIGEST_INTERVAL_MS.
export function startDigestRunner(opts: DigestRunnerOptions): void {
  try {
    runDigest(opts.registeredGroups);
    logger.info('Digest runner: initial run complete');
  } catch (err) {
    logger.warn({ err }, 'Digest runner: initial run failed');
  }

  setInterval(() => {
    try {
      runDigest(opts.registeredGroups);
      logger.debug('Digest runner: interval run complete');
    } catch (err) {
      logger.warn({ err }, 'Digest runner: interval run failed');
    }
  }, DIGEST_INTERVAL_MS);
}
