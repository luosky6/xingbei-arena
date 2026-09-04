// 将 decision.v1 审计转成可训练的 ranking.v1 数据集。
// 只消费桥接已经脱敏的候选特征，不读取页面或引擎私有状态；历史记录中
// 没有行为策略概率时保留 null，绝不伪造探索概率。
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const defaultRuntime = resolve(here, '..', 'runtime');

export function parseJsonLines(text) {
  const values = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line)); } catch {}
  }
  return values;
}

function safeFeatureValue(value, depth = 0) {
  if (depth > 2 || value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 32).map(item => safeFeatureValue(item, depth + 1));
  if (typeof value !== 'object') return null;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    // Candidate features are expected to be public, but keep this guard at the
    // ingestion boundary so a future bridge field cannot leak private state.
    if (/(?:^|_)(?:hand|cards?|private|hidden|identity)(?:$|_)/i.test(key)) continue;
    out[key] = safeFeatureValue(item, depth + 1);
  }
  return out;
}

function publicSide(side) {
  if (side === true || side === 'red') return 'red';
  if (side === false || side === 'blue') return 'blue';
  return null;
}

export function buildRankingRows(audits = [], results = []) {
  const resultByMatch = new Map();
  for (const result of results) {
    if (result?.type !== 'result' || typeof result.match_id !== 'string') continue;
    if (!resultByMatch.has(result.match_id) || resultByMatch.get(result.match_id)?.status !== 'result') resultByMatch.set(result.match_id, result);
  }
  const rows = [];
  const rejected = [];
  for (const audit of audits) {
    if (audit?.type !== 'decision_audit') continue;
    const ids = Array.isArray(audit.candidate_ids) ? audit.candidate_ids.filter(id => typeof id === 'string' && id) : [];
    if (!ids.length || typeof audit.choice !== 'string' || !ids.includes(audit.choice)) {
      rejected.push({ match_id: audit?.match_id || null, decision_id: audit?.decision_id || null, reason: 'missing_or_illegal_choice' });
      continue;
    }
    const winner = resultByMatch.get(audit.match_id);
    const side = publicSide(audit.side);
    const winnerSide = publicSide(winner?.winner_side);
    const outcome = side && winnerSide ? (side === winnerSide ? 1 : -1) : null;
    const candidateFeatures = audit.candidate_features && typeof audit.candidate_features === 'object' ? audit.candidate_features : {};
    const candidateScores = audit.candidate_scores && typeof audit.candidate_scores === 'object' ? audit.candidate_scores : {};
    const candidates = ids.map((id, index) => ({
      id,
      index,
      features: safeFeatureValue(candidateFeatures[id] || {}),
      baseline_score: Number.isFinite(Number(candidateScores[id])) ? Number(candidateScores[id]) : null,
      chosen: id === audit.choice,
    }));
    rows.push({
      schema_version: 'ranking.v1',
      row_id: `${String(audit.match_id)}#${String(audit.decision_id || rows.length)}`,
      match_id: String(audit.match_id),
      rules_version: typeof audit.rules_version === 'string' ? audit.rules_version : null,
      rules_profile: typeof audit.rules_profile === 'string' ? audit.rules_profile : null,
      decision_id: typeof audit.decision_id === 'string' ? audit.decision_id : null,
      decision_type: typeof audit.decision_type === 'string' ? audit.decision_type : 'unknown',
      seat: audit.seat ?? null,
      side,
      candidates,
      label: { chosen_id: audit.choice, outcome },
      behavior: { source: typeof audit.source === 'string' ? audit.source : 'unknown', probability: Number.isFinite(Number(audit.behavior?.choice_probability)) ? Number(audit.behavior.choice_probability) : null, probability_status: audit.behavior?.probability_status || 'not_recorded' },
      provenance: { audit_schema: 'decision.v1', winner_side: winnerSide, engine_fingerprint: winner?.engine_fingerprint || null, policy_id: winner?.policy_id || null },
    });
  }
  return { rows, rejected, outcomes: { with_result: rows.filter(row => row.label.outcome != null).length, without_result: rows.filter(row => row.label.outcome == null).length } };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  const data = await readFile(path);
  hash.update(data);
  return `sha256:${hash.digest('hex')}`;
}

async function loadResults(matchesDir) {
  const names = await readdir(matchesDir, { withFileTypes: true }).catch(() => []);
  const values = [];
  for (const item of names.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))) values.push(...parseJsonLines(await readFile(join(matchesDir, item.name), 'utf8').catch(() => '')));
  return values;
}

export async function buildRankingDataset({ auditPath = join(defaultRuntime, 'decisions', 'events.jsonl'), matchesDir = join(defaultRuntime, 'matches'), output = join(defaultRuntime, 'datasets', 'ranking.v1.jsonl'), manifestOutput = join(defaultRuntime, 'datasets', 'ranking.v1.manifest.json') } = {}) {
  const auditText = await readFile(auditPath, 'utf8').catch(() => '');
  const audits = parseJsonLines(auditText);
  const results = await loadResults(matchesDir);
  const dataset = buildRankingRows(audits, results);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, dataset.rows.map(row => JSON.stringify(row)).join('\n') + (dataset.rows.length ? '\n' : ''));
  const manifest = {
    schema_version: 'ranking-manifest.v1',
    generated_at: new Date().toISOString(),
    dataset_schema: 'ranking.v1',
    output,
    source: { audit_path: auditPath, audit_sha256: await sha256File(auditPath).catch(() => null), matches_dir: matchesDir, result_records: results.filter(value => value?.type === 'result').length },
    rows: dataset.rows.length,
    rejected: dataset.rejected.length,
    outcomes: dataset.outcomes,
    hidden_information_policy: 'Only public candidate_features from decision.v1 are retained; excluded keys are hand/cards/private/hidden/identity.',
    behavior_probability_policy: 'null when the source audit did not record behavior-policy probability; do not infer it from the chosen action.',
  };
  await writeFile(manifestOutput, JSON.stringify(manifest, null, 2) + '\n');
  return { dataset, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const runtime = resolve(process.env.XB_RUNTIME_DIR || defaultRuntime);
    const result = await buildRankingDataset({
      auditPath: process.env.XB_DECISION_AUDIT || join(runtime, 'decisions', 'events.jsonl'),
      matchesDir: process.env.XB_MATCHES_DIR || join(runtime, 'matches'),
      output: process.env.XB_RANKING_OUT || join(runtime, 'datasets', 'ranking.v1.jsonl'),
      manifestOutput: process.env.XB_RANKING_MANIFEST || join(runtime, 'datasets', 'ranking.v1.manifest.json'),
    });
    console.log(JSON.stringify({ rows: result.manifest.rows, rejected: result.manifest.rejected, outcomes: result.manifest.outcomes }, null, 2));
    console.log(`[ranking] ${result.manifest.output}`);
  } catch (error) {
    console.error(`[ranking] ${error.message}`);
    process.exitCode = 1;
  }
}
