import test from 'node:test';
import assert from 'node:assert/strict';
import { addDecisionRecord, classifyDecisionMethod, createCoverageAccumulator, finalizeCoverage } from '../bridge/decision-coverage.mjs';

test('decision coverage distinguishes modeled, partial and unknown methods', () => {
  assert.equal(classifyDecisionMethod('gongJiOrFaShu').status, 'modeled');
  assert.equal(classifyDecisionMethod('chooseToMove').status, 'partial');
  assert.equal(classifyDecisionMethod('chooseToMove', { selection: { composition: 'move_assignment' } }).status, 'modeled');
  assert.equal(classifyDecisionMethod('chooseCardTarget').status, 'modeled');
  assert.equal(classifyDecisionMethod('chooseCardTarget', { selection: { composition: 'atomic_card_target', multi_supported: false } }).status, 'partial');
  assert.equal(classifyDecisionMethod('chooseToDiscard').status, 'modeled');
  assert.equal(classifyDecisionMethod('chooseSomethingNew').status, 'unmodeled');
  assert.equal(classifyDecisionMethod('customDecision').status, 'unmodeled');
});

test('decision coverage aggregates methods by mode and exposes strict status', () => {
  const accumulator = createCoverageAccumulator();
  addDecisionRecord(accumulator, { method: 'chooseButton', mode: 'three', matchId: 'm1' });
  addDecisionRecord(accumulator, { method: 'chooseToMove', mode: 'three', matchId: 'm1' });
  addDecisionRecord(accumulator, { method: 'chooseNewThing', mode: 'four', matchId: 'm2' });
  const report = finalizeCoverage(accumulator, { audit: { records: 3, sources: { inline: 3 }, invalid: 0, fallback: 0 } });
  assert.equal(report.decision_requests, 3);
  assert.deepEqual(report.coverage, { modeled: 1, partial: 1, unmodeled: 1, modeled_rate: 1 / 3, fully_covered: false });
  assert.deepEqual(report.matches, ['m1', 'm2']);
  assert.deepEqual(report.modes.map(mode => mode.mode), ['four', 'three']);
});
