import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSkill, parseFrontmatter } from '../bridge/validate-distillation.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('distillation frontmatter parser preserves explicit metadata and evidence scalars', () => {
  const parsed = parseFrontmatter(`---\nid: tactics/example\nstatus: hypothesis\nconfidence: 0.4\nevidence: { samples: 12, win_rate: 0.5, source: "selfplay" }\nsource_matches: []\nupdated: 2026-09-04\n---\n\n## 适用\n2v2\n`);
  assert.equal(parsed.present, true);
  assert.equal(parsed.fields.id, 'tactics/example');
  assert.equal(parsed.fields.confidence, 0.4);
  assert.equal(parsed.fields.evidence.samples, 12);
  assert.equal(parsed.fields.evidence.win_rate, 0.5);
});

test('hypothesis skill is auditable but never promotion-ready from static evidence', () => {
  const file = join(root, 'skills', 'tactics', 'chain-action-rush.md');
  return readFile(file, 'utf8').then(text => {
    const result = auditSkill(file, text);
    assert.equal(result.status, 'hypothesis');
    assert.equal(result.checks.promotion_ready, false);
    assert.ok(result.promotion_gaps.includes('source_matches'));
    assert.ok(result.promotion_gaps.includes('dynamic_fixture_ids'));
  });
});

test('unsupported verified claims fail metadata validation without freezing the research backlog', () => {
  const result = auditSkill(join(root, 'skills', 'tactics', 'example.md'), `---\nid: tactics/example\nstatus: verified\nconfidence: 0.9\nevidence: { source: "static-code-analysis" }\nupdated: 2026-09-04\n---\n## 适用\n测试\n`);
  assert.ok(result.issues.includes('verified_requires_at_least_300_samples'));
  assert.ok(result.issues.includes('verified_requires_ablation'));
  assert.equal(result.checks.metadata_ready, false);
  assert.equal(result.checks.promotion_ready, false);
});
