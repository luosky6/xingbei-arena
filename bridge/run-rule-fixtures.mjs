// Run the engine-independent normative rule fixtures and emit an auditable report.
// This runner intentionally does not claim engine agreement: engine_status remains
// `not_run` until a dynamic browser scenario is explicitly linked to a fixture.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as adjudicator from '../rules/adjudicator.mjs';
import * as timing from '../rules/timing.mjs';
import fixtures from '../rules/fixtures.v1.json' with { type: 'json' };

const here = fileURLToPath(new URL('.', import.meta.url));
const defaultRuntime = resolve(here, '..', 'runtime');
const operations = new Map([
  ...Object.entries(adjudicator),
  ...Object.entries(timing),
]);

function runFixture(fixture) {
  const fn = operations.get(fixture.operation);
  if (typeof fn !== 'function') {
    return { fixture_id: fixture.fixture_id, operation: fixture.operation, status: 'error', error: `unknown operation: ${fixture.operation}` };
  }
  try {
    const actual = Array.isArray(fixture.positional)
      ? fn(...fixture.positional)
      : fn(fixture.args);
    assert.deepStrictEqual(actual, fixture.expected);
    return { fixture_id: fixture.fixture_id, operation: fixture.operation, status: 'pass', expected: fixture.expected, actual, source_refs: fixture.source_refs || fixtures.source_refs, engine_status: 'not_run' };
  } catch (error) {
    return { fixture_id: fixture.fixture_id, operation: fixture.operation, status: 'fail', expected: fixture.expected, error: error.message, source_refs: fixture.source_refs || fixtures.source_refs, engine_status: 'not_run' };
  }
}

export function runRuleFixtures(input = fixtures) {
  const results = (input.fixtures || []).map(runFixture);
  const passed = results.filter(row => row.status === 'pass').length;
  return {
    schema_version: 'rule-fixtures-report.v1',
    generated_at: new Date().toISOString(),
    rules_version: input.rules_version || 'normative-rule-model.v1',
    source_refs: input.source_refs || [],
    engine_status: input.engine_status || 'not_run',
    summary: { total: results.length, passed, failed: results.length - passed, ok: passed === results.length },
    fixtures: results,
    audit_policy: 'Normative fixture pass does not imply engine agreement; dynamic engine evidence must reference fixture_id and remain separate.',
  };
}

export async function writeRuleFixtureReport({ output = join(defaultRuntime, 'reports', 'rule-fixtures.v1.json'), input = fixtures } = {}) {
  const report = runRuleFixtures(input);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const output = resolve(process.env.XB_RULE_FIXTURES_OUT || join(resolve(process.env.XB_RUNTIME_DIR || defaultRuntime), 'reports', 'rule-fixtures.v1.json'));
    const report = await writeRuleFixtureReport({ output });
    console.log(JSON.stringify(report.summary, null, 2));
    console.log(`[rule-fixtures] ${output}`);
    if (!report.summary.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`[rule-fixtures] ${error.message}`);
    process.exitCode = 1;
  }
}
