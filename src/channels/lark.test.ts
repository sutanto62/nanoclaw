import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Hoisted mock refs ---

const factoryRef = vi.hoisted(() => ({
  fn: null as ((opts: any) => any) | null,
}));

// Stable mock function references — set up before connect() is called.
const mockMessageList = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { items: [], page_token: undefined } }),
);
const mockMessageCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockChatGet = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { name: 'Mock Chat Name' } }),
);
// Default: no WIG matches (Ollama not called in tests).
const mockScoreWigRelevance = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ summary: '', matches: [] }),
);

// --- Module mocks ---

vi.mock('./registry.js', () => ({
  registerChannel: vi.fn((name: string, factory: any) => {
    if (name === 'lark') factoryRef.fn = factory;
  }),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    LARK_APP_ID: 'test-app-id',
    LARK_APP_SECRET: 'test-app-secret',
  })),
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Brain',
  TRIGGER_PATTERN: /^@Brain\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// getAllChats seeds the per-group lastFetchMs cursor on connect.
vi.mock('../db.js', () => ({
  getAllChats: vi.fn(() => []),
}));

vi.mock('../wig-scorer.js', () => ({
  loadWigDefinitions: vi.fn(() => []),
  scoreWigRelevance: mockScoreWigRelevance,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    // Returns the bot's own open_id so hasBotMention uses precise open_id matching.
    request = vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot' } });
    im = {
      message: {
        create: mockMessageCreate,
        list: mockMessageList,
      },
      chat: {
        get: mockChatGet,
      },
    };

    constructor(_opts: any) {}
  },
  Domain: { Lark: 'lark', Feishu: 'feishu' },
}));

import { LarkChannel, LarkChannelOpts } from './lark.js';
import { readEnvFile } from '../env.js';
import { getAllChats } from '../db.js';
import { logger } from '../logger.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<LarkChannelOpts>): LarkChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'lark:oc_abc123': {
        name: 'Test Group',
        folder: 'lark_test-group',
        trigger: '@Brain',
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

// Build a mock im.message.list item (poll mode format).
function makeItem(
  overrides: {
    msgType?: string;
    content?: string;
    senderId?: string;
    senderType?: string;
    messageId?: string;
    createTime?: string;
    mentions?: MentionEntry[];
  } = {},
) {
  const content =
    'content' in overrides
      ? overrides.content
      : JSON.stringify({ text: 'Hello everyone' });
  return {
    message_id: overrides.messageId ?? 'om_msg1',
    create_time: overrides.createTime ?? '1704067200000',
    msg_type: overrides.msgType ?? 'text',
    body: { content },
    sender: {
      id: overrides.senderId ?? 'ou_user1',
      sender_type: overrides.senderType ?? 'user',
    },
    mentions: overrides.mentions ?? [],
  };
}

// Shorthand: a message that mentions the bot (open_id: 'ou_bot').
// With the WIG guard in processItem, only bot-mention or WIG-matched messages
// are forwarded to onMessage. Use this for tests that need delivery but aren't
// testing the filtering logic itself.
function makeBotItem(overrides: Parameters<typeof makeItem>[0] = {}) {
  return makeItem({
    mentions: [{ key: '@_user_bot', id: { open_id: 'ou_bot' }, name: 'Brain' }],
    ...overrides,
  });
}

// Queue items to be returned by the next message.list call, then connect.
async function connectWithItems(
  channel: LarkChannel,
  items: ReturnType<typeof makeItem>[],
) {
  mockMessageList.mockResolvedValueOnce({
    data: { items, page_token: undefined },
  });
  await channel.connect();
}

// --- Tests ---

