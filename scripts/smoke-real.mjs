#!/usr/bin/env node
/**
 * smoke-real.mjs — Parse a real Claude Code transcript and report structure.
 * Usage: node scripts/smoke-real.mjs <path/to/transcript.jsonl>
 *
 * Output: JSON with {turns, userPrompts, toolUses, parseErrors, meta, latestContextTokens}
 * For reviewer to validate against real files; NOT part of npm test.
 */

import { parseSession, latestContextTokens } from '../dist/core/transcript.js';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/smoke-real.mjs <path/to/transcript.jsonl>');
  process.exit(1);
}

const transcriptPath = args[0];

try {
  const parsed = await parseSession(transcriptPath);
  const contextTokens = latestContextTokens(parsed);

  const report = {
    turns: parsed.turns.length,
    userPrompts: parsed.userPrompts.length,
    toolUses: parsed.toolUses.length,
    parseErrors: parsed.parseErrors.length,
    meta: parsed.meta,
    latestContextTokens: contextTokens,
  };

  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  console.error('Error parsing transcript:', err instanceof Error ? err.message : err);
  process.exit(1);
}
