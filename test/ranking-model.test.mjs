import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateFeatureMap, evaluateRankingModel, fitRankingModel, modelHash, pairRows, scoreCandidate } from '../tune/ranking-model.mjs';

const rows = [
  { label: { chosen_id: 'enemy', outcome: 1 }, candidates: [{ id: 'enemy', baseline_score: 0, features: { target_is_enemy: true, seat_distance: 1 } }, { id: 'ally', baseline_score: 0, features: { target_is_enemy: false, seat_distance: 1 } }] },
  { label: { chosen_id: 'ally', outcome: -1 }, candidates: [{ id: 'enemy', baseline_score: 0, features: { target_is_enemy: true, seat_distance: 2 } }, { id: 'ally', baseline_score: 0, features: { target_is_enemy: false, seat_distance: 1 } }] },
];

test('ranking model excludes hidden fields and produces deterministic artifact hash', () => {
  const model = fitRankingModel(rows, { epochs: 3 });
  assert.ok(model.feature_names.every(name => !/hidden|private|cards?/i.test(name)));
  assert.ok(Object.keys(candidateFeatureMap({ features: { index: 4, target_seat: '7', target_side: 'red', target_is_enemy: true, seat_distance: 2 } })).every(name => !/index|target_seat|target_side/.test(name)));
  assert.equal(modelHash(model), modelHash(fitRankingModel(rows, { epochs: 3 })));
  assert.equal(pairRows(rows).length, 2);
  assert.equal(typeof scoreCandidate(model, rows[0].candidates[0]), 'number');
});

test('ranking model reports separate observed-choice and outcome-consistency metrics', () => {
  const model = fitRankingModel(rows, { epochs: 12, learningRate: 0.05 });
  const metrics = evaluateRankingModel(model, rows);
  assert.equal(metrics.rows, 2);
  assert.equal(metrics.pairs, 2);
  assert.ok(metrics.outcome_consistency >= 0 && metrics.outcome_consistency <= 1);
  assert.ok(metrics.pair_accuracy >= 0 && metrics.pair_accuracy <= 1);
});
