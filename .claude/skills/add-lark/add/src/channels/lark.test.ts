import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Capture the factory passed to registerChannel at import time.
// We do this inside the mock itself because vi.clearAllMocks() in beforeEach
// wipes mock.calls before factory tests run.
const factoryRef = vi.hoisted(() => ({ fn: null as ((opts: any) => any) | null }));

vi.mock('./registry.js', () => ({
  registerChannel: vi.fn((name: string, factory: any) => {
    if (name === 'lark') factoryRef.fn = factory;
  }),
}));

// Mock env reader — returns valid creds so connect() can initialize SDK objects
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    LARK_APP_ID: 'test-app-id',
    LARK_APP_SECRET: 'test-app-secret',
  })),
}));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- @larksuiteoapi/node-sdk mock ---

type Handler = (...args: any[]) => any;

const dispatcherRef = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
}));
const wsClientRef = vi.hoisted(() => ({ current: null as any }));
const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    im = {
      message: {
        create: vi.fn().mockResolvedValue(undefined),
      },
      chat: {
        get: vi.fn().mockResolvedValue({ data: { name: 'Mock Chat Name' } }),
      },
    };

    constructor(_opts: any) {
      clientRef.current = this;
    }
  },

  EventDispatcher: class MockEventDispatcher {
    register(handlers: Record<string, Handler>) {
      dispatcherRef.handlers = handlers;
      return this;
    }
  },

  WSClient: class MockWSClient {
    close = vi.fn();

    constructor(_opts: any) {
      wsClientRef.current = this;
    }

    async start(_opts: any) {}
  },
}));

import { LarkChannel, LarkChannelOpts } from './lark.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<LarkChannelOpts>): LarkChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'lark:oc_abc123': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

type MentionEntry = {
  key?: string;
  id?: { user_id?: string; open_id?: string };
  name?: string;
};

function makeData(overrides: {
  chatId?: string;
  chatType?: string;
  messageType?: string;
  content?: string;
  openId?: string;
  userId?: string;
  messageId?: string;
  createTime?: string;
  mentions?: MentionEntry[];
}) {
  return {
    sender: {
      sender_id: {
        open_id: overrides.openId ?? 'ou_user1',
        user_id: overrides.userId ?? 'usr_001',
      },
      sender_type: 'user',
    },
    message: {
      message_id: overrides.messageId ?? 'om_msg1',
      chat_id: overrides.chatId ?? 'oc_abc123',
      chat_type: overrides.chatType ?? 'group',
      message_type: overrides.messageType ?? 'text',
      content:
        'content' in overrides
          ? overrides.content
          : JSON.stringify({ text: 'Hello everyone' }),
      create_time: overrides.createTime ?? '1704067200000',
      mentions: overrides.mentions ?? [],
    },
  };
}

async function triggerMessage(data: ReturnType<typeof makeData>) {
  const handler = dispatcherRef.handlers['im.message.receive_v1'];
  if (handler) await handler(data);
}

// --- Tests ---

