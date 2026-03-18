import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { DIGEST_INTERVAL_MS, DIGEST_LOOKBACK_HOURS } from '../config.js';
import { hasOpenSignalForKey, upsertWigSignal } from '../wig-signals.js';
import {
  loadWigDefinitions,
  scoreWigRelevance,
  WigDefinition,
} from '../wig-scorer.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string; // RFC 2822 Message-ID for In-Reply-To
}

const URGENT_KEYWORDS = [
  'urgent',
  'asap',
  'critical',
  'deadline',
  'blocker',
  'blocked',
  'action required',
  'immediate',
  'emergency',
  'escalation',
];

function isUrgentSubject(subject: string): boolean {
  const lower = subject.toLowerCase();
  return URGENT_KEYWORDS.some((k) => lower.includes(k));
}

function loadVipNames(mainFolder: string): string[] {
  const vipPath = path.join(process.cwd(), 'groups', mainFolder, 'vips.md');
  if (!fs.existsSync(vipPath)) return [];
  try {
    return fs
      .readFileSync(vipPath, 'utf-8')
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => {
        const match = l.replace(/^- /, '').match(/^(.+?)(\s*[—\-]|$)/);
        return match ? match[1].trim() : '';
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isVipSender(senderName: string, vipNames: string[]): boolean {
  const lower = senderName.toLowerCase();
  return vipNames.some((v) => lower.includes(v.toLowerCase()));
}

export class GmailChannel implements Channel {
  name = 'gmail';

  private oauth2Client: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private opts: GmailChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private threadMeta = new Map<string, ThreadMeta>();
  private threadMetaPath: string;
  private consecutiveErrors = 0;
  private userEmail = '';

  constructor(opts: GmailChannelOpts, pollIntervalMs = 3600000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
    this.threadMetaPath = path.join(
      os.homedir(),
      '.gmail-mcp',
      'thread-meta.json',
    );
  }

  async connect(): Promise<void> {
    const credDir = path.join(os.homedir(), '.gmail-mcp');
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        'Gmail credentials not found in ~/.gmail-mcp/. Skipping Gmail channel. Run /add-gmail to set up.',
      );
      return;
    }

    this.loadThreadMeta();

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    this.oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    this.oauth2Client.setCredentials(tokens);

    this.oauth2Client.on('tokens', (newTokens) => {
      try {
        const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        Object.assign(current, newTokens);
        fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
        logger.debug('Gmail OAuth tokens refreshed');
      } catch (err) {
        logger.warn({ err }, 'Failed to persist refreshed Gmail tokens');
      }
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress || '';
    logger.info({ email: this.userEmail }, 'Gmail channel connected');

    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              30 * 60 * 1000,
            )
          : this.pollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) => logger.error({ err }, 'Gmail poll error'))
          .finally(() => {
            if (this.gmail) schedulePoll();
          });
      }, backoffMs);
    };

    await this.pollForMessages();
    schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.gmail) {
      logger.warn('Gmail not initialized');
      return;
    }

    const threadId = jid.replace(/^gmail:/, '');
    const meta = this.threadMeta.get(threadId);

    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for reply, cannot send');
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    const headers = [
      `To: ${meta.sender}`,
      `From: ${this.userEmail}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${meta.messageId}`,
      `References: ${meta.messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ].join('\r\n');

    const encodedMessage = Buffer.from(headers)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage, threadId },
      });
      logger.info({ to: meta.sender, threadId }, 'Gmail reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Gmail reply');
    }
  }

  isConnected(): boolean {
    return this.gmail !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.gmail = null;
    this.oauth2Client = null;
    logger.info('Gmail channel stopped');
  }

  // --- Private ---

  private loadThreadMeta(): void {
    if (!fs.existsSync(this.threadMetaPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.threadMetaPath, 'utf-8'));
      for (const [threadId, meta] of Object.entries(data)) {
        this.threadMeta.set(threadId, meta as ThreadMeta);
      }
      logger.debug(
        { count: this.threadMeta.size },
        'Thread metadata loaded from disk',
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to load thread metadata from disk');
    }
  }

  private saveThreadMeta(): void {
    try {
      const data = Object.fromEntries(this.threadMeta.entries());
      fs.writeFileSync(this.threadMetaPath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.warn({ err }, 'Failed to save thread metadata to disk');
    }
  }

  private getMainGroup(): { jid: string; group: RegisteredGroup } | null {
    const groups = this.opts.registeredGroups();
    const entry = Object.entries(groups).find(([, g]) => g.isMain === true);
    return entry ? { jid: entry[0], group: entry[1] } : null;
  }

  private async pollForMessages(): Promise<void> {
    if (!this.gmail) return;

    const main = this.getMainGroup();
    const vipNames = main ? loadVipNames(main.group.folder) : [];
    const wigDefs: WigDefinition[] = main
      ? loadWigDefinitions(main.group.folder)
      : [];

    try {
      const afterEpoch = Math.floor(
        (Date.now() - DIGEST_LOOKBACK_HOURS * 3600000) / 1000,
      );
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: `is:unread category:primary after:${afterEpoch}`,
        maxResults: 20,
      });

      const messages = res.data.messages || [];
      let metaChanged = false;

      for (const stub of messages) {
        if (!stub.id) continue;
        try {
          const changed = await this.processEmailMetadata(
            stub.id,
            vipNames,
            wigDefs,
            main,
          );
          if (changed) metaChanged = true;
        } catch (err) {
          logger.warn(
            { messageId: stub.id, err },
            'Failed to process email, skipping',
          );
        }
      }

      if (metaChanged) this.saveThreadMeta();
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      logger.error(
        { err, consecutiveErrors: this.consecutiveErrors },
        'Gmail poll failed',
      );
    }
  }

  /**
   * Fetch metadata only first (fast). Cache threadMeta for all emails.
   * Fetch full body and deliver to Brain only for VIP or urgent emails.
   * Mark all others as read silently — MCP handles them during briefing.
   * Returns true if threadMeta was updated.
   */
  private async processEmailMetadata(
    messageId: string,
    vipNames: string[],
    wigDefs: WigDefinition[],
    main: { jid: string; group: RegisteredGroup } | null,
  ): Promise<boolean> {
    if (!this.gmail) return false;

    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Message-ID'],
    });

    const headers = msg.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';

    const from = getHeader('From');
    const subject = getHeader('Subject');
    const rfc2822MessageId = getHeader('Message-ID');
    const threadId = msg.data.threadId || messageId;
    const timestamp = new Date(
      parseInt(msg.data.internalDate || '0', 10),
    ).toISOString();

    const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
    const senderName = senderMatch ? senderMatch[1].replace(/"/g, '') : from;
    const senderEmail = senderMatch ? senderMatch[2] : from;
    const snippet = msg.data.snippet || '';

    if (senderEmail === this.userEmail) return false;

    // Always cache threadMeta — needed for replies regardless of urgency
    this.threadMeta.set(threadId, {
      sender: senderEmail,
      senderName,
      subject,
      messageId: rfc2822MessageId,
    });

    this.opts.onChatMetadata(
      `gmail:${threadId}`,
      timestamp,
      subject,
      'gmail',
      false,
    );

    // Semantic WIG scoring against email subject + snippet. The full body is
    // not fetched at this stage (metadata-only pass), so subject+snippet is
    // the best available signal for relevance scoring.
    const combinedText = `${subject} ${snippet}`;
    const { matches: wigMatches } =
      wigDefs.length > 0
        ? await scoreWigRelevance(combinedText, wigDefs)
        : { matches: [] };
    const wigRelated = wigMatches.length > 0;
    const wigIds = wigMatches.map((m) => m.wigId);

    const urgent =
      isVipSender(senderName, vipNames) ||
      isUrgentSubject(subject) ||
      wigRelated;

    // Upsert WIG signal for WIG-related emails and resolution follow-ups
    if (main) {
      const correlationKey = `gmail:${threadId}`;
      const signalsPath = path.join(
        'groups',
        main.group.folder,
        '4dx',
        'wig-signals.json',
      );
      const hasOpen = hasOpenSignalForKey(correlationKey, signalsPath);

      if (wigRelated || hasOpen) {
        upsertWigSignal({
          channel: 'gmail',
          correlationKey,
          wigIds: wigRelated ? wigIds : [],
          sender: senderName,
          snippet: `${subject}: ${snippet}`.slice(0, 200),
          timestamp,
          groupFolder: main.group.folder,
        });
      }
    }

    if (urgent && main) {
      await this.deliverEmailToBrain(
        messageId,
        threadId,
        senderName,
        senderEmail,
        subject,
        timestamp,
        main.jid,
      );
    } else {
      // Mark read silently — Brain will see it during the next briefing via MCP
      await this.markRead(messageId);
      logger.debug(
        { from: senderName, subject },
        'Non-urgent email cached and marked read',
      );
    }

    return true;
  }

  private async deliverEmailToBrain(
    messageId: string,
    threadId: string,
    senderName: string,
    senderEmail: string,
    subject: string,
    timestamp: string,
    mainJid: string,
  ): Promise<void> {
    if (!this.gmail) return;

    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const body = this.extractTextBody(msg.data.payload);
    if (!body) {
      logger.debug(
        { messageId, subject },
        'Urgent email has no text body, skipping delivery',
      );
      await this.markRead(messageId);
      return;
    }

    const content = `[Email from ${senderName} <${senderEmail}>]\nSubject: ${subject}\n\n${body}`;

    this.opts.onMessage(mainJid, {
      id: messageId,
      chat_jid: mainJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    await this.markRead(messageId);
    logger.info(
      { from: senderName, subject },
      'Urgent/VIP email delivered to Brain',
    );
  }

  private async markRead(messageId: string): Promise<void> {
    if (!this.gmail) return;
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to mark email as read');
    }
  }

  private extractTextBody(
    payload: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!payload) return '';
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      for (const part of payload.parts) {
        const text = this.extractTextBody(part);
        if (text) return text;
      }
    }
    return '';
  }
}

registerChannel('gmail', (opts: ChannelOpts) => {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  if (
    !fs.existsSync(path.join(credDir, 'gcp-oauth.keys.json')) ||
    !fs.existsSync(path.join(credDir, 'credentials.json'))
  ) {
    logger.warn('Gmail: credentials not found in ~/.gmail-mcp/');
    return null;
  }
  return new GmailChannel(opts, DIGEST_INTERVAL_MS);
});
