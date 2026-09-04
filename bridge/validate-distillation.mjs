import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const skillRoot = join(root, 'skills');
const curatedRuleRoot = join(root, 'knowledge', 'curated', 'rules');
const dynamicFixturePath = join(root, 'rules', 'dynamic-fixtures.v1.json');
const outputPath = join(root, 'runtime', 'reports', 'skill-distillation-audit.v1.json');

const STATUS = new Set(['hypothesis', 'partial', 'verified', 'deprecated']);
const KINDS = new Set(['rules', 'tactics', 'operations', 'meta']);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (extname(entry.name).toLowerCase() === '.md') files.push(full);
  }
  return files.sort();
}

function stripComment(value) {
  return value.replace(/\s+#.*$/, '').trim();
}

function parseScalar(value) {
  const clean = stripComment(value);
  if (clean === 'null' || clean === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(clean)) return Number(clean);
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    return clean.slice(1, -1);
  }
  if (clean.startsWith('[') && clean.endsWith(']')) {
    return [...clean.matchAll(/['"]([^'"]*)['"]/g)].map(match => match[1]);
  }
  return clean;
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { fields: {}, body: text, present: false };
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { fields: {}, body: text, present: false, malformed: true };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!field) continue;
    fields[field[1]] = parseScalar(field[2]);
  }
  const evidenceLine = match[1].split(/\r?\n/).find(line => /^evidence:\s*/.test(line));
  if (evidenceLine) {
    const evidence = {};
    const value = evidenceLine.replace(/^evidence:\s*/, '');
    for (const key of ['samples', 'win_rate', 'source', 'note']) {
      const token = value.match(new RegExp(`${key}\\s*:\\s*(?:["']([^"']*)["']|([-+]?\\d+(?:\\.\\d+)?))`));
      if (token) evidence[key] = token[1] ?? Number(token[2]);
    }
    const source = value.match(/^\{?\s*source\s*:\s*["']?([^,"'}]+)["']?/);
    if (source && evidence.source === undefined) evidence.source = source[1].trim();
    fields.evidence = evidence;
  }
  return { fields, body: match[2], present: true };
}

function hasHeading(body, names) {
  return names.some(name => new RegExp(`^##\\s+.*${name}`, 'm').test(body));
}

function skillKind(file, fields) {
  const id = typeof fields.id === 'string' ? fields.id : '';
  const prefix = id.split('/')[0];
  if (KINDS.has(prefix)) return prefix;
  const rel = relative(skillRoot, file).replaceAll('\\', '/');
  return rel.split('/')[0] || 'unknown';
}

function auditSkill(file, text) {
  const parsed = parseFrontmatter(text);
  const fields = parsed.fields;
  const kind = skillKind(file, fields);
  const status = fields.status;
  const evidence = fields.evidence && typeof fields.evidence === 'object' ? fields.evidence : {};
  const sourceMatches = Array.isArray(fields.source_matches) ? fields.source_matches : [];
  const samples = Number.isFinite(evidence.samples) ? evidence.samples : null;
  const winRate = Number.isFinite(evidence.win_rate) ? evidence.win_rate : null;
  const issues = [];
  const promotionGaps = [];
  if (!parsed.present || parsed.malformed) issues.push('frontmatter_missing_or_malformed');
  if (!fields.id || typeof fields.id !== 'string') issues.push('missing_id');
  if (!STATUS.has(status)) issues.push('invalid_status');
  if (!Number.isFinite(fields.confidence) || fields.confidence < 0 || fields.confidence > 1) issues.push('confidence_must_be_0_to_1');
  if (!fields.updated || typeof fields.updated !== 'string') issues.push('missing_updated');
  if (!Object.keys(evidence).length) issues.push('missing_evidence');
  if (!sourceMatches.length) promotionGaps.push('source_matches');
  if (!Array.isArray(fields.dynamic_fixture_ids) || !fields.dynamic_fixture_ids.length) promotionGaps.push('dynamic_fixture_ids');
  if (!fields.rules_version) promotionGaps.push('rules_version');
  if (kind !== 'rules' && !hasHeading(parsed.body, ['适用', 'Applicable'])) promotionGaps.push('applicable_scope');
  if (!hasHeading(parsed.body, ['反制', '边界', 'Counter'])) promotionGaps.push('counterplay_or_boundaries');
  if (status === 'verified') {
    const minimumSamples = kind === 'rules' ? 0 : kind === 'operations' ? 100 : 300;
    if (minimumSamples && (samples === null || samples < minimumSamples)) issues.push(`verified_requires_at_least_${minimumSamples}_samples`);
    if ((kind === 'tactics' || kind === 'meta') && (winRate === null || winRate < 0 || winRate > 1)) issues.push('verified_requires_win_rate_0_to_1');
    if (kind === 'rules') {
      if (!Array.isArray(fields.source_refs) || !fields.source_refs.length) issues.push('verified_requires_normative_sources');
      if (fields.adjudication_status !== 'confirmed') issues.push('verified_requires_confirmed_adjudication');
      if (!hasHeading(parsed.body, ['负例', '边界'])) issues.push('verified_requires_negative_or_boundary_case');
    }
    if (promotionGaps.length) issues.push(...promotionGaps.map(gap => `verified_missing_${gap}`));
    if (kind === 'tactics' || kind === 'meta') {
      if (!Array.isArray(fields.variants) || fields.variants.length < 2) issues.push('verified_requires_two_variants');
      if (!Array.isArray(fields.seat_layouts) || fields.seat_layouts.length < 2) issues.push('verified_requires_two_seat_layouts');
      if (!Array.isArray(fields.lineups) || fields.lineups.length < 3) issues.push('verified_requires_three_lineups');
      if (!Array.isArray(fields.modes) || fields.modes.length < 2) issues.push('verified_requires_two_modes');
      if (!hasHeading(parsed.body, ['消融', 'Ablation'])) issues.push('verified_requires_ablation');
    }
  }
  return {
    id: fields.id ?? relative(skillRoot, file).replaceAll('\\', '/'),
    path: relative(root, file).replaceAll('\\', '/'),
    kind,
    status: status ?? null,
    confidence: fields.confidence ?? null,
    evidence: { samples, win_rate: winRate, source: evidence.source ?? null },
    source_matches: sourceMatches,
    checks: {
      frontmatter: parsed.present && !parsed.malformed,
      evidence_present: Object.keys(evidence).length > 0,
      metadata_ready: issues.length === 0 && status === 'verified',
      promotion_ready: false,
    },
    promotion_gaps: [...new Set(promotionGaps)],
    issues: [...new Set(issues)],
  };
}

