import fs from 'fs';
import path from 'path';

import { Client, Domain } from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { getAllChats } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  hasOpenSignalForKey,
  isResolutionContent,
  upsertWigSignal,
} from '../wig-signals.js';
import {
  batchScoreWigRelevance,
  isWigScorable,
  loadWigDefinitions,
  WigDefinition,
  WigScorerBatchItem,
  WigScorerResult,
} from '../wig-scorer.js';
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

// LarkChannel polls the Lark API on a fixed interval to fetch new messages.
// Lark does not support webhooks for self-built apps in all configurations,
// so poll mode is used universally. The channel handles both registered groups
// (explicitly configured in the DB) and unregistered chats the bot is a member
// of, so WIG signals can be captured from any workspace chat.
export class LarkChannel implements Channel {
  name = 'lark';

  private client: Client | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalMs: number;
  private opts: LarkChannelOpts;
  // Per-chat cursor: chatId (without lark: prefix) → last fetched unix ms.
  // Persisted across polls so each fetch only retrieves new messages.
  private lastFetchMs = new Map<string, number>();
  // Cache of chatId → display name to avoid repeated im.chat.get() calls
  private chatNameCache = new Map<string, string>();
  // Bot's own open_id — fetched at connect time for precise mention detection
  private botOpenId: string | null = null;
  private deepLinkBase: string = '';
  // Full list of chat IDs the bot is a member of, refreshed periodically.
  private allBotChatIds: string[] = [];
  private pollCount = 0;
  // Refresh the full chat list every 4 polls (~1x/hr at the 15-min default).
  // Avoids an API call on every poll while still discovering new chats quickly.
  private readonly CHAT_LIST_REFRESH_EVERY = 4;

  constructor(
    opts: LarkChannelOpts,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  // Startup sequence:
  //   1. Build a Lark SDK client from credentials in .env
  //   2. Resolve the bot's own open_id (needed for precise @mention detection)
  //   3. Seed per-chat cursors from the DB (skip already-seen messages on restart)
  //   4. Run an initial poll to backfill any messages received since last run
  //   5. Schedule recurring polls
  async connect(): Promise<void> {
    // Read credentials at connect time — never stored as class fields so
    // they can't leak through heap dumps or accidental serialization.
    const env = readEnvFile(['LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_DOMAIN']);
    const appId = env.LARK_APP_ID ?? '';
    const appSecret = env.LARK_APP_SECRET ?? '';
    const domain = env.LARK_DOMAIN === 'feishu' ? Domain.Feishu : Domain.Lark;
    this.deepLinkBase =
      env.LARK_DOMAIN === 'feishu'
        ? 'https://applink.feishu.cn/client/chat_detail?chat_id='
        : 'https://applink.larksuite.com/client/chat_detail?chat_id=';

    this.client = new Client({ appId, appSecret, domain });

    // Fetch the bot's own open_id so we can precisely detect @bot mentions
    // rather than relying on absence of user_id (which can be absent for
    // regular users too, causing false-positive triggers).
    try {
      const botRes = await this.client.request<{
        bot?: { open_id?: string };
      }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        data: {},
      });
      this.botOpenId = botRes.bot?.open_id ?? null;
      if (this.botOpenId) {
        logger.info({ botOpenId: this.botOpenId }, 'Lark bot open_id resolved');
      }
    } catch (err) {
      logger.warn(
        { err },
        'Lark: failed to fetch bot open_id, falling back to name-based mention detection',
      );
    }

    // Seed per-group cursors from DB so startup only fetches new messages.
    this.seedLastFetchFromDb();

    logger.info(
      { pollIntervalMs: this.pollIntervalMs },
      'Lark channel connected (poll mode)',
    );
    console.log('\n  Lark bot: connected (poll mode)');
    console.log(
      `  Polling every ${Math.round(this.pollIntervalMs / 60000)} min\n`,
    );

