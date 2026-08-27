/**
 * How accurately are real screenshots actually read?
 *
 * Everything else in this project answers a yes/no question. This one does
 * not: reading a screenshot is either right, nearly right, or wrong, and the
 * only way to know which is to compare it against what a person can see with
 * their own eyes. So this reports numbers, and a threshold turns them into a
 * pass or a fail.
 *
 *   npm run ocr:accuracy
 *
 * It needs ANTHROPIC_API_KEY in the environment and at least one image in
 * fixtures/ocr/ with a matching .expected.json (see the README there). With
 * neither it says so and exits 0 -- a missing key is not a failing feature,
 * and blocking a deploy on it would be wrong.
 *
 * It calls the SAME prompt, schema and validation the live endpoint uses, by
 * importing them, so a change to any of those is measured here rather than
 * being measured against a copy that has quietly drifted.
 *
 * WHAT THIS COSTS: one vision request per image, per run. That is real money.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIR = 'fixtures/ocr';
/** Below this, the feature is not doing its job and should be called broken. */
const THRESHOLD = Number(process.env.OCR_ACCURACY_THRESHOLD ?? 0.95);

const key = (process.env.ANTHROPIC_API_KEY ?? '').trim();

function pairs() {
  if (!existsSync(DIR)) return [];
  const files = readdirSync(DIR);
  return files
    .filter((name) => /\.(png|jpe?g)$/i.test(name))
    .map((image) => {
      const stem = image.replace(/\.(png|jpe?g)$/i, '');
      const expected = `${stem}.expected.json`;
      return files.includes(expected)
        ? { image: join(DIR, image), expected: join(DIR, expected), stem }
        : null;
    })
    .filter(Boolean);
}

const found = pairs();
if (found.length === 0) {
  console.log(
    `No screenshot fixtures in ${DIR}/. Nothing to measure — see ${DIR}/README.md ` +
      'for how to add one. This is not a failure, but it does mean nobody has\n' +
      'yet checked that a real screenshot is read correctly.',
  );
  process.exit(0);
}
if (!key) {
  console.log(
    `${found.length} fixture(s) present but ANTHROPIC_API_KEY is not set, so nothing was measured.`,
  );
  process.exit(0);
}

// api/ is TypeScript and this is a plain node script, so it is transpiled the
// same way Vercel does rather than duplicated. Importing the real module is
// the point: a prompt measured here is the prompt that ships.
const out = mkdtempSync(join(tmpdir(), 'ocr-'));
execFileSync(
  'npx',
  ['esbuild', 'api/ocr.ts', `--outdir=${out}`, '--format=esm', '--platform=node', '--log-level=error'],
  { stdio: 'pipe' },
);
const { systemPrompt, outputSchema, interpretExtraction, stripMetadata } = await import(
  join(out, 'ocr.js')
);

const goodsFile = JSON.parse(readFileSync('data/goods.json', 'utf8'));
const resourcesFile = JSON.parse(readFileSync('data/resources.json', 'utf8'));
const GOODS = [
  ...goodsFile.goods,
  ...(resourcesFile.craftMaterials ?? []),
  ...(resourcesFile.specialItems ?? []),
].map((g) => ({
  id: g.id,
  name: g.name,
  minPrice: g.minPrice ?? null,
  maxPrice: g.maxPrice ?? null,
}));

const { default: Anthropic } = await import('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: key, timeout: 120_000 });

/** Every field of every good the ground truth mentions, plus what came back. */
function compare(expected, actual) {
  const got = new Map(actual.rows.map((r) => [r.goodId, r]));
  const results = [];
  for (const row of expected.rows) {
    const mine = got.get(row.goodId);
    for (const field of ['buy', 'sell', 'stock']) {
      const truth = row[field] ?? null;
      const read = mine ? mine[`${field}Text`] || null : null;
      let verdict;
      if (truth === read) verdict = 'exact';
      else if (truth !== null && read === null) verdict = 'missed';
      else if (truth === null && read !== null) verdict = 'invented';
      else verdict = 'wrong';
      results.push({ goodId: row.goodId, field, truth, read, verdict });
    }
  }
  // A good the screenshot does not contain, reported anyway, is the worst
  // failure mode there is: it is a price for a port nobody looked at.
  for (const [goodId, row] of got) {
    if (expected.rows.some((r) => r.goodId === goodId)) continue;
    for (const field of ['buy', 'sell', 'stock']) {
      const read = row[`${field}Text`] || null;
      if (read !== null) {
        results.push({ goodId, field, truth: null, read, verdict: 'invented' });
      }
    }
  }
  return results;
}

const all = [];
for (const pair of found) {
  const expected = JSON.parse(readFileSync(pair.expected, 'utf8'));
  const mediaType = /\.png$/i.test(pair.image) ? 'image/png' : 'image/jpeg';
  const bytes = stripMetadata(readFileSync(pair.image), mediaType);

  const started = Date.now();
  const message = await client.messages.stream({
    model: 'claude-opus-5',
    max_tokens: 4096,
    system: [{ type: 'text', text: systemPrompt(GOODS), cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } },
          {
            type: 'text',
            text:
              'Transcribe every good and its numbers from this screenshot. ' +
              'Leave anything you cannot read clearly as null.',
          },
        ],
      },
    ],
    output_config: { format: { type: 'json_schema', schema: outputSchema(GOODS.map((g) => g.id)) } },
  }).finalMessage();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const text = message.content.find((b) => b.type === 'text')?.text ?? '{}';
  const actual = interpretExtraction(JSON.parse(text), GOODS);
  const results = compare(expected, actual);
  all.push(...results);

  const counts = tally(results);
  console.log(
    `\n${pair.stem}  (${seconds}s, ${message.usage?.input_tokens ?? '?'} in / ${
      message.usage?.output_tokens ?? '?'
    } out)`,
  );
  console.log(`  screen: ${actual.screen}   port: ${actual.portName ?? '—'}`);
  console.log(`  ${line(counts, results.length)}`);
  for (const r of results.filter((r) => r.verdict !== 'exact')) {
    console.log(`    ${r.verdict.padEnd(8)} ${r.goodId}.${r.field}: expected ${fmt(r.truth)}, got ${fmt(r.read)}`);
  }
}

function fmt(value) {
  return value === null ? '(blank)' : `"${value}"`;
}

function tally(results) {
  const counts = { exact: 0, missed: 0, wrong: 0, invented: 0 };
  for (const r of results) counts[r.verdict] += 1;
  return counts;
}

function line(counts, total) {
  const pct = total === 0 ? 0 : counts.exact / total;
  return (
    `${(pct * 100).toFixed(1)}% exact (${counts.exact}/${total})  ` +
    `missed ${counts.missed}  wrong ${counts.wrong}  invented ${counts.invented}`
  );
}

const counts = tally(all);
const accuracy = all.length === 0 ? 0 : counts.exact / all.length;
console.log(`\n${'='.repeat(60)}`);
console.log(`OVERALL  ${line(counts, all.length)}`);
console.log(`Threshold: ${(THRESHOLD * 100).toFixed(0)}%`);

// "wrong" and "invented" are worse than "missed" and are called out
// separately: a blank costs a moment of typing, a confident wrong number
// costs a bad trade and everyone's trust in the rest of the screen.
if (counts.wrong > 0 || counts.invented > 0) {
  console.log(
    `\n${counts.wrong} wrong and ${counts.invented} invented values. These matter more than ` +
      'the percentage: a blank is honest, a wrong number is not.',
  );
}

process.exit(accuracy >= THRESHOLD ? 0 : 1);
