import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRuleEvents } from '../bridge/build-rule-event-evidence.mjs';

test('rule event evidence reports observed events as partial, never verified semantics', () => {
  const report = summarizeRuleEvents([
    { match_id: 'm1', seq: 1, kind: 'event_start', event: { name: 'gongJi' } },
    { match_id: 'm1', seq: 2, kind: 'event_start', event: { name: 'damage' } },
    { match_id: 'm2', seq: 3, kind: 'event_start', event: { name: 'draw' } },
  ]);
  assert.equal(report.trajectory_files, 2);
  assert.equal(report.areas.attack_and_response.status, 'observed_partial');
  assert.equal(report.areas.attack_and_response.semantic_assertion, 'not_verified');
  assert.equal(report.summary.fully_verified, false);
  assert.equal(report.event_names.damage, 1);
});
