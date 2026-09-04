import test from 'node:test';
import assert from 'node:assert/strict';
import { behaviorMetadata, deterministicRandom, epsilonGreedy, fallbackChoice, firstLegal, heuristicChoice, POLICY_IDS, validateResponse } from '../bridge/policy.mjs';

const request = { decision_id: 'm#t1#d1', legal_options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };

test('policy adapters only return legal option ids', () => {
  assert.equal(firstLegal(request), 'a');
  assert.ok(request.legal_options.some(option => option.id === deterministicRandom(request)));
  assert.equal(fallbackChoice(request, 'unknown'), 'a');
  assert.equal(fallbackChoice(request, 'deterministic_random'), deterministicRandom(request));
  const tactical = { decision_id: 'tactical#1', legal_options: [
    { id: 'ally', baseline_score: 1, candidate_features: { target_is_enemy: false } },
    { id: 'threat', baseline_score: 1, candidate_features: { target_is_enemy: true, enemy_shiqi: 1, target_role_tags: { finisher: true } } },
  ] };
  assert.equal(heuristicChoice(tactical), 'threat');
  assert.equal(fallbackChoice(tactical, 'heuristic'), 'threat');
  assert.ok(POLICY_IDS.includes('learned_v1'));
  assert.equal(fallbackChoice(tactical, 'learned_v1'), 'ally');
  assert.equal(behaviorMetadata(tactical, 'learned_v1', 'threat').probability_status, 'learned_model_deterministic_not_calibrated');
  assert.equal(behaviorMetadata(tactical, 'heuristic', 'threat').probability_status, 'deterministic_heuristic');
  assert.ok(request.legal_options.some(option => option.id === epsilonGreedy({ ...request, epsilon: 1 })));
  assert.equal(behaviorMetadata(request, 'first_legal', 'a').choice_probability, 1);
  assert.equal(behaviorMetadata(request, 'first_legal', 'b').choice_probability, 0);
  assert.equal(behaviorMetadata(request, 'deterministic_random', 'b').probability_status, 'hash_support_probability');
  assert.deepEqual(validateResponse(request, { choice: 'b' }), { ok: true, choice: 'b' });
  assert.deepEqual(validateResponse(request, { choice: ['c', 'a'] }), { ok: true, choice: ['c', 'a'] });
  assert.equal(validateResponse(request, { choice: ['a', 'a'] }).reason, 'duplicate_choice');
  assert.equal(validateResponse(request, { choice: ['a', 'invalid'] }).reason, 'choice_not_legal');
  assert.equal(validateResponse(request, { choice: 'invalid' }).ok, false);
  assert.equal(validateResponse(request, {}).reason, 'missing_choice');
});
