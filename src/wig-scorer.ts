/**
 * wig-scorer.ts — Semantic WIG relevance scoring via Claude API
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
 *   2. scoreWigRelevance() sends a structured prompt to Claude API (haiku model) asking
 *      it to score the message 1–5 against each WIG definition.
 *   3. Only scores >= 3 are returned as matches and trigger @Brain [WIG-{id}] prepend.
 *
 * Scoring scale:
 *   1 = unrelated
 *   2 = vague mention
 *   3 = domain related       ← minimum threshold to trigger agent
 *   4 = directly related
 *   5 = explicit WIG activity
 *
 * Claude API config (read from .env at call time):
 *   CLAUDE_CODE_OAUTH_TOKEN  — preferred API key (checked first)
 *   ANTHROPIC_API_KEY        — fallback API key
 *   CLAUDE_WIG_MODEL   — default: claude-haiku-4-5-20251001
 *
 * Fallback behaviour:
 *   Any failure (API error, timeout, malformed JSON) returns { matches: [] } so
 *   the message is silently dropped. Better to miss a WIG signal occasionally than
 *   to spam the agent with false positives.
 */

import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

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
// or parse error so callers can skip the API call without throwing.
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

// Builds the scoring prompt. WIG list is formatted as a numbered list with
// description and lead measure names. Message is truncated to 500 chars to
// keep the prompt compact — long messages don't add scoring value beyond context.
function buildPrompt(content: string, wigs: WigDefinition[]): string {
  const wigList = wigs
    .map((w) => {
      const leads = w.leads.map((l) => l.name).join(', ') || 'none';
      return `${w.id}. ${w.name}: ${w.description}. Leads: ${leads}`;
    })
    .join('\n');

  const truncated = content.slice(0, 500);

  return `You evaluate if a chat message relates to company WIGs (Wildly Important Goals).

WIGs:
${wigList}

Message: "${truncated}"

JSON only, no explanation:
{"summary":"one sentence max","scores":[{"id":1,"score":1},{"id":2,"score":4}]}

Scoring: 1=unrelated, 2=vague, 3=domain related, 4=directly related, 5=explicit WIG activity`;
}

// Calls Claude API to semantically score a message against WIG definitions.
// Returns only matches with score >= 3. Empty matches on any failure.
export async function scoreWigRelevance(
  content: string,
  wigs: WigDefinition[],
): Promise<WigScorerResult> {
  const empty: WigScorerResult = { summary: '', matches: [] };

  // Skip API call entirely if no WIGs are defined.
  if (wigs.length === 0) return empty;

  const env = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'CLAUDE_WIG_MODEL',
  ]);
  const apiKey = env.CLAUDE_CODE_OAUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn(
      'WIG scorer: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY not set, skipping',
    );
    return empty;
  }
  const model = env.CLAUDE_WIG_MODEL ?? 'claude-haiku-4-5-20251001';
  const prompt = buildPrompt(content, wigs);

  let raw: string;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      logger.warn(
        { status: res.status, model },
        'WIG scorer: Claude API HTTP error',
      );
      return empty;
    }

    const json = (await res.json()) as {
      content?: { type: string; text: string }[];
    };
    raw = json.content?.find((c) => c.type === 'text')?.text ?? '';
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    logger.warn(
      { model, timeout: isTimeout },
      'WIG scorer: Claude API request failed or timed out, dropping message',
    );
    return empty;
  }

  // Strip markdown code fences if the model wraps output in them.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed: { summary?: string; scores?: { id: number; score: number }[] };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    logger.warn(
      { raw: raw.slice(0, 200) },
      'WIG scorer: malformed JSON response, dropping message',
    );
    return empty;
  }

  const summary = parsed.summary ?? '';
  const scores = Array.isArray(parsed.scores) ? parsed.scores : [];

  // Filter to scores >= 3 (domain related or better). Scores 1–2 are noise.
  const matches: WigMatch[] = scores
    .filter(
      (s) =>
        typeof s.id === 'number' && typeof s.score === 'number' && s.score >= 3,
    )
    .map((s) => ({ wigId: s.id, score: s.score }));

  if (matches.length > 0) {
    logger.debug({ matches, summary }, 'WIG scorer: matches found');
  }

  return { summary, matches };
}
