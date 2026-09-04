import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConvergence } from '../bridge/convergence.mjs';

const completeFixtureReport = { summary: { ok: true }, engine_status: 'verified' };
const completeCoverage = { coverage: { fully_covered: true }, audit: { invalid: 0, fallback: 0 } };
const completeManifest = { summary: { quarantined_trajectories: 0 } };
const completeSplit = { ready_for_supervised_training: true, labeled_rows: 400, groups: { train: { matches: ['a'] }, valid: { matches: ['b'] }, test: { matches: ['c'] } } };
const completeModel = { status: 'candidate', data: { train: 300, valid: 50, test: 50 }, model: { model_hash: 'sha256:model' } };
const completePatterns = { summary: { fully_verified: true } };
const completeDistillation = { summary: { skill_issue_count: 0, confirmed_rules_missing_dynamic_links: 0 } };

test('convergence report remains not converged while any evidence gate is missing', () => {
  const report = evaluateConvergence({ fixtureReport: { summary: { ok: true }, engine_status: 'not_run' }, eventEvidence: { summary: { fully_verified: false } }, coverageReport: completeCoverage, manifest: completeManifest, splitManifest: completeSplit, gateReport: { status: 'pass' } });
  assert.equal(report.status, 'not_converged');
  assert.ok(report.blockers.some(value => value.includes('动态场景')));
});

test('convergence report can pass only when every registered gate is satisfied', () => {
  const report = evaluateConvergence({ fixtureReport: completeFixtureReport, eventEvidence: { summary: { fully_verified: true } }, dynamicPatterns: completePatterns, modelReport: completeModel, coverageReport: completeCoverage, manifest: completeManifest, splitManifest: completeSplit, gateReport: { status: 'pass' }, distillationAudit: completeDistillation });
  assert.equal(report.status, 'converged');
  assert.deepEqual(report.blockers, []);
});

test('convergence report labels dynamic fixture evidence as the source when legacy reports are stale', () => {
  const report = evaluateConvergence({
    fixtureReport: { summary: { ok: true }, engine_status: 'not_run' },
    dynamicFixtureReport: { summary: { engine_status: 'verified', event_semantics_verified: true, pattern_semantics_verified: true } },
    eventEvidence: { summary: { fully_verified: false } },
    dynamicPatterns: { summary: { fully_verified: false } },
    coverageReport: completeCoverage,
    manifest: completeManifest,
    splitManifest: completeSplit,
    modelReport: completeModel,
    gateReport: { status: 'pass' },
  });
  assert.equal(report.checks.find(check => check.name === 'dynamic_rule_engine_agreement').observed, 'verified');
  assert.equal(report.checks.find(check => check.name === 'rule_event_semantics').observed.source, 'dynamic_fixture_report');
  assert.equal(report.checks.find(check => check.name === 'dynamic_event_patterns').observed.source, 'dynamic_fixture_report');
});
