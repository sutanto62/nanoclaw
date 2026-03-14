import { Client, Domain } from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { getAllChats } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// Lark text messages support up to 30,000 characters per message
const MAX_MESSAGE_LENGTH = 30000;

// How many messages to fetch per page (Lark max is 50)
const LARK_PAGE_SIZE = 50;

// Default poll interval: 15 minutes
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;

// Default lookback window when no prior fetch exists for a group: 24 hours
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Known non-text message types → human-readable placeholders
const NON_TEXT_PLACEHOLDERS: Record<string, string> = {
  image: '[Image]',
  audio: '[Audio]',
  video: '[Video]',
  file: '[File]',
  sticker: '[Sticker]',
};

export interface LarkChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class LarkChannel implements Channel {
  name = 'lark';

  private client: Client | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalMs: number;
  private opts: LarkChannelOpts;
  // chatId (without lark: prefix) → last fetched unix ms
  private lastFetchMs = new Map<string, number>();
  // Cache of chatId → display name to avoid repeated im.chat.get() calls
  private chatNameCache = new Map<string, string>();

  constructor(opts: LarkChannelOpts, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    // Read credentials at connect time — never stored as class fields so
    // they can't leak through heap dumps or accidental serialization.
    const env = readEnvFile(['LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_DOMAIN']);
    const appId = env.LARK_APP_ID ?? '';
    const appSecret = env.LARK_APP_SECRET ?? '';
    const domain = env.LARK_DOMAIN === 'feishu' ? Domain.Feishu : Domain.Lark;

    this.client = new Client({ appId, appSecret, domain });

    // Seed per-group cursors from DB so startup only fetches new messages.
    this.seedLastFetchFromDb();

    logger.info({ pollIntervalMs: this.pollIntervalMs }, 'Lark channel connected (poll mode)');
    console.log('\n  Lark bot: connected (poll mode)');
    console.log(`  Polling every ${Math.round(this.pollIntervalMs / 60000)} min\n`);

    // Initial backfill on startup, then schedule recurring polls.
    await this.pollAllGroups();
    this.schedulePoll();
  }

  private seedLastFetchFromDb(): void {
    const chats = getAllChats();
    for (const chat of chats) {
      if (!chat.jid.startsWith('lark:')) continue;
      if (!chat.last_message_time) continue;
      const chatId = chat.jid.replace(/^lark:/, '');
      this.lastFetchMs.set(chatId, new Date(chat.last_message_time).getTime());
    }
    logger.debug({ seeded: this.lastFetchMs.size }, 'Lark cursors seeded from DB');
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(async () => {
      if (!this.client) return;
      await this.pollAllGroups().catch((err) =>
        logger.error({ err }, 'Lark poll error'),
      );
      this.schedulePoll();
    }, this.pollIntervalMs);
  }

