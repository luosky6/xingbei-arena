// Summarize result.v1 JSONL without making promotion decisions.  The report
// is intentionally descriptive: the separate tune/gate.mjs owns thresholds.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultMatches = resolve(here, '..', 'runtime', 'matches');
const defaultViolations = resolve(here, '..', 'runtime', 'violations', 'events.jsonl');
const defaultDecisions = resolve(here, '..', 'runtime', 'decisions', 'events.jsonl');

export function wilson95(wins, n, z = 1.959963984540054) {
  if (!n) return { low: 0, high: 0 };
  const p = wins / n;
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function numeric(values) {
  return values.filter(value => Number.isFinite(Number(value))).map(Number);
}

function percentile(values, p) {
  const sorted = numeric(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function bootstrap95(games, side, rounds = 1000) {
  if (!games.length) return { low: 0, high: 0, rounds: 0 };
  const material = games.map(game => `${game.match_id}:${game.winner_side}`).join('|');
  let state = createHash('sha256').update(`${side}|${material}`).digest().readUInt32BE(0) || 1;
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    let wins = 0;
    for (let i = 0; i < games.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      if (games[state % games.length].winner_side === side) wins++;
    }
    samples.push(wins / games.length);
  }
  samples.sort((a, b) => a - b);
  return { low: samples[Math.floor(samples.length * 0.025)], high: samples[Math.ceil(samples.length * 0.975) - 1], rounds };
}

function describe(games) {
  const completed = games.filter(game => ['red', 'blue'].includes(game.winner_side));
  const turns = numeric(completed.map(game => game.turns)).sort((a, b) => a - b);
  const bySide = {};
  for (const side of ['red', 'blue']) {
    const wins = completed.filter(game => game.winner_side === side).length;
    bySide[side] = { wins, losses: completed.length - wins, samples: completed.length,
      win_rate: completed.length ? wins / completed.length : 0, wilson95: wilson95(wins, completed.length), bootstrap95: bootstrap95(completed, side) };
  }
  const winBy = {};
  for (const game of completed) winBy[game.win_by || 'unknown'] = (winBy[game.win_by || 'unknown'] || 0) + 1;
  return {
    samples: games.length,
    completed: completed.length,
    wins: { red: bySide.red.wins, blue: bySide.blue.wins },
    by_side: bySide,
    win_by: winBy,
    turns: {
      samples: turns.length,
      mean: turns.length ? turns.reduce((sum, value) => sum + value, 0) / turns.length : null,
      median: turns.length ? (turns.length % 2 ? turns[(turns.length - 1) / 2] : (turns[turns.length / 2 - 1] + turns[turns.length / 2]) / 2) : null,
      min: turns.length ? turns[0] : null,
      max: turns.length ? turns[turns.length - 1] : null,
    },
  };
}

function groupBy(games, key) {
  const groups = {};
  for (const game of games) {
    const value = game[key] == null || game[key] === '' ? 'unknown' : String(game[key]);
    (groups[value] ||= []).push(game);
  }
  return Object.fromEntries(Object.entries(groups).map(([value, items]) => [value, describe(items)]));
}

async function filesIn(dir) {
  return (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(item => item.isFile() && item.name.endsWith('.jsonl'))
    .map(item => join(dir, item.name)).sort();
}

async function readResults(matchesDir, prefix = '') {
  const games = [];
  for (const path of await filesIn(matchesDir)) {
    for (const line of (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean)) {
      try {
        const value = JSON.parse(line);
        if (value.type === 'result' && typeof value.match_id === 'string' && (!prefix || value.match_id.startsWith(prefix))) games.push(value);
      } catch {}
    }
  }
  return games;
}

async function readViolations(path, matchIds) {
  const items = [];
  for (const line of (await readFile(path, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      if (matchIds.has(String(value.match_id))) items.push(value);
    } catch {}
  }
  return items;
}

async function readDecisionAudits(path, matchIds) {
  const items = [];
  for (const line of (await readFile(path, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      if (value.type === 'decision_audit' && matchIds.has(String(value.match_id))) items.push(value);
    } catch {}
  }
  return items;
}

function describeDecisions(items) {
  const bySource = {};
  for (const item of items) bySource[item.source || 'unknown'] = (bySource[item.source || 'unknown'] || 0) + 1;
  const latencies = numeric(items.map(item => item.latency_ms));
  const candidates = numeric(items.map(item => item.candidate_count));
  return {
    count: items.length,
    by_source: bySource,
    invalid: items.filter(item => item.valid === false).length,
    latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.length ? Math.max(...latencies) : null },
    candidate_count: { mean: candidates.length ? candidates.reduce((sum, value) => sum + value, 0) / candidates.length : null, max: candidates.length ? Math.max(...candidates) : null },
  };
}

export async function summarizeMatches({ matchesDir = defaultMatches, violationsFile = defaultViolations, decisionsFile = defaultDecisions, prefix = '', output = null } = {}) {
  const results = await readResults(matchesDir, prefix);
  const matchIds = new Set(results.map(result => String(result.match_id)));
  const violations = await readViolations(violationsFile, matchIds);
  const decisions = await readDecisionAudits(decisionsFile, matchIds);
  const reasons = {};
  for (const violation of violations) reasons[violation.reason || 'unknown'] = (reasons[violation.reason || 'unknown'] || 0) + 1;
  const report = {
    schema_version: 'summary.v1',
    generated_at: new Date().toISOString(),
    prefix,
    source: { matches_dir: matchesDir, violations_file: violationsFile, decisions_file: decisionsFile },
    overall: describe(results),
    by_mode: groupBy(results, 'mode'),
    by_policy: groupBy(results, 'policy_id'),
    by_overlay_side: groupBy(results, 'overlay_side'),
    failures: {
      timeout: results.filter(result => result.status === 'timeout').length,
      error: results.filter(result => result.status === 'error' || result.ok === false && result.status !== 'timeout').length,
    },
    fallback: { count: violations.length, by_reason: reasons },
    violations: { count: violations.length, by_reason: reasons },
    decisions: describeDecisions(decisions),
  };
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const prefix = process.env.XB_SUMMARY_PREFIX || process.argv[2] || '';
  const matchesDir = process.env.XB_MATCHES_DIR ? resolve(process.env.XB_MATCHES_DIR) : defaultMatches;
  const violationsFile = process.env.XB_VIOLATIONS_FILE ? resolve(process.env.XB_VIOLATIONS_FILE) : defaultViolations;
  const decisionsFile = process.env.XB_DECISIONS_FILE ? resolve(process.env.XB_DECISIONS_FILE) : defaultDecisions;
  const output = process.env.XB_SUMMARY_OUT ? resolve(process.env.XB_SUMMARY_OUT) : null;
  try {
    const report = await summarizeMatches({ matchesDir, violationsFile, decisionsFile, prefix, output });
    console.log(JSON.stringify({ prefix: report.prefix, overall: report.overall, failures: report.failures, fallback: report.fallback }, null, 2));
    if (output) console.log(`[summary] ${output}`);
  } catch (error) {
    console.error(`[summary] ${error.message}`);
    process.exitCode = 1;
  }
}
