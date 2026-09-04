import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMoraleLoss, canBuy, getRuleProfile, noActionEligibility, resolveDamage, RULE_PROFILES, seatOrder, synthesize, validateSetup, victoryLines } from '../rules/adjudicator.mjs';
import { compareTiming, orderTimingItems, TIMING_STAGES, timingIndex } from '../rules/timing.mjs';
import noActionCases from '../knowledge/curated/rules/no-action-cases.json' with { type: 'json' };
import characters from '../knowledge/generated/characters.json' with { type: 'json' };

test('damage timeline applies healing before damage draw and overflow morale loss', () => {
  const result = resolveDamage({ damage: 4, healing: 1, handCount: 5 });
  assert.equal(result.createdDamage, 4);
  assert.equal(result.actualDamage, 3);
  assert.equal(result.damageDraw, 3);
  assert.equal(result.overflow, 2);
  assert.equal(result.moraleLoss, 2);
});

test('buy and synthesize reject the hand-overflow branch', () => {
  assert.equal(canBuy({ handCount: 4 }), false);
  assert.equal(canBuy({ handCount: 3 }), true);
  assert.equal(synthesize({ teamStones: 3, ownCups: 4, opponentMorale: 5, handCount: 3 }).legal, true);
});

test('victory lines preserve simultaneous wins for mode-level ordering', () => {
  assert.deepEqual(victoryLines({ ownMorale: 15, opponentMorale: 0, ownCups: 5, opponentCups: 0 }), ['simultaneous', 'opponent_morale_zero', 'own_cups_reached']);
});

test('no-action keeps refinement separate from normal action possibility', () => {
  assert.deepEqual(noActionEligibility({ normalActions: 0, canRefine: true }).postDeclaration.specialActionsAllowed, false);
  assert.equal(noActionEligibility({ normalActions: 1, canRefine: true }).eligible, false);
  assert.equal(noActionEligibility({ mandatoryStartsPending: 1, startupCanIncreaseActions: true }).reason, 'startup_must_increase_action');
  assert.equal(noActionEligibility({ mandatoryStartsPending: 1, taunted: true }).postDeclaration.mode, 'skip_action_phase');
});

test('seat order is relative to the current actor', () => {
  assert.deepEqual(seatOrder([0, 1, 2, 3], 2, 'clockwise'), [3, 0, 1]);
  assert.deepEqual(seatOrder([0, 1, 2, 3], 0, 'counterclockwise'), [3, 2, 1]);
});

test('normative timing remains six ordered stages with explicit seat tie-break', () => {
  assert.deepEqual(TIMING_STAGES.map(stage => stage.id), ['①', '②', '③', '④', '⑤', '⑥']);
  assert.equal(compareTiming('①', '⑥'), -5);
  assert.equal(timingIndex('④'), 4);
  assert.throws(() => timingIndex('source_event'), /unknown timing stage/);
  const ordered = orderTimingItems([
    { stage: '⑤', seat: 3, id: 'late' },
    { stage: '③', seat: 2, id: 'created' },
    { stage: '⑤', seat: 1, id: 'first' },
  ], { seatOrder: [1, 2, 3] });
  assert.deepEqual(ordered.map(item => item.id), ['created', 'first', 'late']);
});

test('morale loss keeps raw engine value separate from normalized victory view', () => {
  assert.deepEqual(applyMoraleLoss({ morale: 1, loss: 3 }), { before: 1, loss: 3, rawAfter: -2, displayAfter: 0, defeated: true });
});

test('8-player supplement uses its own 18-morale profile', () => {
  assert.deepEqual(validateSetup({ players: 6 }), { profile: 'core10th', players: 6, morale: 15, cupsToWin: 5 });
  assert.throws(() => validateSetup({ players: 8 }), /unsupported core10th player count/);
  assert.deepEqual(validateSetup({ players: 8, profile: 'supplement-8p' }), { profile: 'supplement-8p', players: 8, morale: 18, cupsToWin: 5 });
  assert.equal(getRuleProfile('10th_supplement_8p').initialMorale, 18);
  assert.deepEqual(RULE_PROFILES.supplement8p.supportedPlayers, [4, 6, 8]);
});

test('official no-action supplement is indexed with role coverage and executable predicates', () => {
  assert.equal(noActionCases.source_id, 'official-no-action-v25.4.5');
  assert.ok(noActionCases.role_defaults.length >= 40);
  assert.ok(noActionCases.cases.length >= 10);
  const knownCharacters = new Set(characters.objects.map(character => character.id.replace(/^character:/, '')));
  for (const role of noActionCases.role_defaults) for (const id of role.engine_role_ids) assert.ok(knownCharacters.has(id), `unknown engine role id ${id}`);
  for (const row of noActionCases.cases) {
    const result = noActionEligibility(row.input);
    assert.equal(result.eligible, row.verdict === 'allow', row.case_id);
  }
  assert.ok(noActionCases.cases.some(row => row.scenario === 'malicious_guard_discard' && row.verdict === 'deny'));
  assert.ok(noActionCases.cases.some(row => row.scenario === 'taunt_skip_action' && row.verdict === 'allow'));
});
