import { Client, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
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
  private wsClient: WSClient | null = null;
  private opts: LarkChannelOpts;
  // Cache of chatId → display name to avoid repeated im.chat.get() calls
  private chatNameCache = new Map<string, string>();

  constructor(opts: LarkChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Read credentials at connect time — never stored as class fields so
    // they can't leak through heap dumps or accidental serialization.
    const env = readEnvFile(['LARK_APP_ID', 'LARK_APP_SECRET']);
    const appId = env.LARK_APP_ID ?? '';
    const appSecret = env.LARK_APP_SECRET ?? '';

    this.client = new Client({ appId, appSecret });

    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          await this.handleInbound(data);
        } catch (err) {
          logger.error({ err }, 'Error handling Lark inbound message');
        }
      },
    });

    this.wsClient = new WSClient({ appId, appSecret });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    logger.info('Lark bot connected via WebSocket');
    console.log('\n  Lark bot: connected');
    console.log(
      '  Send a message to your bot to get the chat_id for registration\n',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleInbound(data: any): Promise<void> {
    const msg = data.message;
    const chatId: string = msg.chat_id;
    const chatJid = `lark:${chatId}`;
    const senderId: string = data.sender?.sender_id?.open_id || '';
    const senderName: string =
      data.sender?.sender_id?.user_id || senderId || 'Unknown';
    const timestamp = new Date(parseInt(msg.create_time || '0')).toISOString();
    const isGroup = msg.chat_type === 'group';

    // Resolve human-readable chat name — cached after first lookup.
    const chatName = await this.getChatName(chatId);
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'lark', isGroup);

    let content: string;
    if (msg.message_type !== 'text') {
      const messageType: string = msg.message_type || '';
      // Sanitize to printable ASCII to prevent stray control characters in placeholder
      const safeType = messageType.replace(/[^\x20-\x7E]/g, '?');
      content = NON_TEXT_PLACEHOLDERS[messageType] ?? `[${safeType}]`;
    } else {
      try {
        content =
          (JSON.parse(msg.content || '{}') as { text?: string }).text || '';
      } catch {
        content = msg.content || '';
      }

      // Translate @bot mentions into TRIGGER_PATTERN format.
      // In Lark, human user mentions always carry a non-empty user_id; bot/app
      // mentions have no user_id (only open_id). This distinguishes @bot from
      // @colleague so we don't route unrelated @mentions to the agent.
      const mentions: Array<{ id?: { user_id?: string } }> = msg.mentions || [];
      const hasBotMention = mentions.some((m) => !m.id?.user_id);
      if (hasBotMention && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Lark chat');
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msg.message_id || '',
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName }, 'Lark message stored');
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
    return this.wsClient !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('lark:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
    }
    this.client = null;
    logger.info('Lark bot stopped');
  }

  // Lark does not expose a typing indicator API
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {}
}

registerChannel('lark', (opts: ChannelOpts) => {
  // Read from .env only — keeps secrets out of process.env so they
  // don't leak to child processes (containers/agents).
  const env = readEnvFile(['LARK_APP_ID', 'LARK_APP_SECRET']);
  if (!env.LARK_APP_ID || !env.LARK_APP_SECRET) {
    logger.warn('Lark: LARK_APP_ID or LARK_APP_SECRET not set, skipping');
    return null;
  }
  return new LarkChannel(opts);
});
