// Pre-registered promotion gate for challenger overlay strategies.
// It never edits weights/champion pointers; it only emits an auditable report.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const defaultMatches = resolve(here, '..', 'runtime', 'matches');

function wilson(wins, n, z = 1.959963984540054) {
  if (!n) return { low: 0, high: 0 };
  const p = wins / n;
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export async function evaluatePrefix(prefix, { matchesDir = defaultMatches } = {}) {
  const files = (await readdir(matchesDir, { withFileTypes: true }).catch(() => []))
    .filter(item => item.isFile() && item.name.endsWith('.jsonl'))
    .map(item => join(matchesDir, item.name));
  const games = [];
  for (const path of files) {
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let result;
      try { result = JSON.parse(line); } catch { continue; }
      if (result.type !== 'result' || typeof result.match_id !== 'string' || !result.match_id.startsWith(prefix)) continue;
      const attributable = result.overlay === true && ['red', 'blue'].includes(result.overlay_side) && result.overlay_installed === true && Number(result.trajectory_dropped || 0) === 0 && ['red', 'blue'].includes(result.winner_side);
      if (!attributable) continue;
      games.push({ match_id: result.match_id, seed: result.seed ?? null, mode: result.mode ?? null, overlay_side: result.overlay_side, won: result.winner_side === result.overlay_side, win_by: result.win_by || null, turns: result.turns ?? null });
    }
  }
  const wins = games.filter(game => game.won).length;
  const interval = wilson(wins, games.length);
  return { prefix, samples: games.length, wins, losses: games.length - wins, win_rate: games.length ? wins / games.length : 0, wilson95: interval, games };
}

export async function evaluateGate({ prefix, matchesDir = defaultMatches, minGames = 50, minWinRate = 0.55, minWilsonLow = 0.5, output = null } = {}) {
  if (!prefix) throw new Error('prefix is required');
  const stats = await evaluatePrefix(prefix, { matchesDir });
  const status = stats.samples < minGames ? 'insufficient_evidence' : stats.win_rate >= minWinRate && stats.wilson95.low >= minWilsonLow ? 'pass' : 'reject';
  const report = { schema_version: 'gate.v1', generated_at: new Date().toISOString(), thresholds: { min_games: minGames, min_win_rate: minWinRate, min_wilson_low: minWilsonLow }, status, ...stats };
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return report;
}

/**
 * Side-balanced gate: red and blue overlay runs must use the same seed set
 * and are evaluated as one challenger sample.  This prevents a color/seat
 * advantage from being mistaken for a policy improvement.
 */
export async function evaluatePairedGate({ redPrefix, bluePrefix, matchesDir = defaultMatches, minGames = 50, minGamesPerSide = Math.ceil(minGames / 2), minPairs = Math.ceil(minGames / 2), minWinRate = 0.55, minWilsonLow = 0.5, output = null } = {}) {
  if (!redPrefix || !bluePrefix) throw new Error('redPrefix and bluePrefix are required');
  const [red, blue] = await Promise.all([evaluatePrefix(redPrefix, { matchesDir }), evaluatePrefix(bluePrefix, { matchesDir })]);
  const games = [...red.games, ...blue.games];
  const wins = games.filter(game => game.won).length;
  const interval = wilson(wins, games.length);
  const redSeeds = new Set(red.games.map(game => String(game.seed)).filter(seed => seed !== 'null'));
  const blueSeeds = new Set(blue.games.map(game => String(game.seed)).filter(seed => seed !== 'null'));
  const pairedSeeds = [...redSeeds].filter(seed => blueSeeds.has(seed)).sort();
  const sideCountsOk = red.samples >= minGamesPerSide && blue.samples >= minGamesPerSide;
  const status = games.length < minGames || pairedSeeds.length < minPairs || !sideCountsOk
    ? 'insufficient_evidence'
    : wins / games.length >= minWinRate && interval.low >= minWilsonLow ? 'pass' : 'reject';
  const report = {
    schema_version: 'gate.v1',
    gate_kind: 'paired_side_balanced',
    generated_at: new Date().toISOString(),
    prefixes: { red: redPrefix, blue: bluePrefix },
    thresholds: { min_games: minGames, min_games_per_side: minGamesPerSide, min_pairs: minPairs, min_win_rate: minWinRate, min_wilson_low: minWilsonLow },
    status,
    samples: games.length,
    wins,
    losses: games.length - wins,
    win_rate: games.length ? wins / games.length : 0,
    wilson95: interval,
    side_samples: { red: red.samples, blue: blue.samples },
    paired_seed_count: pairedSeeds.length,
    paired_seeds: pairedSeeds,
    side_stats: { red: red, blue: blue },
    games,
  };
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const prefix = process.env.XB_GATE_PREFIX || process.argv[2];
  const matchesDir = process.env.XB_MATCHES_DIR ? resolve(process.env.XB_MATCHES_DIR) : defaultMatches;
  const output = process.env.XB_GATE_OUT ? resolve(process.env.XB_GATE_OUT) : null;
  try {
    const minGames = Number(process.env.XB_GATE_MIN_GAMES || 50);
    const minWinRate = Number(process.env.XB_GATE_MIN_RATE || 0.55);
    const minWilsonLow = Number(process.env.XB_GATE_MIN_LOW || 0.5);
    const report = process.env.XB_GATE_RED_PREFIX && process.env.XB_GATE_BLUE_PREFIX
      ? await evaluatePairedGate({ redPrefix: process.env.XB_GATE_RED_PREFIX, bluePrefix: process.env.XB_GATE_BLUE_PREFIX, matchesDir, minGames, minGamesPerSide: Number(process.env.XB_GATE_MIN_SIDE || Math.ceil(minGames / 2)), minPairs: Number(process.env.XB_GATE_MIN_PAIRS || Math.ceil(minGames / 2)), minWinRate, minWilsonLow, output })
      : await evaluateGate({ prefix, matchesDir, minGames, minWinRate, minWilsonLow, output });
    console.log(JSON.stringify({ status: report.status, prefix: report.prefix || report.prefixes, samples: report.samples, win_rate: report.win_rate, wilson95: report.wilson95, paired_seed_count: report.paired_seed_count ?? null }, null, 2));
    if (report.status !== 'pass') process.exitCode = 2;
  } catch (error) { console.error(`[gate] ${error.message}`); process.exitCode = 1; }
}