    // Initial backfill on startup, then schedule recurring polls.
    await this.pollAllGroups();
    this.schedulePoll();
  }

  // Reads last_message_time for all lark: chats from the DB and populates
  // lastFetchMs. On restart this prevents re-processing messages the agent
  // already handled in a previous run.
  private seedLastFetchFromDb(): void {
    const chats = getAllChats();
    for (const chat of chats) {
      if (!chat.jid.startsWith('lark:')) continue;
      if (!chat.last_message_time) continue;
      const chatId = chat.jid.replace(/^lark:/, '');
      this.lastFetchMs.set(chatId, new Date(chat.last_message_time).getTime());
    }
    logger.debug(
      { seeded: this.lastFetchMs.size },
      'Lark cursors seeded from DB',
    );
  }

  // Paginates through im.chat.list to get all chats the bot is a member of.
  // Used to discover unregistered chats (chats that receive WIG messages but
  // haven't been registered as a named group).
  private async fetchAllBotChatIds(): Promise<string[]> {
    if (!this.client) return [];
    const chatIds: string[] = [];
    let pageToken: string | undefined;
    try {
      do {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await this.client.im.chat.list({
          params: {
            page_size: 50,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });
        const items: Array<{ chat_id?: string }> = res.data?.items ?? [];
        for (const item of items) {
          if (item.chat_id) chatIds.push(item.chat_id);
        }
        pageToken = res.data?.page_token;
      } while (pageToken);
    } catch (err) {
      logger.warn({ err }, 'Lark: failed to fetch bot chat list');
    }
    logger.debug({ count: chatIds.length }, 'Lark bot chat list refreshed');
    return chatIds;
  }

  // Schedules the next poll using setTimeout rather than setInterval so that
  // a slow poll (network delay, large backfill) never causes overlapping calls.
  private schedulePoll(): void {
    this.pollTimer = setTimeout(async () => {
      if (!this.client) return;
      await this.pollAllGroups().catch((err) =>
        logger.error({ err }, 'Lark poll error'),
      );
      this.schedulePoll();
    }, this.pollIntervalMs);
  }

  // Returns the main registered group, which is used as the owner of WIG
  // signals and the source of wig.json keyword definitions.
  private getMainGroup(): { jid: string; group: RegisteredGroup } | null {
    const groups = this.opts.registeredGroups();
    const entry = Object.entries(groups).find(([, g]) => g.isMain === true);
    return entry ? { jid: entry[0], group: entry[1] } : null;
  }

  // Core poll cycle. Merges registered Lark JIDs with any unregistered chats
  // the bot is a member of, then fetches new messages for all of them in parallel.
  //
  // Unregistered chats are included so WIG signals from workspace chats that
  // haven't been explicitly registered still get captured and surfaced to the
  // main agent's digest.
  private async pollAllGroups(): Promise<void> {
    const groups = this.opts.registeredGroups();
    const registeredLarkJids = Object.keys(groups).filter((j) =>
      j.startsWith('lark:'),
    );
    const main = this.getMainGroup();
    const mainFolder = main?.group.folder ?? '';
    // Load WIG definitions once per poll cycle — passed to scoreWigRelevance
    // inside processItem so the file is only read once regardless of message volume.
    const wigDefs: WigDefinition[] = main
      ? loadWigDefinitions(main.group.folder)
      : [];

    // Refresh bot-accessible chat list every Nth poll
    this.pollCount++;
    if (
      this.allBotChatIds.length === 0 ||
      this.pollCount % this.CHAT_LIST_REFRESH_EVERY === 0
    ) {
      this.allBotChatIds = await this.fetchAllBotChatIds();
    }

    // Merge registered + unregistered chats
    const registeredChatIds = new Set(
      registeredLarkJids.map((j) => j.replace(/^lark:/, '')),
    );
    const unregisteredJids = this.allBotChatIds
      .filter((id) => !registeredChatIds.has(id))
      .map((id) => `lark:${id}`);

    const allJids = [...registeredLarkJids, ...unregisteredJids];
    if (allJids.length === 0) return;

    logger.debug(
      {
        registered: registeredLarkJids.length,
        unregistered: unregisteredJids.length,
      },
      'Lark polling chats',
    );
    await Promise.all(
      allJids.map((jid) => this.fetchGroupMessages(jid, wigDefs, mainFolder)),
    );
  }

  // Extracts the plain-text content from a raw Lark message item.
  // Mirrors the parsing logic in processItem so pre-filtering uses the same text.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getItemTextContent(item: any): string {
    const msgType: string = item.msg_type || '';
    if (msgType !== 'text') {
      const safeType = msgType.replace(/[^\x20-\x7E]/g, '?');
      return NON_TEXT_PLACEHOLDERS[msgType] ?? `[${safeType}]`;
    }
    try {
      return (
        (JSON.parse(item.body?.content || '{}') as { text?: string }).text || ''
      );
    } catch {
      return item.body?.content || '';
    }
  }

  // Returns true if the item's mentions include the bot (by open_id or name).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private itemHasBotMention(item: any): boolean {
    const mentions: Array<{
      id?: { user_id?: string; open_id?: string };
      name?: string;
    }> = item.mentions || [];
    return this.botOpenId
      ? mentions.some((m) => m.id?.open_id === this.botOpenId)
      : mentions.some(
          (m) =>
            !m.id?.user_id &&
            m.name?.toLowerCase() === ASSISTANT_NAME.toLowerCase(),
        );
  }

  // Fetches all new messages for a single chat since the last cursor position,
  // paginating through all pages. Batch-scores WIG relevance for all messages
  // in one Claude call, then routes each message individually.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchGroupMessages(
    chatJid: string,
    wigDefs: WigDefinition[],
    mainFolder: string,
  ): Promise<void> {
    if (!this.client) return;
    const chatId = chatJid.replace(/^lark:/, '');

    // If no prior fetch, look back 24h so we don't miss recent messages.
    const sinceMs =
      this.lastFetchMs.get(chatId) ?? Date.now() - DEFAULT_LOOKBACK_MS;

    // Lark start_time is in seconds (not ms).
    const startTimeSec = Math.floor(sinceMs / 1000);

    let newestMs = sinceMs;
    let pageToken: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allItems: any[] = [];

    // Phase 1: collect all items across pages.
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = err as any;
        logger.error(
          {
            chatJid,
            status: e?.status ?? e?.response?.status,
            larkCode: e?.code ?? e?.response?.data?.code,
            larkMsg: e?.message ?? e?.response?.data?.msg,
            responseData: e?.response?.data,
            errKeys: e ? Object.keys(e) : [],
          },
          'Lark message.list failed',
        );
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
        allItems.push(item);
      }
    } while (pageToken);

    // Always advance cursor to avoid re-fetching the same window.
    this.lastFetchMs.set(chatId, newestMs);

    if (allItems.length === 0) return;

    // Phase 2: pre-filter then batch-score WIG relevance for all items at once.
    // Items where the bot was mentioned are routed unconditionally and skipped here.
    const scorableItems: WigScorerBatchItem[] =
      wigDefs.length > 0
        ? allItems
            .filter(
              (item) =>
                !this.itemHasBotMention(item) &&
                isWigScorable(this.getItemTextContent(item)),
            )
            .map((item) => ({
              key: item.message_id as string,
              content: this.getItemTextContent(item),
            }))
        : [];

    const wigResults: Map<string, WigScorerResult> =
      scorableItems.length > 0
        ? await batchScoreWigRelevance(scorableItems, wigDefs)
        : new Map();

    // Phase 3: route each item with its pre-computed WIG result.
    for (const item of allItems) {
      const wigResult = wigResults.get(item.message_id) ?? {
        summary: '',
        matches: [],
      };
      await this.processItem(item, chatId, chatJid, wigResult, mainFolder);
    }

    logger.info({ chatJid, fetched: allItems.length }, 'Lark messages fetched');
  }

  // Processes a single Lark message item. Decides whether to forward the
  // message to the agent based on three criteria, in order:
  //
  //   1. Bot mention (@Brain): always triggers the agent.
  //   2. WIG-related content: triggers the agent with a [WIG] prefix so the
  //      agent knows the context is a WIG signal, not a direct command.
  //   3. Resolution follow-up: if the message looks like a resolution (e.g.
  //      "done", "shipped") and there is an open WIG signal for this chat,
  //      forward it so the agent can close the signal.
  //
  // Messages that match none of the above are silently dropped — this prevents
  // the agent from being triggered by routine chat noise.
  //
  // For WIG and resolution matches, a wig-signals.json record is upserted so
  // the 4DX scoreboard and daily plan have an accurate picture of WIG activity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processItem(
    item: any,
    chatId: string,
    chatJid: string,
    wigResult: WigScorerResult,
    mainFolder: string,
  ): Promise<void> {
    const senderId: string = item.sender?.id || '';
    const senderName: string = item.sender?.id || senderId || 'Unknown';
    const timestamp = new Date(parseInt(item.create_time || '0')).toISOString();

    // Register the chat in the DB and update its last_message_time so the
    // cursor seeder has accurate data on the next restart.
    const chatName = await this.getChatName(chatId);
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'lark', true);

    const msgType: string = item.msg_type || '';
    let content: string;

    if (msgType !== 'text') {
      // Replace non-text message types with a human-readable placeholder so
      // the agent can acknowledge them without attempting to parse binary data.
      const safeType = msgType.replace(/[^\x20-\x7E]/g, '?');
      content = NON_TEXT_PLACEHOLDERS[msgType] ?? `[${safeType}]`;
    } else {
      try {
        content =
          (JSON.parse(item.body?.content || '{}') as { text?: string }).text ||
          '';
      } catch {
        content = item.body?.content || '';
      }

      // Translate @bot mentions into TRIGGER_PATTERN format.
      // Use the bot's open_id for precise detection. Fall back to name match
      // if open_id wasn't resolved at startup. Avoid the old heuristic of
      // checking !user_id, which falsely matched regular user mentions when
      // Lark omits user_id from the mention object.
      // Someone with Lark user name 'Brain' and has no user_id could be considered as bot
      const mentions: Array<{
        id?: { user_id?: string; open_id?: string };
        name?: string;
      }> = item.mentions || [];
      const hasBotMention = this.botOpenId
        ? mentions.some((m) => m.id?.open_id === this.botOpenId)
        : mentions.some(
            (m) =>
              !m.id?.user_id &&
              m.name?.toLowerCase() === ASSISTANT_NAME.toLowerCase(),
          );

      // If the bot was mentioned but the raw text doesn't already contain
      // the trigger pattern string, prepend it so the router recognises this
      // as a directed message to the agent.
      if (hasBotMention && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // WIG relevance was pre-scored in batch before processItem was called.
      const rawContent = content;
      const { matches: wigMatches } = wigResult;
      const isWig = wigMatches.length > 0;
      const wigIds = wigMatches.map((m) => m.wigId);

      const signalsPath = path.join(
        process.cwd(),
        'groups',
        mainFolder,
        '4dx',
        'wig-signals.json',
      );
      // A resolution is a message that (a) looks like a completion event,
      // (b) is NOT already WIG-tagged (to avoid double-counting), and
      // (c) has an open signal for this chat that it can close.
      const isResolution =
        !isWig &&
        isResolutionContent(content) &&
        hasOpenSignalForKey(chatJid, signalsPath);

      if (!hasBotMention && !isWig && !isResolution) return;

      // Upsert WIG signal for WIG-related messages and resolutions
      if ((isWig || isResolution) && mainFolder) {
        const sourceUrl = this.deepLinkBase
          ? `${this.deepLinkBase}${chatId}`
          : undefined;
        upsertWigSignal({
          channel: 'lark',
          correlationKey: chatJid,
          wigIds: isWig ? wigIds : [],
          sender: senderName,
          snippet: rawContent.slice(0, 200),
          timestamp,
          groupFolder: mainFolder,
          sourceUrl,
        });
      }

      // Prepend trigger for proactive WIG alerts. Include per-WIG IDs in the
      // tag so the agent knows which specific WIGs are involved.
      if (isWig && !hasBotMention) {
        const wigTags = wigIds.map((id) => `[WIG-${id}]`).join(' ');
        content = `@${ASSISTANT_NAME} ${wigTags} ${content}`;
      }
    }

    // Only forward to the agent if this chat maps to a registered group.
    // Unregistered chats are polled for WIG signals (above) but don't trigger
    // a full agent run — there is no CLAUDE.md or group folder to run against.
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
  // Cached indefinitely for the lifetime of the process — chat names rarely
  // change and the cache avoids an API round-trip on every message.
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

  // Sends a text message to a Lark chat. Splits messages longer than
  // MAX_MESSAGE_LENGTH into multiple sequential sends since Lark enforces
  // a per-message character limit.
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

// Self-registers the Lark channel at import time. The registry calls this
// factory when building the channel list at startup. Returns null if Lark
// credentials are not configured, which skips the channel gracefully.
registerChannel('lark', (opts: ChannelOpts) => {
  // Read from .env only — keeps secrets out of process.env so they
  // don't leak to child processes (containers/agents).
  const env = readEnvFile([
    'LARK_APP_ID',
    'LARK_APP_SECRET',
    'LARK_POLL_INTERVAL_MS',
  ]);
  if (!env.LARK_APP_ID || !env.LARK_APP_SECRET) {
    logger.warn('Lark: LARK_APP_ID or LARK_APP_SECRET not set, skipping');
    return null;
  }
  const pollIntervalMs = env.LARK_POLL_INTERVAL_MS
    ? parseInt(env.LARK_POLL_INTERVAL_MS, 10)
    : DEFAULT_POLL_INTERVAL_MS;
  return new LarkChannel(opts, pollIntervalMs);
});
