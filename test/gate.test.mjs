import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateGate, evaluatePairedGate, evaluatePrefix } from '../tune/gate.mjs';

test('promotion gate filters non-attributable games and reports evidence status', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'xingbei-gate-'));
  try {
    await mkdir(temp, { recursive: true });
    const line = value => JSON.stringify({ type: 'result', ...value });
    await writeFile(join(temp, 'batch.jsonl'), [
      line({ match_id: 'challenger_1', overlay: true, overlay_side: 'red', overlay_installed: true, trajectory_dropped: 0, winner_side: 'red', seed: 1 }),
      line({ match_id: 'challenger_2', overlay: true, overlay_side: 'red', overlay_installed: true, trajectory_dropped: 0, winner_side: 'blue', seed: 2 }),
      line({ match_id: 'challenger_bad', overlay: true, overlay_side: 'both', overlay_installed: true, trajectory_dropped: 0, winner_side: 'red', seed: 3 }),
    ].join('\n') + '\n');
    const stats = await evaluatePrefix('challenger', { matchesDir: temp });
    assert.equal(stats.samples, 2);
    assert.equal(stats.wins, 1);
    const report = await evaluateGate({ prefix: 'challenger', matchesDir: temp, minGames: 2, minWinRate: 0.5, minWilsonLow: 0 });
    assert.equal(report.status, 'pass');
    const insufficient = await evaluateGate({ prefix: 'challenger', matchesDir: temp, minGames: 3 });
    assert.equal(insufficient.status, 'insufficient_evidence');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('paired gate requires side balance and common seeds', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'xingbei-paired-gate-'));
  try {
    const line = value => JSON.stringify({ type: 'result', ...value });
    await writeFile(join(temp, 'paired.jsonl'), [
      line({ match_id: 'r_1', overlay: true, overlay_side: 'red', overlay_installed: true, trajectory_dropped: 0, winner_side: 'red', seed: 1 }),
      line({ match_id: 'r_2', overlay: true, overlay_side: 'red', overlay_installed: true, trajectory_dropped: 0, winner_side: 'blue', seed: 2 }),
      line({ match_id: 'b_1', overlay: true, overlay_side: 'blue', overlay_installed: true, trajectory_dropped: 0, winner_side: 'blue', seed: 1 }),
      line({ match_id: 'b_2', overlay: true, overlay_side: 'blue', overlay_installed: true, trajectory_dropped: 0, winner_side: 'red', seed: 2 }),
    ].join('\n') + '\n');
    const report = await evaluatePairedGate({ redPrefix: 'r_', bluePrefix: 'b_', matchesDir: temp, minGames: 4, minGamesPerSide: 2, minPairs: 2, minWinRate: 0.5, minWilsonLow: 0 });
    assert.equal(report.status, 'pass');
    assert.equal(report.paired_seed_count, 2);
    assert.equal(report.side_samples.red, 2);
    assert.equal(report.side_samples.blue, 2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
