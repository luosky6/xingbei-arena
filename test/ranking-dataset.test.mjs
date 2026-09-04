import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRankingRows, parseJsonLines } from '../bridge/build-ranking-dataset.mjs';

test('ranking dataset keeps legal candidates, public features and outcome provenance', () => {
  const audit = { type: 'decision_audit', match_id: 'm1', rules_version: 'r1', rules_profile: 'core-10th', decision_id: 'd1', decision_type: 'gongJiOrFaShu', seat: '0', side: 'red', source: 'inline', candidate_ids: ['a', 'b'], candidate_features: { a: { target_seat: '1', hand_count: 3, private_card: 'secret' }, b: { target_seat: '2' } }, candidate_scores: { a: 1.2, b: 0.5 }, behavior: { choice_probability: 0.75, probability_status: 'epsilon_policy' }, choice: 'a' };
  const result = { type: 'result', match_id: 'm1', winner_side: 'red', engine_fingerprint: 'sha256:x', policy_id: 'builtin-v0' };
  const built = buildRankingRows([audit], [result]);
  assert.equal(built.rows.length, 1);
  assert.equal(built.rows[0].label.outcome, 1);
  assert.equal(built.rows[0].candidates[0].chosen, true);
  assert.equal(built.rows[0].candidates[0].features.hand_count, undefined);
  assert.equal(built.rows[0].behavior.probability, 0.75);
  assert.equal(built.rows[0].provenance.winner_side, 'red');
});

test('ranking dataset rejects pass/no-candidate audits instead of inventing labels', () => {
  const built = buildRankingRows([{ type: 'decision_audit', match_id: 'm1', decision_id: 'd0', candidate_ids: [], choice: 0 }], []);
  assert.equal(built.rows.length, 0);
  assert.equal(built.rejected[0].reason, 'missing_or_illegal_choice');
  assert.deepEqual(parseJsonLines('{"x":1}\nnot-json\n'), [{ x: 1 }]);
});
