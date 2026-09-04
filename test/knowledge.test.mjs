import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectEngine, resolveEngineRoot } from '../bridge/engine.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const generated = join(root, 'knowledge', 'generated');

test('engine root resolves to a complete read-only checkout', async () => {
  const report = await inspectEngine(resolveEngineRoot());
  assert.equal(report.ready, true, JSON.stringify(report));
});

test('generated knowledge has four-layer governance fields', async () => {
  const rules = JSON.parse(await readFile(join(generated, 'rules.json'), 'utf8'));
  const timings = JSON.parse(await readFile(join(generated, 'timings.json'), 'utf8'));
  const coverage = JSON.parse(await readFile(join(generated, 'coverage.json'), 'utf8'));
  assert.ok(rules.objects.length >= 1);
  assert.ok(timings.stage_definitions.some(item => item.stage === '①'));
  assert.ok(coverage.objects.characters.total >= 1);
  for (const rule of rules.objects) {
    assert.equal(typeof rule.normative_rule, 'object');
    assert.equal(typeof rule.engine_behavior, 'object');
    assert.equal(typeof rule.difference, 'object');
    assert.equal(rule.adjudication_status, 'needs_dynamic_test');
  }
});

test('curated rules retain normative statements and official supplement provenance', async () => {
  const curated = JSON.parse(await readFile(join(root, 'knowledge', 'curated', 'rules', 'rule-ontology-draft.json'), 'utf8'));
  const sources = JSON.parse(await readFile(join(generated, 'sources.json'), 'utf8'));
  assert.equal(curated.governance, 'normative_rule + engine_implementation + difference + adjudication_status');
  assert.ok(curated.rules.length >= 10);
  assert.ok(curated.rules.every(rule => typeof rule.normative_rule === 'string' && rule.normative_rule.length > 20));
  assert.ok(curated.rules.every(rule => rule.adjudication_status === 'needs_dynamic_test' || rule.adjudication_status === 'confirmed'));
  assert.ok(sources.sources.some(source => source.source_id === 'official-qa-and-supplements' && source.source_tier === 'normative_rule'));
  assert.ok(sources.sources.some(source => source.source_id === 'official-no-action-v25.4.5'));
});

test('trajectory schema exposes all ingestion envelope kinds', async () => {
  const schema = JSON.parse(await readFile(join(root, 'knowledge', 'schema', 'trajectory.schema.json'), 'utf8'));
  const refs = schema.oneOf.map(item => item.$ref);
  assert.ok(refs.includes('#/$defs/trajectoryMeta'));
  assert.ok(refs.includes('#/$defs/trajectoryRecord'));
  assert.ok(refs.includes('#/$defs/matchResult'));
  assert.ok(refs.includes('#/$defs/violation'));
  assert.deepEqual(schema.$defs.trajectoryRecord.required.slice(0, 2), ['schema_version', 'match_id']);
  assert.ok(schema.$defs.commonMetadata.properties.rules_profile);
});

test('decision audit schema keeps strategy provenance separate from trajectory events', async () => {
  const schema = JSON.parse(await readFile(join(root, 'knowledge', 'schema', 'decision.schema.json'), 'utf8'));
  assert.equal(schema.properties.type.const, 'decision_audit');
  assert.equal(schema.properties.schema_version.const, 'decision.v1');
  assert.ok(schema.properties.candidate_features);
  assert.ok(schema.properties.latency_ms);
  assert.ok(schema.properties.response);
  assert.ok(schema.properties.behavior.properties.choice_probability);
});

test('ranking schema requires explicit label and behavior-probability provenance', async () => {
  const schema = JSON.parse(await readFile(join(root, 'knowledge', 'schema', 'ranking.schema.json'), 'utf8'));
  assert.equal(schema.properties.schema_version.const, 'ranking.v1');
  assert.ok(schema.required.includes('candidates'));
  assert.ok(schema.properties.behavior.properties.probability);
  assert.ok(schema.properties.provenance.properties.audit_schema);
});

test('ranking split manifest schema enforces grouped partitions and readiness flag', async () => {
  const schema = JSON.parse(await readFile(join(root, 'knowledge', 'schema', 'ranking-split-manifest.schema.json'), 'utf8'));
  assert.equal(schema.properties.schema_version.const, 'ranking-split-manifest.v1');
  assert.ok(schema.required.includes('groups'));
  assert.ok(schema.required.includes('ready_for_supervised_training'));
});

test('seating schema keeps physical seat and engine index distinct', async () => {
  const schema = JSON.parse(await readFile(join(root, 'knowledge', 'schema', 'seating.schema.json'), 'utf8'));
  assert.equal(schema.properties.schema_version.const, 'seating.v1');
  assert.ok(schema.properties.engine_seat_num_by_seat);
  assert.ok(schema.properties.turn_order_from_first_act);
  assert.ok(schema.properties.draft_pick_order);
});
