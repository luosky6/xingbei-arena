import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('decision bridge injects async handlers with stable option ids and safe fallback', async () => {
  const source = await readFile(join(root, 'bridge', 'decisionBridge.mjs'), 'utf8');
  assert.match(source, /__xbBridgeWrapped/);
  assert.match(source, /legal_options/);
  assert.match(source, /control#/);
  assert.match(source, /target#/);
  assert.match(source, /window\.xbDecide/);
  assert.match(source, /lib\.config\.video = 0/);
  assert.match(source, /fallbackChoice\(req, FALLBACK_POLICY\)/);
  assert.match(source, /unsafe_decision_id/);
  assert.match(source, /no legal candidate/);
  assert.match(source, /INLINE_POLICY/);
  assert.match(source, /decideWithPolicy\(req, INLINE_POLICY\)/);
  assert.match(source, /isActionEvent/);
  assert.match(source, /gongJiOrFaShu\|gongJi\|faShu\|yingZhan\|moDan\|qiTa/);
  assert.match(source, /window\.__nn\?\.game \|\| window\.game/);
  assert.match(source, /decision_schema: 'decision\.v1'/);
  assert.match(source, /candidate_features/);
  assert.match(source, /candidate_scores/);
  assert.match(source, /roleTags/);
  assert.match(source, /role_coverage/);
  assert.match(source, /recordDecisionAudit/);
  assert.match(source, /DECISION_AUDIT/);
  assert.match(source, /game\.promises\?\.saveConfig/);
  assert.match(source, /selectionSpec/);
  assert.match(source, /cardTargetOptions/);
  assert.match(source, /cardtarget#/);
  assert.match(source, /atomic_card_target/);
  assert.match(source, /publicSeating/);
  assert.match(source, /turn_order_from_first_act/);
  assert.match(source, /moveOptions/);
  assert.match(source, /move_assignment/);
  assert.match(source, /filterOk\(moved\)/);
  assert.match(source, /BRIDGE_RESULT_RECORDER/);
  assert.match(source, /XB_RECORD_RESULT/);
});

test('policy registry exposes only deterministic, validated policies', async () => {
  const policy = await import('../bridge/policy.mjs');
  assert.deepEqual(policy.POLICY_IDS, ['first_legal', 'deterministic_random', 'heuristic', 'epsilon_greedy', 'learned_v1']);
  const request = { decision_id: 't#1', legal_options: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(await policy.decideWithPolicy(request, 'first_legal'), 'a');
  assert.equal(await policy.decideWithPolicy(request, 'deterministic_random'), policy.deterministicRandom(request));
  assert.ok(request.legal_options.some(option => option.id === policy.epsilonGreedy({ ...request, epsilon: 1 })));
  assert.throws(() => policy.createPolicy('unknown'), /unknown policy/);
  const multi = { decision_id: 'multi#1', legal_options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], selection: { min: 2, max: 2, ordered: true } };
  assert.deepEqual(await policy.decideWithPolicy(multi, 'first_legal'), ['a', 'b']);
  assert.equal(policy.validateResponse(multi, { choice: ['a'] }).reason, 'choice_count_out_of_range');
  assert.equal(policy.validateResponse(multi, { choice: ['a', 'a'] }).reason, 'duplicate_choice');
});
