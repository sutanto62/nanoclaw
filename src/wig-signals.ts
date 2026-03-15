import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const RESOLUTION_KEYWORDS = [
  'resolved',
  'approved',
  'fixed',
  'unblocked',
  'done',
  'closed',
  'signed',
  'cleared',
  'confirmed',
  'granted',
  'merged',
  'deployed',
  'shipped',
  'released',
  'sorted',
  'addressed',
];

const SIGNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface WigSignal {
  id: string;
  first_ts: string;
  updated_ts: string;
  channel: string;
  correlation_key: string;
  sender: string;
  wig_ids: number[];
  status: 'open' | 'resolved';
  snippet: string;
  resolution_snippet: string | null;
}

interface WigSignalsFile {
  generated: string;
  signals: WigSignal[];
}

export interface UpsertOpts {
  channel: string;
  correlationKey: string;
  wigIds: number[];
  sender: string;
  snippet: string;
  timestamp: string;
  groupFolder: string;
}

function getSignalsPath(groupFolder: string): string {
  return path.join(
    process.cwd(),
    'groups',
    groupFolder,
    '4dx',
    'wig-signals.json',
  );
}

function loadSignalsFile(signalsPath: string): WigSignalsFile {
  if (!fs.existsSync(signalsPath))
    return { generated: new Date().toISOString(), signals: [] };
  try {
    return JSON.parse(fs.readFileSync(signalsPath, 'utf-8')) as WigSignalsFile;
  } catch {
    return { generated: new Date().toISOString(), signals: [] };
  }
}

export function isResolutionContent(text: string): boolean {
  const lower = text.toLowerCase();
  return RESOLUTION_KEYWORDS.some((k) => lower.includes(k));
}

export function hasOpenSignalForKey(
  correlationKey: string,
  signalsPath: string,
): boolean {
  if (!fs.existsSync(signalsPath)) return false;
  try {
    const data = JSON.parse(
      fs.readFileSync(signalsPath, 'utf-8'),
    ) as WigSignalsFile;
    return data.signals.some(
      (s) => s.correlation_key === correlationKey && s.status === 'open',
    );
  } catch {
    return false;
  }
}

const STOPWORDS = new Set([
  'and',
  'the',
  'for',
  'from',
  'with',
  'this',
  'that',
  'have',
  'been',
  'will',
  'when',
  'date',
  'grow',
  'into',
  'over',
  'live',
  'goal',
  'plan',
  'per',
  'day',
  'week',
  'mid',
  'top',
  'held',
  'done',
  'sent',
  'session',
  'count',
  'score',
  'point',
  'points',
  'resolved',
  'shipped',
  'reviewed',
  'completed',
  'triaged',
  'moment',
  'increase',
  'improve',
  'deliver',
]);

function tokenize(str: string): string[] {
  return str
    .toLowerCase()
    .split(/[\s\-\/—≥≤@#.,:;!?()[\]{}'"]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

export function loadWigKeywordMap(
  mainFolder: string,
): { id: number; name: string; tokens: string[] }[] {
  const wigPath = path.join(
    process.cwd(),
    'groups',
    mainFolder,
    '4dx',
    'wig.json',
  );
  if (!fs.existsSync(wigPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(wigPath, 'utf-8'));
    return (data.wigs || []).map(
      (wig: { id: number; name: string; leads?: { name: string }[] }) => {
        const tokens = new Set<string>();
        for (const token of tokenize(wig.name)) tokens.add(token);
        for (const lead of wig.leads || []) {
          for (const token of tokenize(lead.name)) tokens.add(token);
        }
        return { id: wig.id, name: wig.name, tokens: Array.from(tokens) };
      },
    );
  } catch {
    return [];
  }
}

export function tagWigIds(
  text: string,
  wigKeywordMap: { id: number; name: string; tokens: string[] }[],
): number[] {
  const lower = text.toLowerCase();
  return wigKeywordMap
    .filter((wig) => wig.tokens.some((token) => lower.includes(token)))
    .map((wig) => wig.id);
}

export function upsertWigSignal(opts: UpsertOpts): void {
  const signalsPath = getSignalsPath(opts.groupFolder);

  const dir = path.dirname(signalsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const data = loadSignalsFile(signalsPath);
  const now = new Date().toISOString();
  const existing = data.signals.find(
    (s) => s.correlation_key === opts.correlationKey,
  );

  if (existing) {
    if (isResolutionContent(opts.snippet)) {
      existing.status = 'resolved';
      existing.resolution_snippet = opts.snippet;
      existing.updated_ts = now;
      logger.info(
        { correlationKey: opts.correlationKey },
        'WIG signal resolved',
      );
    } else {
      existing.snippet = opts.snippet;
      existing.updated_ts = now;
    }
  } else {
    data.signals.push({
      id: `${opts.channel}:${opts.correlationKey}:${Date.now()}`,
      first_ts: opts.timestamp,
      updated_ts: now,
      channel: opts.channel,
      correlation_key: opts.correlationKey,
      sender: opts.sender,
      wig_ids: opts.wigIds,
      status: 'open',
      snippet: opts.snippet,
      resolution_snippet: null,
    });
    logger.info(
      { correlationKey: opts.correlationKey, wigIds: opts.wigIds },
      'WIG signal created',
    );
  }

  // Prune resolved signals older than 7 days
  const cutoff = Date.now() - SIGNAL_TTL_MS;
  data.signals = data.signals.filter(
    (s) =>
      s.status !== 'resolved' || new Date(s.updated_ts).getTime() >= cutoff,
  );

  data.generated = now;

  // Atomic write
  const tmpPath = `${signalsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, signalsPath);
}
