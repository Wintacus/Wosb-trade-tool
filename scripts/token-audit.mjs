/**
 * What this session cost, and whether the token rules are actually working.
 *
 * Run it near the end of a session:  npm run tokens
 *
 * It reads the session's OWN transcript, which Claude Code writes incrementally
 * under ~/.claude/projects/, so it reports on the conversation that is running
 * right now. Nothing is sent anywhere; it is a local read.
 *
 * Why this exists
 * ---------------
 * The first session of this project spent 146.8 million tokens, and 95.6% of
 * that was re-reading conversation already sent. The API keeps no memory, so
 * every tool call re-transmits the whole conversation: cost is requests times
 * context size, and both grow all session.
 *
 * The single largest lever is batching independent tool calls into one request,
 * because each round trip avoided is one entire context replay saved. The first
 * session batched 2.0% of its calls -- and it had a standing instruction to
 * batch the whole time. A written rule demonstrably did not fix it.
 *
 * So this script exists to check rather than trust. If the batching rate is
 * still in single digits, the rule is not working and needs a different fix,
 * not another restatement of itself.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The first session, measured at its end on 2026-08-23. Everything is compared
 * against this. Do not edit these numbers: a moving baseline measures nothing.
 */
const BASELINE = {
  label: 'Session 1 (2026-08-23)',
  requests: 390,
  input: 780,
  cacheWrite: 6_037_611,
  cacheRead: 140_323_104,
  output: 474_877,
  batchedPct: 2.0,
  medianContext: 349_208,
  peakContext: 773_678,
};

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
        /* raced with cleanup; skip */
      }
    }
    // Some layouts put the .jsonl beside the directory rather than inside it.
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

function analyse(path) {
  const seen = new Set();
  const toolsPerMessage = new Map();
  let input = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let output = 0;
  const contexts = [];

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== 'assistant') continue;
    const message = row.message ?? {};
    const id = message.id;

    // Tool calls are counted per assistant message, because that is what a
    // batch IS: several tool_use blocks emitted in one response.
    for (const block of message.content ?? []) {
      if (block && block.type === 'tool_use') {
        toolsPerMessage.set(id, (toolsPerMessage.get(id) ?? 0) + 1);
      }
    }

    // Usage is deduped by message id: streaming writes the same message more
    // than once, and counting it twice would double the whole report.
    const usage = message.usage;
    if (!usage || seen.has(id)) continue;
    seen.add(id);
    const inTok = usage.input_tokens ?? 0;
    const cw = usage.cache_creation_input_tokens ?? 0;
    const cr = usage.cache_read_input_tokens ?? 0;
    input += inTok;
    cacheWrite += cw;
    cacheRead += cr;
    output += usage.output_tokens ?? 0;
    contexts.push(inTok + cw + cr);
  }

  const calls = [...toolsPerMessage.values()];
  const totalCalls = calls.reduce((sum, n) => sum + n, 0);
  const rode = calls.reduce((sum, n) => sum + (n > 1 ? n - 1 : 0), 0);
  const sorted = [...contexts].sort((a, b) => a - b);

  return {
    requests: seen.size,
    input,
    cacheWrite,
    cacheRead,
    output,
    total: input + cacheWrite + cacheRead + output,
    totalCalls,
    toolRequests: calls.length,
    batchedPct: totalCalls > 0 ? (rode / totalCalls) * 100 : 0,
    medianContext: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    peakContext: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

const n = (value) => value.toLocaleString('en-US');
const m = (value) => `${(value / 1e6).toFixed(1)}M`;

function delta(now, before, { lowerIsBetter = true } = {}) {
  if (!before) return '';
  const change = ((now - before) / before) * 100;
  const better = lowerIsBetter ? change < 0 : change > 0;
  const arrow = Math.abs(change) < 1 ? '  same' : better ? '  BETTER' : '  worse';
  return `${change >= 0 ? '+' : ''}${change.toFixed(0)}%${arrow}`;
}

const transcripts = findTranscripts();
if (transcripts.length === 0) {
  console.log('No transcript found under ~/.claude/projects/.');
  console.log('This only works inside a Claude Code session that has written one.');
  process.exit(0);
}

const [{ path }] = transcripts;
const s = analyse(path);

if (s.requests === 0) {
  console.log(`Found ${path} but it records no model requests yet.`);
  process.exit(0);
}

const replayShare = s.total > 0 ? (s.cacheRead / s.total) * 100 : 0;

console.log(`\n  THIS SESSION vs ${BASELINE.label}`);
console.log(`  ${'-'.repeat(62)}`);
console.log(`  requests            ${String(n(s.requests)).padEnd(14)} was ${String(n(BASELINE.requests)).padEnd(12)} ${delta(s.requests, BASELINE.requests)}`);
console.log(`  total tokens        ${m(s.total).padEnd(14)} was ${m(
  BASELINE.input + BASELINE.cacheWrite + BASELINE.cacheRead + BASELINE.output,
).padEnd(12)} ${delta(s.total, BASELINE.input + BASELINE.cacheWrite + BASELINE.cacheRead + BASELINE.output)}`);
console.log(`  context replayed    ${m(s.cacheRead).padEnd(14)} was ${m(BASELINE.cacheRead).padEnd(12)} ${delta(s.cacheRead, BASELINE.cacheRead)}`);
console.log(`  my output           ${n(s.output).padEnd(14)} was ${n(BASELINE.output).padEnd(12)} ${delta(s.output, BASELINE.output)}`);
console.log(`  median context      ${n(s.medianContext).padEnd(14)} was ${n(BASELINE.medianContext).padEnd(12)} ${delta(s.medianContext, BASELINE.medianContext)}`);
console.log(`  peak context        ${n(s.peakContext).padEnd(14)} was ${n(BASELINE.peakContext).padEnd(12)} ${delta(s.peakContext, BASELINE.peakContext)}`);
console.log(`  ${'-'.repeat(62)}`);
console.log(
  `  BATCHING RATE       ${(s.batchedPct.toFixed(1) + '%').padEnd(14)} was ${(BASELINE.batchedPct.toFixed(1) + '%').padEnd(12)} ${delta(
    s.batchedPct,
    BASELINE.batchedPct,
    { lowerIsBetter: false },
  )}`,
);
console.log(`  ${'-'.repeat(62)}`);
console.log(`  ${n(s.totalCalls)} tool calls across ${n(s.toolRequests)} requests.`);
console.log(`  ${replayShare.toFixed(1)}% of this session's tokens were replayed context.\n`);

// The verdict, stated plainly rather than left to be inferred from a table.
if (s.batchedPct < 10) {
  console.log('  VERDICT: batching is still failing. Every serial call that could have');
  console.log('  ridden with another cost a full context replay -- roughly the median');
  console.log(`  above, ${n(s.medianContext)} tokens, each time. Writing the rule down did not`);
  console.log('  work in session 1 either. Try a different fix: fewer, larger shell');
  console.log('  commands instead of many small ones.\n');
} else if (s.batchedPct < 25) {
  console.log('  VERDICT: batching improved but is not yet habit. Keep pushing.\n');
} else {
  console.log('  VERDICT: batching is working. Record the rate in PROGRESS.md.\n');
}

console.log(`  transcript: ${path}`);
console.log('  Record the headline numbers in PROGRESS.md before the session ends.\n');
