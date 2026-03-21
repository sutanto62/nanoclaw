/**
 * wig-scorer.ts — Semantic WIG relevance scoring via Claude CLI
 *
 * Problem this solves:
 *   The old keyword-based matcher (isWigRelated) caused false positives because
 *   short tokens like "lead", "tech", "team" appear in both WIG/lead-measure names
 *   and ordinary conversation. E.g. "pak nitip lead weekly tech ya" triggered @Brain
 *   even though it has nothing to do with a WIG.
 *
 * How it works:
 *   1. loadWigDefinitions() reads groups/{mainFolder}/4dx/wig.json and returns typed
 *      WIG objects (id, name, description, leads).
 *   2. isWigScorable() pre-filters obvious noise (short messages, greetings, pure emoji)
 *      locally at zero cost — ~50-70% of chat messages are skipped before the LLM.
 *   3. batchScoreWigRelevance() scores a batch of messages in a single Claude CLI call,
 *      amortising the WIG definition prompt cost across all messages in a poll cycle.
 *   4. scoreWigRelevance() is a single-item convenience wrapper around the batch scorer.
 *   5. Only scores >= 3 are returned as matches and trigger @Brain [WIG-{id}] prepend.
 *
 * Scoring scale:
 *   1 = unrelated
 *   2 = vague mention
 *   3 = domain related       ← minimum threshold to trigger agent
 *   4 = directly related
 *   5 = explicit WIG activity
 *
 * Session persistence:
 *   A single Claude session is reused across all scoring calls (key: _wig_scorer in
 *   the sessions table). This lets the model accumulate context about what counts as
 *   WIG-relevant in your organisation. Cumulative token usage is tracked via
 *   router_state key "wig_scorer_tokens". When usage reaches CLAUDE_WIG_CONTEXT_THRESHOLD
 *   percent of CLAUDE_WIG_CONTEXT_WINDOW the session and counter are reset so the
 *   next call starts fresh.
 *
 * Config (set in .env, exported from config.ts):
 *   CLAUDE_WIG_MODEL              — default: claude-haiku-4-5-20251001
 *   CLAUDE_WIG_CONTEXT_WINDOW     — default: 200000 (tokens, matches haiku context size)
 *   CLAUDE_WIG_CONTEXT_THRESHOLD  — default: 50  (percent, 0–100)
 *
 * Fallback behaviour:
 *   Any failure (CLI error, timeout, malformed JSON) returns { matches: [] } so
 *   the message is silently dropped. Better to miss a WIG signal occasionally than
 *   to spam the agent with false positives.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CLAUDE_WIG_CONTEXT_THRESHOLD,
  CLAUDE_WIG_CONTEXT_WINDOW,
  CLAUDE_WIG_MODEL,
} from './config.js';
import {
  deleteSession,
  getSession,
  getRouterState,
  setRouterState,
  setSession,
} from './db.js';
import { logger } from './logger.js';

// Reserved sessions-table key for the wig-scorer persistent session.
const WIG_SCORER_SESSION_KEY = '_wig_scorer';
// router_state key tracking cumulative estimated token usage.
const WIG_SCORER_TOKENS_KEY = 'wig_scorer_tokens';

// ---- Tier 1: local pre-filter ----

// Common short acknowledgment and greeting patterns (Indonesian + English).
// Extend this list if your team uses other routine phrases.
const NOISE_PATTERNS = [
  /^(ok|oke|okey|okay|siap|noted|sip|mantap|yep|yup|yes|ya|no|nope|thanks|thank you|makasih|oke boss|oks)\s*[!.?]?$/i,
  /^(good\s*(morning|afternoon|evening|night)|selamat\s*(pagi|siang|sore|malam))\s*[!.?]?$/i,
];

// Returns false for messages that are structurally impossible to be WIG-relevant:
// ultra-short text, pure emoji, non-text placeholders, and common pleasantries.
// This eliminates ~50-70% of routine chat before the LLM is invoked.
export function isWigScorable(content: string): boolean {
  const t = content.trim();
  if (t.length < 8) return false;
  // Non-text Lark/channel placeholders: [Image], [Sticker], etc.
  if (/^\[[\w\s]+\]$/.test(t)) return false;
  // Pure emoji sequences
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(t))
    return false;
  for (const re of NOISE_PATTERNS) {
    if (re.test(t)) return false;
  }
  return true;
}

// WIG definition loaded from wig.json — passed to scoreWigRelevance by callers.
export interface WigDefinition {
  id: number;
  name: string;
  description: string;
  leads: { name: string }[];
}

// A single WIG that scored >= 3 (relevant to the message).
export interface WigMatch {
  wigId: number;
  score: number; // 3 | 4 | 5
}

// Return value of scoreWigRelevance. On timeout/error, matches is empty.
export interface WigScorerResult {
  summary: string;
  matches: WigMatch[];
}

// Reads wig.json and returns typed WIG definitions. Returns [] on missing file
// or parse error so callers can skip the CLI call without throwing.
export function loadWigDefinitions(mainFolder: string): WigDefinition[] {
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
    return (data.wigs || []).map((w: WigDefinition) => ({
      id: w.id,
      name: w.name,
      description: w.description || '',
      leads: (w.leads || []).map((l) => ({ name: l.name })),
    }));
  } catch {
    return [];
  }
}

// ---- Tier 2: batch scoring ----

// Input item for batch scoring. key must be unique within a batch call.
export interface WigScorerBatchItem {
  key: string;
  content: string;
}

// Builds the batch scoring prompt: all messages in a single call, WIG defs sent once.
// Each message is truncated to 300 chars — enough signal without bloating the prompt.
function buildBatchPrompt(
  items: WigScorerBatchItem[],
  wigs: WigDefinition[],
): string {
  const wigList = wigs
    .map((w) => {
      const leads = w.leads.map((l) => l.name).join(', ') || 'none';
      return `${w.id}. ${w.name}: ${w.description}. Leads: ${leads}`;
    })
    .join('\n');

  const msgList = items
    .map((it) => `[${it.key}] "${it.content.slice(0, 300)}"`)
    .join('\n');

  return `You evaluate if chat messages relate to company WIGs (Wildly Important Goals).

WIGs:
${wigList}

Messages:
${msgList}

JSON only, no explanation:
[{"key":"0","summary":"one sentence max","scores":[{"id":1,"score":1},{"id":2,"score":4}]}]

Scoring: 1=unrelated, 2=vague, 3=domain related, 4=directly related, 5=explicit WIG activity`;
}

// Raw JSON shape returned by `claude -p --output-format json`.
interface ClaudeJsonOutput {
  result?: string;
  session_id?: string;
  is_error?: boolean;
}

function spawnClaude(
  prompt: string,
  model: string,
  sessionId: string | undefined,
): Promise<ClaudeJsonOutput> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      prompt,
      '--model',
      model,
      '--output-format',
      'json',
      '--allowedTools',
      '',
    ];
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    proc.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `claude exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim()) as ClaudeJsonOutput);
      } catch {
        reject(
          new Error(`Failed to parse claude JSON output: ${out.slice(0, 200)}`),
        );
      }
    });
  });
}

// Rough token estimate: 1 token ≈ 4 characters.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Reads accumulated token count from router_state. Returns 0 if not set.
function getAccumulatedTokens(): number {
  const raw = getRouterState(WIG_SCORER_TOKENS_KEY);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

// Clears the wig-scorer session and resets the token counter.
function resetSession(): void {
  deleteSession(WIG_SCORER_SESSION_KEY);
  setRouterState(WIG_SCORER_TOKENS_KEY, '0');
  logger.info('WIG scorer: session cleared (context threshold reached)');
}

// Checks whether accumulated tokens have reached the configured threshold.
// If so, resets the session before the next call.
function clearIfOverThreshold(pendingTokens: number): void {
  const accumulated = getAccumulatedTokens() + pendingTokens;
  const maxTokens =
    (CLAUDE_WIG_CONTEXT_THRESHOLD / 100) * CLAUDE_WIG_CONTEXT_WINDOW;
  if (accumulated >= maxTokens) {
    resetSession();
  }
}

// Scores a batch of messages against WIG definitions in a single Claude CLI call.
// Returns a Map from item key → WigScorerResult. Keys absent in the response
// (or on any failure) map to empty results.
export async function batchScoreWigRelevance(
  items: WigScorerBatchItem[],
  wigs: WigDefinition[],
): Promise<Map<string, WigScorerResult>> {
  const emptyMap = new Map<string, WigScorerResult>();
  if (items.length === 0 || wigs.length === 0) return emptyMap;

  const prompt = buildBatchPrompt(items, wigs);

  // Check context threshold before making the call; reset session if needed.
  clearIfOverThreshold(estimateTokens(prompt));

  const sessionId = getSession(WIG_SCORER_SESSION_KEY);

  let parsed: ClaudeJsonOutput;
  try {
    parsed = await Promise.race([
      spawnClaude(prompt, CLAUDE_WIG_MODEL, sessionId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 30000),
      ),
    ]);
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'timeout';
    logger.warn(
      { model: CLAUDE_WIG_MODEL, timeout: isTimeout, count: items.length },
      'WIG batch scorer: CLI request failed or timed out',
    );
    return emptyMap;
  }

  if (parsed.is_error) {
    logger.warn({ parsed }, 'WIG batch scorer: CLI returned is_error=true');
    return emptyMap;
  }

  // Persist the session ID for the next call.
  if (parsed.session_id) {
    setSession(WIG_SCORER_SESSION_KEY, parsed.session_id);
  }

  // Accumulate token usage estimate (prompt + response).
  const responseText = parsed.result ?? '';
  const usedTokens = estimateTokens(prompt) + estimateTokens(responseText);
  setRouterState(
    WIG_SCORER_TOKENS_KEY,
    String(getAccumulatedTokens() + usedTokens),
  );

  const cleaned = responseText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let batchResult: Array<{
    key: string;
    summary?: string;
    scores?: { id: number; score: number }[];
  }>;
  try {
    batchResult = JSON.parse(cleaned);
    if (!Array.isArray(batchResult)) throw new Error('not an array');
  } catch {
    logger.warn(
      { raw: cleaned.slice(0, 200) },
      'WIG batch scorer: malformed JSON response',
    );
    return emptyMap;
  }

  const resultMap = new Map<string, WigScorerResult>();
  let matchCount = 0;
  for (const entry of batchResult) {
    const key = String(entry.key);
    const scores = Array.isArray(entry.scores) ? entry.scores : [];
    const matches: WigMatch[] = scores
      .filter(
        (s) =>
          typeof s.id === 'number' &&
          typeof s.score === 'number' &&
          s.score >= 3,
      )
      .map((s) => ({ wigId: s.id, score: s.score }));
    resultMap.set(key, { summary: entry.summary ?? '', matches });
    if (matches.length > 0) matchCount++;
  }

  if (matchCount > 0) {
    logger.debug(
      { matchCount, total: items.length },
      'WIG batch scorer: matches found',
    );
  }

  return resultMap;
}

// Convenience wrapper for single-message callers.
export async function scoreWigRelevance(
  content: string,
  wigs: WigDefinition[],
): Promise<WigScorerResult> {
  const results = await batchScoreWigRelevance([{ key: '0', content }], wigs);
  return results.get('0') ?? { summary: '', matches: [] };
}
