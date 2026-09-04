// Evaluate the AI/rules convergence contract from persisted evidence.
// This is a gate/report only: it never promotes a policy, edits rules, or
// treats a normative fixture pass as dynamic engine agreement.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const defaultRuntime = resolve(here, '..', 'runtime');

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

function check(name, ok, observed, required, blocker) {
  return { name, ok: !!ok, observed, required, blocker: ok ? null : blocker };
}

export function evaluateConvergence({ fixtureReport = null, dynamicFixtureReport = null, coverageReport = null, manifest = null, splitManifest = null, gateReport = null, eventEvidence = null, dynamicPatterns = null, modelReport = null, distillationAudit = null, thresholds = {} } = {}) {
  const minLabeledRows = Number.isInteger(thresholds.minLabeledRows) ? thresholds.minLabeledRows : 300;
  const minGroups = Number.isInteger(thresholds.minGroups) ? thresholds.minGroups : 3;
  const fixtureOk = fixtureReport?.summary?.ok === true;
  const dynamicRulesOk = fixtureReport?.dynamic_engine_status === 'verified' || fixtureReport?.engine_status === 'verified' || dynamicFixtureReport?.summary?.engine_status === 'verified';
  const eventSemanticsOk = eventEvidence?.summary?.fully_verified === true || dynamicFixtureReport?.summary?.event_semantics_verified === true;
  const dynamicPatternsOk = dynamicPatterns?.summary?.fully_verified === true || dynamicFixtureReport?.summary?.pattern_semantics_verified === true;
  const coverageOk = coverageReport?.coverage?.fully_covered === true
    && Number(coverageReport?.audit?.invalid || 0) === 0
    && Number(coverageReport?.audit?.fallback || 0) === 0;
  const strictTrajectories = Number(manifest?.summary?.quarantined_trajectories || 0) === 0;
  const groupValues = ['train', 'valid', 'test'].map(key => splitManifest?.groups?.[key]).filter(Boolean);
  const labeledRows = Number(splitManifest?.labeled_rows || 0);
  const datasetOk = splitManifest?.ready_for_supervised_training === true
    && groupValues.length >= minGroups
    && labeledRows >= minLabeledRows;
  const gateOk = gateReport?.status === 'pass';
  const modelOk = modelReport?.status === 'candidate'
    && Number(modelReport?.data?.train || 0) > 0
    && Number(modelReport?.data?.valid || 0) > 0
    && Number(modelReport?.data?.test || 0) > 0
    && typeof modelReport?.model?.model_hash === 'string';
  const dynamicRuleObservation = dynamicRulesOk ? 'verified' : (fixtureReport?.engine_status || dynamicFixtureReport?.summary?.engine_status || 'not_run');
  const eventObservation = eventEvidence?.summary?.fully_verified === true
    ? eventEvidence.summary
    : dynamicFixtureReport?.summary?.event_semantics_verified === true
      ? { event_semantics_verified: true, source: 'dynamic_fixture_report' }
      : eventEvidence?.summary || 'missing';
  const patternObservation = dynamicPatterns?.summary?.fully_verified === true
    ? dynamicPatterns.summary
    : dynamicFixtureReport?.summary?.pattern_semantics_verified === true
      ? { pattern_semantics_verified: true, source: 'dynamic_fixture_report' }
      : dynamicPatterns?.summary || 'missing';
  const distillationOk = !!distillationAudit && (
    Number(distillationAudit?.summary?.skill_issue_count || 0) === 0
    && Number(distillationAudit?.summary?.confirmed_rules_missing_dynamic_links ?? 1) === 0
  );
  const checks = [
    check('normative_rule_fixtures', fixtureOk, fixtureReport?.summary || null, 'all normative fixtures pass', '规则规范夹具仍有失败案例'),
    check('dynamic_rule_engine_agreement', dynamicRulesOk, dynamicRuleObservation, 'dynamic_engine_status=verified', '规范夹具尚未绑定并验证引擎动态场景'),
    check('rule_event_semantics', eventSemanticsOk, eventObservation, 'event evidence fully_verified=true', '引擎事件仅完成盘点，尚未完成 fixture_id 绑定的语义审校'),
    check('dynamic_event_patterns', dynamicPatternsOk, patternObservation, 'dynamic pattern evidence fully_verified=true', '事件父子/时序仅完成结构盘点，尚未完成动态语义验证'),
    check('trajectory_integrity', strictTrajectories, manifest?.summary || null, 'quarantined_trajectories=0', '仍有隔离/损坏/旧格式轨迹，不能作为严格回放证据'),
    check('decision_coverage_and_legality', coverageOk, { coverage: coverageReport?.coverage || null, audit: coverageReport?.audit || null }, 'fully_covered=true, invalid=0, fallback=0', '决策覆盖或合法性门禁未满足'),
    check('grouped_training_data', datasetOk, { labeled_rows: labeledRows, groups: splitManifest?.groups || null, ready: splitManifest?.ready_for_supervised_training || false }, `>=${minLabeledRows} labeled rows and ${minGroups} non-empty groups`, '训练/验证/测试按整局隔离的数据尚不足'),
    check('learned_v1_offline_sanity', modelOk, modelReport ? { status: modelReport.status, data: modelReport.data, model: modelReport.model } : 'missing', 'candidate with train/valid/test rows and model hash', 'Learned-v1 尚未完成可复现的离线 sanity'),
    check('distillation_contract', distillationOk, distillationAudit?.summary || 'not_run', 'skill metadata valid and no unlinked confirmed rule', 'skill 或规范规则存在越级/缺证据条目'),
    check('challenger_promotion_gate', gateOk, gateReport?.status || 'missing', 'gate status=pass', '尚无满足预注册门禁的挑战者冠军报告'),
  ];
  const blockers = checks.filter(row => !row.ok).map(row => row.blocker);
  return {
    schema_version: 'convergence-report.v1',
    generated_at: new Date().toISOString(),
    status: blockers.length ? 'not_converged' : 'converged',
    checks,
    blockers,
    thresholds: { min_labeled_rows: minLabeledRows, min_groups: minGroups },
    policy: 'This report is an evidence gate. It does not mutate rules, weights, or champion artifacts.',
  };
}