async function auditCuratedRules() {
  const files = (await readdir(curatedRuleRoot, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => join(curatedRuleRoot, entry.name));
  const objects = [];
  for (const file of files) {
    let document;
    try { document = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { objects.push({ path: relative(root, file).replaceAll('\\', '/'), issues: [`invalid_json:${error.message}`] }); continue; }
    for (const rule of document.rules ?? []) {
      const dynamicIds = rule.dynamic_test_ids ?? rule.dynamic_fixture_ids ?? [];
      const issues = [];
      if (!Array.isArray(rule.provenance) && !Array.isArray(rule.source_refs)) issues.push('missing_provenance');
      if (!rule.normative_rule) issues.push('missing_normative_rule');
      if (!rule.engine_behavior) issues.push('missing_engine_behavior');
      if (!rule.difference) issues.push('missing_difference');
      if (!Array.isArray(dynamicIds) || !dynamicIds.length) issues.push('no_dynamic_fixture_link');
      if (rule.adjudication_status === 'confirmed' && issues.length) issues.push('confirmed_without_complete_evidence');
      objects.push({ id: rule.id, path: relative(root, file).replaceAll('\\', '/'), adjudication_status: rule.adjudication_status ?? null, dynamic_fixture_ids: dynamicIds, issues });
    }
  }
  return objects;
}

async function main() {
  const allFiles = await walk(skillRoot);
  // open-questions is an experiment queue, not a promoted skill entry and intentionally
  // has no frontmatter contract of its own.
  const files = allFiles.filter(file => relative(skillRoot, file).replaceAll('\\', '/') !== 'meta/open-questions.md');
  const skills = [];
  for (const file of files) skills.push(auditSkill(file, await readFile(file, 'utf8')));
  const rules = await auditCuratedRules();
  let dynamicFixtureSummary = null;
  try {
    const fixtures = JSON.parse(await readFile(dynamicFixturePath, 'utf8'));
    dynamicFixtureSummary = { total: fixtures.fixtures?.length ?? 0, ids: (fixtures.fixtures ?? []).map(fixture => fixture.fixture_id) };
  } catch { dynamicFixtureSummary = { total: 0, ids: [] }; }
  const statusCounts = Object.fromEntries([...STATUS].map(status => [status, skills.filter(skill => skill.status === status).length]));
  const rulesWithLinks = rules.filter(rule => rule.dynamic_fixture_ids?.length).length;
  const report = {
    schema_version: 'skill-distillation-audit.v1',
    generated_at: new Date().toISOString(),
    contract: 'skills/meta/distillation-contract.v1.json',
    scope: {
      skill_files: files.length,
      planning_files: allFiles.length - files.length,
      curated_rule_files: new Set(rules.map(rule => rule.path)).size,
    },
    summary: {
      skill_count: skills.length,
      status_counts: statusCounts,
      promotion_ready_skills: skills.filter(skill => skill.checks.promotion_ready).length,
      skill_issue_count: skills.filter(skill => skill.issues.length).length,
      curated_rule_count: rules.length,
      curated_rules_with_dynamic_links: rulesWithLinks,
      curated_rules_without_dynamic_links: rules.length - rulesWithLinks,
      curated_confirmed_rules: rules.filter(rule => rule.adjudication_status === 'confirmed').length,
      confirmed_rules_missing_dynamic_links: rules.filter(rule => rule.adjudication_status === 'confirmed' && !rule.dynamic_fixture_ids?.length).length,
      dynamic_fixture_count: dynamicFixtureSummary.total,
      dynamic_fixture_ids: dynamicFixtureSummary.ids,
    },
    skills,
    curated_rules: rules,
    policy: {
      status_meaning: {
        hypothesis: '静态推演或少量样本，禁止作为稳定策略结论',
        partial: '部分条件或部分模式已证实，边界未覆盖',
        verified: '满足契约中样本、跨变体、座次、反制和消融门禁',
        deprecated: '历史产物，仅保留用于追溯，不参与决策',
      },
      dynamic_pass_does_not_imply_normative_confirmation: true,
      rules_require_fixture_id_backlink_before_confirmation: true,
      metadata_checks_do_not_validate_referenced_evidence: true,
    },
  };
  report.report_hash = `sha256:${createHash('sha256').update(JSON.stringify(report)).digest('hex')}`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: relative(root, outputPath).replaceAll('\\', '/'), summary: report.summary }, null, 2));
  // Existing material is intentionally hypothesis/partial. Fail only on malformed metadata or an
  // incorrectly promoted verified item; missing promotion evidence is the expected backlog signal.
  const hardFailures = skills.filter(skill => skill.issues.length);
  if (hardFailures.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();

export { auditSkill, parseFrontmatter };