  private async pollAllGroups(): Promise<void> {
    const groups = this.opts.registeredGroups();
    const larkJids = Object.keys(groups).filter((j) => j.startsWith('lark:'));
    if (larkJids.length === 0) return;
    logger.debug({ count: larkJids.length }, 'Lark polling groups');
    await Promise.all(larkJids.map((jid) => this.fetchGroupMessages(jid)));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchGroupMessages(chatJid: string): Promise<void> {
    if (!this.client) return;
    const chatId = chatJid.replace(/^lark:/, '');

    // If no prior fetch, look back 24h so we don't miss recent messages.
    const sinceMs =
      this.lastFetchMs.get(chatId) ?? Date.now() - DEFAULT_LOOKBACK_MS;

    // Lark start_time is in seconds (not ms).
    const startTimeSec = Math.floor(sinceMs / 1000);

    let newestMs = sinceMs;
    let pageToken: string | undefined;
    let fetched = 0;

    do {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let res: any;
      try {
        res = await this.client.im.message.list({
          params: {
            container_id: chatId,
            container_id_type: 'chat',
            start_time: String(startTimeSec),
            sort_type: 'ByCreateTimeAsc',
            page_size: LARK_PAGE_SIZE,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });
      } catch (err) {
        logger.error({ chatJid, err }, 'Lark message.list failed');
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: any[] = res.data?.items ?? [];
      pageToken = res.data?.page_token;

      for (const item of items) {
        // Skip bot/app messages (our own sent responses).
        if (item.sender?.sender_type === 'app') continue;

        const createMs = parseInt(item.create_time || '0');
        if (createMs > newestMs) newestMs = createMs;

        await this.processItem(item, chatId, chatJid);
        fetched++;
      }
    } while (pageToken);

    if (fetched > 0) {
      logger.info({ chatJid, fetched }, 'Lark messages fetched');
    }

    // Always advance cursor to avoid re-fetching the same window.
    this.lastFetchMs.set(chatId, newestMs);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processItem(item: any, chatId: string, chatJid: string): Promise<void> {
    const senderId: string = item.sender?.id || '';
    const senderName: string = item.sender?.id || senderId || 'Unknown';
    const timestamp = new Date(parseInt(item.create_time || '0')).toISOString();

    const chatName = await this.getChatName(chatId);
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'lark', true);

    const msgType: string = item.msg_type || '';
    let content: string;

    if (msgType !== 'text') {
      const safeType = msgType.replace(/[^\x20-\x7E]/g, '?');
      content = NON_TEXT_PLACEHOLDERS[msgType] ?? `[${safeType}]`;
    } else {
      try {
        content =
          (JSON.parse(item.body?.content || '{}') as { text?: string }).text || '';
      } catch {
        content = item.body?.content || '';
      }

      // Translate @bot mentions into TRIGGER_PATTERN format.
      // Bot/app mentions have no user_id, distinguishing them from @colleague.
      const mentions: Array<{ id?: { user_id?: string } }> = item.mentions || [];
      const hasBotMention = mentions.some((m) => !m.id?.user_id);
      if (hasBotMention && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) return;

    this.opts.onMessage(chatJid, {
      id: item.message_id || '',
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  // Resolve a Lark chat_id to its display name via a single API call, then cache.
  private async getChatName(chatId: string): Promise<string | undefined> {
    const cached = this.chatNameCache.get(chatId);
    if (cached !== undefined) return cached;
    if (!this.client) return undefined;
    try {
      const res = await this.client.im.chat.get({ path: { chat_id: chatId } });
      const name = res.data?.name;
      if (name) this.chatNameCache.set(chatId, name);
      return name || undefined;
    } catch (err) {
      logger.debug({ chatId, err }, 'Failed to resolve Lark chat name');
      return undefined;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Lark client not initialized');
      return;
    }

    const chatId = jid.replace(/^lark:/, '');
    const chunks =
      text.length <= MAX_MESSAGE_LENGTH
        ? [text]
        : Array.from(
            { length: Math.ceil(text.length / MAX_MESSAGE_LENGTH) },
            (_, i) =>
              text.slice(i * MAX_MESSAGE_LENGTH, (i + 1) * MAX_MESSAGE_LENGTH),
          );

    for (const chunk of chunks) {
      try {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ text: chunk }),
            msg_type: 'text',
          },
        });
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send Lark message');
        return;
      }
    }

    logger.info({ jid, length: text.length }, 'Lark message sent');
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('lark:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.client = null;
    logger.info('Lark channel stopped');
  }

  // Lark does not expose a typing indicator API
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {}
}

registerChannel('lark', (opts: ChannelOpts) => {
  // Read from .env only — keeps secrets out of process.env so they
  // don't leak to child processes (containers/agents).
  const env = readEnvFile(['LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_POLL_INTERVAL_MS']);
  if (!env.LARK_APP_ID || !env.LARK_APP_SECRET) {
    logger.warn('Lark: LARK_APP_ID or LARK_APP_SECRET not set, skipping');
    return null;
  }
  const pollIntervalMs = env.LARK_POLL_INTERVAL_MS
    ? parseInt(env.LARK_POLL_INTERVAL_MS, 10)
    : DEFAULT_POLL_INTERVAL_MS;
  return new LarkChannel(opts, pollIntervalMs);
});
