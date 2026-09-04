import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDynamicPatterns } from '../bridge/build-rule-dynamic-patterns.mjs';

test('dynamic pattern audit verifies structure while retaining semantic not_verified status', () => {
  const records = [
    { match_id: 'm1', seq: 1, kind: 'event_start', event_id: 'd1', parent_event_id: 'u1', event: { name: 'damage' } },
    { match_id: 'm1', seq: 2, kind: 'event_create', event_id: 'draw1', parent_event_id: 'd1', event: { name: 'draw' } },
    { match_id: 'm1', seq: 3, kind: 'event_start', event_id: 'draw1', parent_event_id: 'd1', event: { name: 'draw' } },
    { match_id: 'm1', seq: 4, kind: 'event_finish', event_id: 'draw1', parent_event_id: 'd1', event: { name: 'draw' } },
    { match_id: 'm1', seq: 5, kind: 'event_finish', event_id: 'd1', parent_event_id: 'u1', event: { name: 'damage' } },
  ];
  const report = summarizeDynamicPatterns([{ match_id: 'm1', records }]);
  assert.equal(report.patterns.damage_to_draw_same_parent.status, 'observed_partial');
  assert.equal(report.patterns.damage_to_draw_same_parent.evidence_count, 1);
  assert.equal(report.patterns.damage_to_draw_same_parent.examples[0].ordered, true);
  assert.equal(report.patterns.damage_to_draw_same_parent.passing_evidence_count, 1);
  assert.equal(report.patterns.damage_to_draw_same_parent.semantic_status, 'not_verified');
  assert.equal(report.summary.fully_verified, false);
});
