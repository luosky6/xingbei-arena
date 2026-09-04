import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRatios, splitRankingRows } from '../bridge/split-ranking-dataset.mjs';

const row = (match_id, decision_id, outcome) => ({
  schema_version: 'ranking.v1', match_id, decision_id,
  label: { chosen_id: 'a', outcome },
});

test('ranking split normalizes ratios and rejects invalid values', () => {
  assert.deepEqual(normalizeRatios({ train: 8, valid: 1, test: 1 }), { train: 0.8, valid: 0.1, test: 0.1 });
  assert.throws(() => normalizeRatios({ train: 0, valid: 0, test: 0 }), /positive sum/);
  assert.throws(() => normalizeRatios({ train: -1, valid: 1, test: 1 }), /non-negative/);
});

test('ranking split keeps all decisions from one match together and isolates unlabeled rows', () => {
  const result = splitRankingRows([
    row('m1', 'd1', 1), row('m1', 'd2', 1),
    row('m2', 'd1', -1), row('m2', 'd2', -1),
    row('m3', 'd1', null),
  ], { ratios: { train: 1, valid: 1, test: 1 }, salt: 'test' });
  const seen = new Map();
  for (const [partition, rows] of Object.entries(result.partitions)) for (const item of rows) {
    assert.ok(!seen.has(item.match_id) || seen.get(item.match_id) === partition);
    seen.set(item.match_id, partition);
  }
  assert.equal(result.unlabeled.length, 1);
  assert.equal(result.labeled_rows, 4);
  assert.equal(result.unlabeled_rows, 1);
});
