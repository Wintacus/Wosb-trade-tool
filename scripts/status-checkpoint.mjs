/**
 * Forces a plain-language status report at regular intervals of spend.
 *
 * The user asked for "a brief description of what you did and what our next
 * steps are" every time another 15% of the token window goes by. That is a
 * reasonable ask and easy to agree to and then quietly forget over a long
 * session — which is exactly what happened to the "verify before reporting"
 * rule, twice, before it became a hook. So this is a hook too.
 *
 *   node scripts/status-checkpoint.mjs           report where the spend stands
 *   node scripts/status-checkpoint.mjs --check   exit 1 if a report is overdue
 *   node scripts/status-checkpoint.mjs --record  mark a report as just given
 *
 * The Stop hook runs --check and refuses to end the turn when a report is
 * overdue. Writing the summary and running --record clears it.
 *
 * It reads the session's own transcript, the same source `npm run tokens`
 * uses, so it measures real usage rather than anything self-reported.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Tokens in one window, and the share that triggers a report.
 *
 * 130M is calibrated from THIS project's own measured sessions, not from a
 * published rate limit — the figure here counts replayed context the same way
 * `npm run tokens` does, and by that measure session 1 cost 146.8M and session
 * 2 cost 111.1M, each running some hours. A naive "15% of the 15M session
 * budget" was tried first and was wrong by two orders of magnitude: it fires
 * every few tool calls, which is noise, not a status report.
 *
 * At 130M a 15% slice is ~19.5M, which works out at roughly six or seven
 * reports across a long working session. Override with STATUS_WINDOW_TOKENS
 * if the real limit ever turns out to be different.
 */
const WINDOW_TOKENS = Number(process.env.STATUS_WINDOW_TOKENS ?? 130_000_000);
const SHARE = 0.15;
const THRESHOLD = Math.round(WINDOW_TOKENS * SHARE);

const STAMP = '.status-checkpoint';

function findTranscripts() {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return [];
  const found = [];
  for (const dir of readdirSync(root)) {
    const full = join(root, dir);
    let entries;
    try {
      entries = statSync(full).isDirectory() ? readdirSync(full) : [];
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(full, name);
      try {
        found.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        /* raced with cleanup */
      }
    }
    if (dir.endsWith('.jsonl')) {
      try {
        found.push({ path: full, mtime: statSync(full).mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** Total tokens billed so far, deduped by message id as the audit does. */
function tokensUsed(path) {
  const seen = new Set();
  let total = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message;
    const id = message?.id;
    const usage = message?.usage;
    // Streaming writes the same message more than once; counting it twice
    // would roughly double the figure and trigger reports far too often.
    if (!usage || !id || seen.has(id)) continue;
    seen.add(id);
    total +=
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);
  }
  return total;
}

const transcripts = findTranscripts();
if (transcripts.length === 0) {
  // No transcript to measure. Never block on this: a missing file is not a
  // reason to stop someone working.
  if (process.argv.includes('--check')) process.exit(0);
  console.log('No transcript found; cannot measure spend.');
  process.exit(0);
}

const used = tokensUsed(transcripts[0].path);
const lastReported = existsSync(STAMP) ? Number(readFileSync(STAMP, 'utf8').trim()) || 0 : 0;
const since = used - lastReported;
const pct = ((since / WINDOW_TOKENS) * 100).toFixed(1);

if (process.argv.includes('--record')) {
  writeFileSync(STAMP, String(used) + '\n');
  console.log(`Status reported at ${used.toLocaleString()} tokens. Next due in ${THRESHOLD.toLocaleString()}.`);
  process.exit(0);
}

if (process.argv.includes('--check')) {
  if (since < THRESHOLD) process.exit(0);
  console.error(`STATUS REPORT DUE: ${pct}% of the window used since the last one.

Give the user a brief, plain-language summary before ending this turn:
  - what you actually did since the last report
  - where that leaves the project
  - what the next step is

Keep it short -- a few lines, not a document. Then run:
  node scripts/status-checkpoint.mjs --record

This is a standing request from the user, not a suggestion. They are working
from a phone and cannot see the terminal scroll back.`);
  process.exit(1);
}

console.log(`Tokens used this session: ${used.toLocaleString()}`);
console.log(`Since the last status report: ${since.toLocaleString()} (${pct}% of a ${WINDOW_TOKENS.toLocaleString()} window)`);
console.log(since >= THRESHOLD ? 'A status report is DUE.' : `Next report due after ${(THRESHOLD - since).toLocaleString()} more.`);
