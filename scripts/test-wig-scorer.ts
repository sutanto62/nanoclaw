/**
 * Quick smoke test for the Claude API-based WIG scorer.
 * Run: npx tsx scripts/test-wig-scorer.ts
 */

import { scoreWigRelevance, loadWigDefinitions } from '../src/wig-scorer.js';

const wigs = loadWigDefinitions('main');
if (wigs.length === 0) {
  console.error('No WIGs found in groups/main/4dx/wig.json — aborting');
  process.exit(1);
}

console.log(`Loaded ${wigs.length} WIGs: ${wigs.map(w => `[${w.id}] ${w.name}`).join(', ')}\n`);

const cases: { label: string; msg: string; expectMatch: boolean }[] = [
  {
    label: 'WIG 1 hit — KebunPRO CST onboarding',
    msg: 'Customer onboarding session for KebunPRO scheduled tomorrow, CST review at 3pm.',
    expectMatch: true,
  },
  {
    label: 'WIG 2 hit — engineer assessment',
    msg: 'Reminder: please submit your product assessment and proposal by Friday. Focus on FFB increment and farmer onboarding.',
    expectMatch: true,
  },
  {
    label: 'WIG 3 hit — Odoo ERP transaction',
    msg: 'Procurement inbound delivery recorded in Odoo today. Bank reconciliation also done.',
    expectMatch: true,
  },
  {
    label: 'WIG 4 hit — PetaniPRO migration',
    msg: 'Double-write for harvesting is 80% done. Migration blocker resolved this morning.',
    expectMatch: true,
  },
  {
    label: 'No match — casual chat',
    msg: 'pak nitip lead weekly tech ya, mau ke warung dulu',
    expectMatch: false,
  },
  {
    label: 'No match — lunch order',
    msg: 'Siapa mau nasi padang? Order sekarang ya sebelum jam 11.',
    expectMatch: false,
  },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  process.stdout.write(`Testing: ${c.label} ... `);
  try {
    const result = await scoreWigRelevance(c.msg, wigs);
    const matched = result.matches.length > 0;
    const ok = matched === c.expectMatch;
    if (ok) {
      console.log(`PASS (matches: [${result.matches.map(m => `WIG-${m.wigId}:${m.score}`).join(', ')}] summary: "${result.summary}")`);
      passed++;
    } else {
      console.log(`FAIL — expected ${c.expectMatch ? 'match' : 'no match'}, got matches: [${result.matches.map(m => `WIG-${m.wigId}:${m.score}`).join(', ')}]`);
      failed++;
    }
  } catch (err) {
    console.log(`ERROR — ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
