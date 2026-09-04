// Deterministic, match-grouped split for ranking.v1 rows.
//
// Every decision from one match stays in one partition. This prevents the
// highly correlated adjacent decisions of a single game from leaking into
// validation/test and keeps unlabeled rows out of supervised partitions.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultRuntime = resolve(here, '..', 'runtime');

export function parseJsonLines(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function hashUnit(value) {
  const digest = createHash('sha256').update(String(value)).digest();
  return digest.readUInt32BE(0) / 0x100000000;
}

export function normalizeRatios({ train = 0.8, valid = 0.1, test = 0.1 } = {}) {
  const values = [Number(train), Number(valid), Number(test)];
  if (values.some(value => !Number.isFinite(value) || value < 0) || values.reduce((sum, value) => sum + value, 0) <= 0) throw new RangeError('split ratios must be finite non-negative values with a positive sum');
  const total = values.reduce((sum, value) => sum + value, 0);
  return { train: values[0] / total, valid: values[1] / total, test: values[2] / total };
}

function partitionFor(matchId, ratios, salt = 'ranking.v1') {
  const point = hashUnit(`${salt}#${matchId}`);
  if (point < ratios.train) return 'train';
  if (point < ratios.train + ratios.valid) return 'valid';
  return 'test';
}

export function splitRankingRows(rows = [], { ratios, salt = 'ranking.v1' } = {}) {
  const normalized = normalizeRatios(ratios);
  const groups = new Map();
  const unlabeled = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.schema_version !== 'ranking.v1') continue;
    if (row.label?.outcome !== -1 && row.label?.outcome !== 0 && row.label?.outcome !== 1) {
      unlabeled.push(row);
      continue;
    }
    const matchId = String(row.match_id || 'unknown');
    if (!groups.has(matchId)) groups.set(matchId, []);
    groups.get(matchId).push(row);
  }
  const partitions = { train: [], valid: [], test: [] };
  const matchIds = { train: [], valid: [], test: [] };
  for (const [matchId, matchRows] of groups.entries()) {
    const partition = partitionFor(matchId, normalized, salt);
    partitions[partition].push(...matchRows);
    matchIds[partition].push(matchId);
  }
  for (const key of Object.keys(matchIds)) matchIds[key].sort();
  return {
    schema_version: 'ranking-split.v1',
    ratios: normalized,
    salt,
    partitions,
    unlabeled,
    groups: Object.fromEntries(Object.keys(matchIds).map(key => [key, { matches: matchIds[key], rows: partitions[key].length }])),
    labeled_rows: Object.values(partitions).reduce((sum, value) => sum + value.length, 0),
    unlabeled_rows: unlabeled.length,
    ready_for_supervised_training: Object.values(matchIds).every(value => value.length > 0) && partitions.train.length > 0 && partitions.valid.length > 0,
  };
}

async function writeRows(path, rows) {
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

export async function splitRankingDataset({ input = join(defaultRuntime, 'datasets', 'ranking.v1.jsonl'), outputDir = join(defaultRuntime, 'datasets', 'ranking-split.v1'), ratios, salt = 'ranking.v1' } = {}) {
  const rows = parseJsonLines(await readFile(input, 'utf8').catch(() => ''));
  const result = splitRankingRows(rows, { ratios, salt });
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeRows(join(outputDir, 'train.jsonl'), result.partitions.train),
    writeRows(join(outputDir, 'valid.jsonl'), result.partitions.valid),
    writeRows(join(outputDir, 'test.jsonl'), result.partitions.test),
    writeRows(join(outputDir, 'unlabeled.jsonl'), result.unlabeled),
  ]);
  const manifest = {
    schema_version: 'ranking-split-manifest.v1',
    generated_at: new Date().toISOString(),
    input,
    output_dir: outputDir,
    salt: result.salt,
    ratios: result.ratios,
    groups: result.groups,
    labeled_rows: result.labeled_rows,
    unlabeled_rows: result.unlabeled_rows,
    ready_for_supervised_training: result.ready_for_supervised_training,
    leakage_policy: 'All rows sharing match_id are assigned to exactly one labeled partition; unlabeled rows are isolated.',
  };
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { result, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const runtime = resolve(process.env.XB_RUNTIME_DIR || defaultRuntime);
    const output = process.env.XB_RANKING_SPLIT_DIR || join(runtime, 'datasets', 'ranking-split.v1');
    const result = await splitRankingDataset({
      input: process.env.XB_RANKING_INPUT || join(runtime, 'datasets', 'ranking.v1.jsonl'),
      outputDir: output,
      salt: process.env.XB_RANKING_SPLIT_SALT || 'ranking.v1',
      ratios: { train: Number(process.env.XB_RANKING_TRAIN || 0.8), valid: Number(process.env.XB_RANKING_VALID || 0.1), test: Number(process.env.XB_RANKING_TEST || 0.1) },
    });
    console.log(JSON.stringify({ output_dir: output, groups: result.manifest.groups, labeled_rows: result.manifest.labeled_rows, unlabeled_rows: result.manifest.unlabeled_rows, ready_for_supervised_training: result.manifest.ready_for_supervised_training }, null, 2));
  } catch (error) {
    console.error(`[ranking-split] ${error.message}`);
    process.exitCode = 1;
  }
}
