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
  source_url?: string;
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
  sourceUrl?: string;
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
    if (opts.sourceUrl) existing.source_url = opts.sourceUrl;
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
      ...(opts.sourceUrl ? { source_url: opts.sourceUrl } : {}),
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
