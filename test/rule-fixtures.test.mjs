import test from 'node:test';
import assert from 'node:assert/strict';
import { runRuleFixtures } from '../bridge/run-rule-fixtures.mjs';

test('normative rule fixture registry is fully executable and engine-separated', () => {
  const report = runRuleFixtures();
  assert.equal(report.schema_version, 'rule-fixtures-report.v1');
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.ok, true);
  assert.ok(report.summary.total >= 14);
  assert.equal(report.engine_status, 'not_run');
  assert.ok(report.fixtures.every(row => row.status === 'pass' && row.engine_status === 'not_run'));
});