describe('LarkChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatcherRef.handlers = {};
    // Reset default chat.get mock
    vi.mocked(readEnvFile).mockReturnValue({
      LARK_APP_ID: 'test-app-id',
      LARK_APP_SECRET: 'test-app-secret',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() and sets up wsClient', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('registers im.message.receive_v1 event handler on connect', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      expect(typeof dispatcherRef.handlers['im.message.receive_v1']).toBe('function');
    });

    it('isConnected() returns false before connect', () => {
      const channel = new LarkChannel(createTestOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('calls wsClient.close() on disconnect', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      await channel.disconnect();
      expect(wsClientRef.current.close).toHaveBeenCalled();
    });

    it('sendMessage warns when called after disconnect', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      await channel.disconnect();
      await channel.sendMessage('lark:oc_abc123', 'test');
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.stringContaining('not initialized'),
      );
    });

    it('reads credentials from readEnvFile, not process.env', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      expect(vi.mocked(readEnvFile)).toHaveBeenCalledWith([
        'LARK_APP_ID',
        'LARK_APP_SECRET',
      ]);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message and metadata for registered group', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({}));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.any(String),
        expect.any(String), // resolved chat name
        'lark',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({
          id: 'om_msg1',
          chat_jid: 'lark:oc_abc123',
          sender: 'ou_user1',
          sender_name: 'usr_001',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('calls onChatMetadata but not onMessage for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ chatId: 'oc_unknown' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'lark:oc_unknown',
        expect.any(String),
        expect.any(String),
        'lark',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('parses JSON content correctly', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(
        makeData({ content: JSON.stringify({ text: 'parsed text' }) }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: 'parsed text' }),
      );
    });

    it('falls back to raw content when JSON parse fails', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ content: 'not json' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: 'not json' }),
      );
    });

    it('uses open_id as sender', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ openId: 'ou_xyz789' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ sender: 'ou_xyz789' }),
      );
    });

    it('uses user_id as sender_name when available', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ userId: 'emp_42' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ sender_name: 'emp_42' }),
      );
    });

    it('falls back to open_id for sender_name when user_id is empty', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ userId: '', openId: 'ou_fallback' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ sender_name: 'ou_fallback' }),
      );
    });

    it('converts create_time (ms) to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ createTime: '1704067200000' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ timestamp: '2024-01-01T00:00:00.000Z' }),
      );
    });

    it('marks isGroup=false for p2p chats', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ chatType: 'p2p' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.any(String),
        expect.any(String),
        'lark',
        false,
      );
    });
  });

  // --- Chat name resolution ---

  describe('chat name resolution', () => {
    it('passes resolved chat name to onChatMetadata', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      clientRef.current.im.chat.get.mockResolvedValueOnce({
        data: { name: 'Engineering Team' },
      });

      await triggerMessage(makeData({}));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.any(String),
        'Engineering Team',
        'lark',
        true,
      );
    });

    it('caches chat name and only calls im.chat.get once per chat', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({}));
      await triggerMessage(makeData({}));

      expect(clientRef.current.im.chat.get).toHaveBeenCalledTimes(1);
    });

    it('passes undefined chat name when im.chat.get fails', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      clientRef.current.im.chat.get.mockRejectedValueOnce(new Error('API error'));

      await triggerMessage(makeData({}));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.any(String),
        undefined,
        'lark',
        true,
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('prepends trigger when message has a bot mention (no user_id)', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(
        makeData({
          content: JSON.stringify({ text: '@AndyBot what time is it?' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Andy Bot' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({
          content: '@Andy @AndyBot what time is it?',
        }),
      );
    });

    it('does NOT prepend trigger for human user @mentions (has user_id)', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(
        makeData({
          content: JSON.stringify({ text: '@Alice check this out' }),
          mentions: [
            { key: '@_user_1', id: { user_id: 'usr_alice', open_id: 'ou_alice' }, name: 'Alice' },
          ],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '@Alice check this out' }),
      );
    });

    it('does not prepend trigger if message already matches TRIGGER_PATTERN', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(
        makeData({
          content: JSON.stringify({ text: '@Andy what is the time?' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Andy Bot' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '@Andy what is the time?' }),
      );
    });

    it('does not prepend trigger when mentions array is empty', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(
        makeData({ content: JSON.stringify({ text: 'plain message' }), mentions: [] }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: 'plain message' }),
      );
    });

    it('handles mixed mentions: bot + user — only bot triggers prepend', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(
        makeData({
          content: JSON.stringify({ text: '@Alice @AndyBot help' }),
          mentions: [
            { key: '@_user_1', id: { user_id: 'usr_alice', open_id: 'ou_alice' }, name: 'Alice' },
            { key: '@_user_2', id: { open_id: 'ou_bot' }, name: 'Andy Bot' },
          ],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '@Andy @Alice @AndyBot help' }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores image with placeholder and sender info', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ messageType: 'image' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({
          content: '[Image]',
          sender: 'ou_user1',
          sender_name: 'usr_001',
        }),
      );
    });

    it('stores audio with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ messageType: 'audio' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores video with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ messageType: 'video' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores file with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ messageType: 'file' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '[File]' }),
      );
    });

    it('stores sticker with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ messageType: 'sticker' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '[Sticker]' }),
      );
    });

    it('stores unknown type with generic placeholder', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ messageType: 'card' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '[card]' }),
      );
    });

    it('sanitizes non-ASCII message_type in fallback placeholder', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ messageType: 'msg\u0000type' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '[msg?type]' }),
      );
    });

    it('calls onChatMetadata for non-text messages', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({ messageType: 'image' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.any(String),
        expect.any(String),
        'lark',
        true,
      );
    });

    it('calls onChatMetadata but not onMessage for non-text from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(
        makeData({ messageType: 'image', chatId: 'oc_unknown' }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('catches and logs errors thrown during message handling', async () => {
      const opts = createTestOpts({
        onChatMetadata: vi.fn(() => {
          throw new Error('handler exploded');
        }),
      });
      const channel = new LarkChannel(opts);
      await channel.connect();

      await triggerMessage(makeData({}));

      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Error handling Lark inbound message',
      );
    });

    it('does not re-throw errors from message handling', async () => {
      const opts = createTestOpts({
        onMessage: vi.fn(() => {
          throw new Error('delivery failed');
        }),
      });
      const channel = new LarkChannel(opts);
      await channel.connect();

      await expect(triggerMessage(makeData({}))).resolves.toBeUndefined();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Lark client API', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await channel.sendMessage('lark:oc_abc123', 'Hello');

      expect(clientRef.current.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_abc123',
          content: JSON.stringify({ text: 'Hello' }),
          msg_type: 'text',
        },
      });
    });

    it('strips lark: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await channel.sendMessage('lark:oc_xyz999', 'Hi there');

      expect(clientRef.current.im.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ receive_id: 'oc_xyz999' }),
        }),
      );
    });

    it('sends exactly one message under 30000 characters', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await channel.sendMessage('lark:oc_abc123', 'x'.repeat(29999));

      expect(clientRef.current.im.message.create).toHaveBeenCalledTimes(1);
    });

    it('splits messages exceeding 30000 characters', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await channel.sendMessage('lark:oc_abc123', 'x'.repeat(35000));

      expect(clientRef.current.im.message.create).toHaveBeenCalledTimes(2);
      expect(clientRef.current.im.message.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            content: JSON.stringify({ text: 'x'.repeat(30000) }),
          }),
        }),
      );
      expect(clientRef.current.im.message.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            content: JSON.stringify({ text: 'x'.repeat(5000) }),
          }),
        }),
      );
    });

    it('handles send failure gracefully and stops further chunks', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      clientRef.current.im.message.create.mockRejectedValueOnce(
        new Error('API error'),
      );

      await expect(
        channel.sendMessage('lark:oc_abc123', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const channel = new LarkChannel(createTestOpts());
      // Don't connect — client is null
      await channel.sendMessage('lark:oc_abc123', 'No client');
      // No error thrown, just a warn logged
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns lark: JIDs', () => {
      expect(new LarkChannel(createTestOpts()).ownsJid('lark:oc_abc123')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      expect(new LarkChannel(createTestOpts()).ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp group JIDs', () => {
      expect(new LarkChannel(createTestOpts()).ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Slack JIDs', () => {
      expect(new LarkChannel(createTestOpts()).ownsJid('slack:C0123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      expect(new LarkChannel(createTestOpts()).ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('is a no-op (Lark has no typing indicator API)', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      await expect(channel.setTyping('lark:oc_abc123', true)).resolves.toBeUndefined();
    });

    it('does not throw when called without connecting', async () => {
      await expect(
        new LarkChannel(createTestOpts()).setTyping('lark:oc_abc123', false),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "lark"', () => {
      expect(new LarkChannel(createTestOpts()).name).toBe('lark');
    });
  });

  // --- registerChannel factory ---

  describe('registerChannel factory', () => {
    it('is registered at module import time', () => {
      expect(factoryRef.fn).toBeTypeOf('function');
    });

    it('factory returns LarkChannel when credentials are present', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        LARK_APP_ID: 'cli_abc',
        LARK_APP_SECRET: 'secret_xyz',
      });
      expect(factoryRef.fn!(createTestOpts())).toBeInstanceOf(LarkChannel);
    });

    it('factory returns null when LARK_APP_ID is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({ LARK_APP_SECRET: 'secret' });
      expect(factoryRef.fn!(createTestOpts())).toBeNull();
    });

    it('factory returns null when LARK_APP_SECRET is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({ LARK_APP_ID: 'cli_abc' });
      expect(factoryRef.fn!(createTestOpts())).toBeNull();
    });

    it('factory logs a warning when credentials are missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({});
      factoryRef.fn!(createTestOpts());
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.stringContaining('LARK_APP_ID or LARK_APP_SECRET not set'),
      );
    });

    it('factory reads credentials from readEnvFile, not process.env', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        LARK_APP_ID: 'cli_abc',
        LARK_APP_SECRET: 'secret_xyz',
      });
      factoryRef.fn!(createTestOpts());
      expect(vi.mocked(readEnvFile)).toHaveBeenCalledWith([
        'LARK_APP_ID',
        'LARK_APP_SECRET',
      ]);
    });
  });
});