export async function buildConvergenceReport({ runtimeDir = defaultRuntime, output = join(runtimeDir, 'reports', 'convergence.v1.json') } = {}) {
  const manifestPath = process.env.XB_MANIFEST_PATH
    ? resolve(process.env.XB_MANIFEST_PATH)
    : join(runtimeDir, 'manifest.v1.json');
  const report = evaluateConvergence({
    fixtureReport: await readJson(join(runtimeDir, 'reports', 'rule-fixtures.v1.json')).catch(() => null),
    dynamicFixtureReport: await readJson(join(runtimeDir, 'reports', 'rule-dynamic-fixtures.v1.json')).catch(() => null),
    coverageReport: await readJson(join(runtimeDir, 'reports', 'decision-coverage.v1.json')).catch(() => null),
    manifest: await readJson(manifestPath).catch(() => null),
    splitManifest: await readJson(join(runtimeDir, 'datasets', 'ranking-split.v1', 'manifest.json')).catch(() => null),
    eventEvidence: await readJson(join(runtimeDir, 'reports', 'rule-event-evidence.v1.json')).catch(() => null),
    dynamicPatterns: await readJson(join(runtimeDir, 'reports', 'rule-dynamic-patterns.v1.json')).catch(() => null),
    modelReport: await readJson(join(runtimeDir, 'reports', 'learned-v1-sanity.v1.json')).catch(() => null),
    distillationAudit: await readJson(join(runtimeDir, 'reports', 'skill-distillation-audit.v1.json')).catch(() => null),
    gateReport: await readJson(process.env.XB_GATE_REPORT || join(runtimeDir, 'reports', 'gate.v1.json')).catch(() => null),
    thresholds: { minLabeledRows: Number(process.env.XB_MIN_LABELED_ROWS) || 300, minGroups: Number(process.env.XB_MIN_GROUPS) || 3 },
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const runtimeDir = resolve(process.env.XB_RUNTIME_DIR || defaultRuntime);
    const output = resolve(process.env.XB_CONVERGENCE_OUT || join(runtimeDir, 'reports', 'convergence.v1.json'));
    const report = await buildConvergenceReport({ runtimeDir, output });
    console.log(JSON.stringify({ status: report.status, blockers: report.blockers }, null, 2));
    console.log(`[convergence] ${output}`);
    if (report.status !== 'converged') process.exitCode = 2;
  } catch (error) {
    console.error(`[convergence] ${error.message}`);
    process.exitCode = 1;
  }
}