describe('LarkChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockMessageList.mockResolvedValue({
      data: { items: [], page_token: undefined },
    });
    mockMessageCreate.mockResolvedValue(undefined);
    mockChatGet.mockResolvedValue({ data: { name: 'Mock Chat Name' } });
    vi.mocked(readEnvFile).mockReturnValue({
      LARK_APP_ID: 'test-app-id',
      LARK_APP_SECRET: 'test-app-secret',
    });
    vi.mocked(getAllChats).mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() and marks channel as connected', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('isConnected() returns false before connect', () => {
      expect(new LarkChannel(createTestOpts()).isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('clears poll timer on disconnect', async () => {
      const clearSpy = vi.spyOn(global, 'clearTimeout');
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      await channel.disconnect();
      expect(clearSpy).toHaveBeenCalled();
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
        'LARK_DOMAIN',
      ]);
    });

    it('seeds cursor from DB last_message_time on connect', async () => {
      vi.mocked(getAllChats).mockReturnValue([
        {
          jid: 'lark:oc_abc123',
          name: 'Test',
          last_message_time: '2024-01-01T00:00:00.000Z',
          channel: 'lark',
          is_group: 1,
        },
      ]);
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      expect(vi.mocked(getAllChats)).toHaveBeenCalled();
    });

    it('polls all registered groups on connect', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      expect(mockMessageList).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ container_id: 'oc_abc123' }),
        }),
      );
    });

    it('schedules next poll after connect', async () => {
      const setSpy = vi.spyOn(global, 'setTimeout');
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      expect(setSpy).toHaveBeenCalled();
    });

    it('does not poll if no registered groups', async () => {
      const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
      const channel = new LarkChannel(opts);
      await channel.connect();
      expect(mockMessageList).not.toHaveBeenCalled();
    });
  });

  // --- Message polling ---

  describe('message polling', () => {
    it('delivers message and metadata for registered group', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      // Bot mention is required for processItem to forward to onMessage.
      await connectWithItems(channel, [makeBotItem()]);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.any(String),
        expect.any(String),
        'lark',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({
          id: 'om_msg1',
          chat_jid: 'lark:oc_abc123',
          sender: 'ou_user1',
          // @Brain prepended because content doesn't already match TRIGGER_PATTERN
          content: '@Brain Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('skips bot/app messages (sender_type === "app")', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [makeItem({ senderType: 'app' })]);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles paginated results across multiple pages', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      mockMessageList
        .mockResolvedValueOnce({
          data: {
            items: [makeBotItem({ messageId: 'msg1' })],
            page_token: 'tok_next',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [makeBotItem({ messageId: 'msg2' })],
            page_token: undefined,
          },
        });

      await channel.connect();

      expect(opts.onMessage).toHaveBeenCalledTimes(2);
    });

    it('passes page_token to subsequent pages', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      mockMessageList
        .mockResolvedValueOnce({
          data: { items: [makeItem()], page_token: 'tok_abc' },
        })
        .mockResolvedValueOnce({
          data: { items: [], page_token: undefined },
        });

      await channel.connect();

      expect(mockMessageList).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          params: expect.objectContaining({ page_token: 'tok_abc' }),
        }),
      );
    });

    it('parses JSON body content correctly', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [
        // Use @Brain in text so TRIGGER_PATTERN matches → no prepend → content unchanged.
        makeBotItem({
          content: JSON.stringify({ text: '@Brain parsed text' }),
        }),
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '@Brain parsed text' }),
      );
    });

    it('falls back to raw content when JSON parse fails', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      // Use @Brain prefix so TRIGGER_PATTERN matches → no prepend → raw content unchanged.
      await connectWithItems(channel, [
        makeBotItem({ content: '@Brain not json' }),
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '@Brain not json' }),
      );
    });

    it('uses sender.id as sender', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [makeBotItem({ senderId: 'ou_xyz789' })]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ sender: 'ou_xyz789' }),
      );
    });

    it('converts create_time (ms) to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [
        makeBotItem({ createTime: '1704067200000' }),
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ timestamp: '2024-01-01T00:00:00.000Z' }),
      );
    });

    it('logs fetched count when messages are retrieved', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [makeBotItem()]);

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.objectContaining({ fetched: 1 }),
        'Lark messages fetched',
      );
    });

    it('does not log fetched when no new messages', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect(); // default mock returns []

      expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith(
        expect.anything(),
        'Lark messages fetched',
      );
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('logs error and continues when message.list fails', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      mockMessageList.mockRejectedValueOnce(new Error('API error'));
      await channel.connect();

      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Lark message.list failed',
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Chat name resolution ---

  describe('chat name resolution', () => {
    it('passes resolved chat name to onChatMetadata', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      mockChatGet.mockResolvedValueOnce({ data: { name: 'Engineering Team' } });
      await connectWithItems(channel, [makeItem()]);

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

      mockMessageList.mockResolvedValueOnce({
        data: {
          items: [makeItem(), makeItem({ messageId: 'msg2' })],
          page_token: undefined,
        },
      });
      await channel.connect();

      expect(mockChatGet).toHaveBeenCalledTimes(1);
    });

    it('passes undefined chat name when im.chat.get fails', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      mockChatGet.mockRejectedValueOnce(new Error('API error'));
      await connectWithItems(channel, [makeItem()]);

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
      await connectWithItems(channel, [
        makeItem({
          content: JSON.stringify({ text: '@BrainBot what time is it?' }),
          mentions: [
            { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Brain Bot' },
          ],
        }),
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({
          content: '@Brain @BrainBot what time is it?',
        }),
      );
    });

    it('does NOT prepend trigger for human @mentions (has user_id)', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [
        makeItem({
          content: JSON.stringify({ text: '@Alice check this out' }),
          mentions: [
            {
              key: '@_user_1',
              id: { user_id: 'usr_alice', open_id: 'ou_alice' },
              name: 'Alice',
            },
          ],
        }),
      ]);

      // No bot mention and no WIG match → message is dropped (not forwarded to agent).
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('does not prepend trigger if message already matches TRIGGER_PATTERN', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [
        makeItem({
          content: JSON.stringify({ text: '@Brain what is the time?' }),
          mentions: [
            { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Brain Bot' },
          ],
        }),
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '@Brain what is the time?' }),
      );
    });

    it('does not prepend trigger when mentions array is empty', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [
        makeItem({
          content: JSON.stringify({ text: 'plain message' }),
          mentions: [],
        }),
      ]);

      // No bot mention and no WIG match → message is dropped (not forwarded to agent).
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles mixed mentions: bot + user — only bot triggers prepend', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [
        makeItem({
          content: JSON.stringify({ text: '@Alice @BrainBot help' }),
          mentions: [
            {
              key: '@_user_1',
              id: { user_id: 'usr_alice', open_id: 'ou_alice' },
              name: 'Alice',
            },
            { key: '@_user_2', id: { open_id: 'ou_bot' }, name: 'Brain Bot' },
          ],
        }),
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '@Brain @Alice @BrainBot help' }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it.each([
      ['image', '[Image]'],
      ['audio', '[Audio]'],
      ['video', '[Video]'],
      ['file', '[File]'],
      ['sticker', '[Sticker]'],
    ])('stores %s with placeholder', async (msgType, placeholder) => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [makeItem({ msgType })]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: placeholder }),
      );
    });

    it('stores unknown type with generic placeholder', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [makeItem({ msgType: 'card' })]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '[card]' }),
      );
    });

    it('sanitizes non-ASCII message type in fallback placeholder', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [makeItem({ msgType: 'msg\u0000type' })]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.objectContaining({ content: '[msg?type]' }),
      );
    });

    it('calls onChatMetadata for non-text messages', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await connectWithItems(channel, [makeItem({ msgType: 'image' })]);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'lark:oc_abc123',
        expect.any(String),
        expect.any(String),
        'lark',
        true,
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Lark client API', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      await channel.sendMessage('lark:oc_abc123', 'Hello');

      expect(mockMessageCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_abc123',
          content: JSON.stringify({ text: 'Hello' }),
          msg_type: 'text',
        },
      });
    });

    it('strips lark: prefix from JID', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();

      await channel.sendMessage('lark:oc_xyz999', 'Hi there');

      expect(mockMessageCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ receive_id: 'oc_xyz999' }),
        }),
      );
    });

    it('sends exactly one message under 30000 characters', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();

      await channel.sendMessage('lark:oc_abc123', 'x'.repeat(29999));

      expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    });

    it('splits messages exceeding 30000 characters', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();

      await channel.sendMessage('lark:oc_abc123', 'x'.repeat(35000));

      expect(mockMessageCreate).toHaveBeenCalledTimes(2);
      expect(mockMessageCreate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            content: JSON.stringify({ text: 'x'.repeat(30000) }),
          }),
        }),
      );
      expect(mockMessageCreate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            content: JSON.stringify({ text: 'x'.repeat(5000) }),
          }),
        }),
      );
    });

    it('handles send failure gracefully and stops further chunks', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();

      mockMessageCreate.mockRejectedValueOnce(new Error('API error'));

      await expect(
        channel.sendMessage('lark:oc_abc123', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const channel = new LarkChannel(createTestOpts());
      // Don't connect — client is null
      await channel.sendMessage('lark:oc_abc123', 'No client');
      expect(mockMessageCreate).not.toHaveBeenCalled();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns lark: JIDs', () => {
      expect(new LarkChannel(createTestOpts()).ownsJid('lark:oc_abc123')).toBe(
        true,
      );
    });

    it('does not own Telegram JIDs', () => {
      expect(new LarkChannel(createTestOpts()).ownsJid('tg:123456')).toBe(
        false,
      );
    });

    it('does not own WhatsApp group JIDs', () => {
      expect(new LarkChannel(createTestOpts()).ownsJid('12345@g.us')).toBe(
        false,
      );
    });

    it('does not own Slack JIDs', () => {
      expect(
        new LarkChannel(createTestOpts()).ownsJid('slack:C0123456789'),
      ).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      expect(new LarkChannel(createTestOpts()).ownsJid('random-string')).toBe(
        false,
      );
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('is a no-op (Lark has no typing indicator API)', async () => {
      const channel = new LarkChannel(createTestOpts());
      await channel.connect();
      await expect(
        channel.setTyping('lark:oc_abc123', true),
      ).resolves.toBeUndefined();
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

    it('factory reads LARK_POLL_INTERVAL_MS from env', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        LARK_APP_ID: 'cli_abc',
        LARK_APP_SECRET: 'secret_xyz',
      });
      factoryRef.fn!(createTestOpts());
      expect(vi.mocked(readEnvFile)).toHaveBeenCalledWith([
        'LARK_APP_ID',
        'LARK_APP_SECRET',
        'LARK_POLL_INTERVAL_MS',
      ]);
    });

    it('factory applies custom poll interval from LARK_POLL_INTERVAL_MS', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        LARK_APP_ID: 'cli_abc',
        LARK_APP_SECRET: 'secret_xyz',
        LARK_POLL_INTERVAL_MS: '60000',
      });
      const instance = factoryRef.fn!(createTestOpts());
      expect(instance).toBeInstanceOf(LarkChannel);
    });
  });
});
