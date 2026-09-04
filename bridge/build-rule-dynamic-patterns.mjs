// Audit parent/child and sequence patterns in engine trajectories.
// Structural observations are not semantic proof; every pattern remains
// `not_verified` until a fixture_id-linked, manually reviewed scenario passes.
import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const defaultRuntime = resolve(here, '..', 'runtime');

export const PATTERN_NAMES = Object.freeze([
  'damage_to_draw_same_parent',
  'damage_response_stage_order',
  'use_card_to_damage_child',
  'bao_pai_nested_after_use_card',
  'resource_purchase_path',
  'resource_synthesize_path',
  'resource_refine_path',
]);

function eventRows(records) {
  return records.filter(record => typeof record?.event_id === 'string' && typeof record?.event?.name === 'string');
}

function uniqueEvents(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.event_id)) map.set(row.event_id, []);
    map.get(row.event_id).push(row);
  }
  return map;
}

function firstByKind(rows, kind) { return rows.find(row => row.kind === kind) || rows[0] || null; }

export function analyzeTrajectory(records) {
  const rows = eventRows(records);
  const byId = uniqueEvents(rows);
  const parent = new Map([...byId.entries()].map(([id, values]) => [id, values.find(row => row.parent_event_id)?.parent_event_id || null]));
  const children = new Map();
  for (const row of rows) {
    if (!row.parent_event_id) continue;
    if (!children.has(row.parent_event_id)) children.set(row.parent_event_id, new Set());
    children.get(row.parent_event_id).add(row.event_id);
  }
  const names = id => [...(byId.get(id) || [])].map(row => row.event?.name).filter(Boolean);
  const first = id => firstByKind(byId.get(id) || [], 'event_start');
  const isDescendant = (id, ancestor) => {
    const seen = new Set();
    let current = id;
    while (current && !seen.has(current)) {
      if (current === ancestor) return true;
      seen.add(current);
      current = parent.get(current) || null;
    }
    return false;
  };
  const examples = Object.fromEntries(PATTERN_NAMES.map(name => [name, []]));
  const counts = Object.fromEntries(PATTERN_NAMES.map(name => [name, 0]));
  const passes = Object.fromEntries(PATTERN_NAMES.map(name => [name, 0]));
  const add = (name, value) => {
    counts[name]++;
    if (value?.ordered !== false && value?.both_observed !== false) passes[name]++;
    if (examples[name].length < 8) examples[name].push(value);
  };
  for (const [damageId, damageRows] of byId) {
    if (!names(damageId).includes('damage')) continue;
    const damageStart = first(damageId);
    const childIds = [...(children.get(damageId) || [])];
    const drawId = childIds.find(id => names(id).includes('draw'));
    if (drawId) {
      const drawStart = first(drawId);
      const drawFinish = firstByKind(byId.get(drawId) || [], 'event_finish');
      const damageFinish = firstByKind(damageRows, 'event_finish');
      const ordered = !!damageStart && !!drawStart && !!drawFinish && !!damageFinish
        && damageStart.seq < drawStart.seq && drawStart.seq <= drawFinish.seq && drawFinish.seq < damageFinish.seq;
      add('damage_to_draw_same_parent', { damage_event_id: damageId, draw_event_id: drawId, ordered, damage_seq: damageStart?.seq ?? null, draw_seq: drawStart?.seq ?? null, draw_finish_seq: drawFinish?.seq ?? null, damage_finish_seq: damageFinish?.seq ?? null });
    }
    const triggerIds = childIds.filter(id => names(id).includes('arrangeTrigger'));
    const triggerRows = triggerIds.map(id => first(id)).filter(Boolean);
    const created = triggerRows.find(row => row.event?.triggername === 'zaoChengShangHai');
    const received = triggerRows.find(row => row.event?.triggername === 'chengShouShangHaiAfter');
    if (created || received) add('damage_response_stage_order', { damage_event_id: damageId, created_seq: created?.seq ?? null, received_seq: received?.seq ?? null, both_observed: !!created && !!received, ordered: !!created && !!received && created.seq < received.seq });
  }
  for (const [useId, useRows] of byId) {
    if (!names(useId).includes('useCard')) continue;
    const damageId = [...byId.keys()].find(id => id !== useId && names(id).includes('damage') && isDescendant(id, useId));
    if (damageId) add('use_card_to_damage_child', { use_card_event_id: useId, damage_event_id: damageId, use_seq: first(useId)?.seq ?? null, damage_seq: first(damageId)?.seq ?? null, ordered: (first(useId)?.seq ?? Infinity) < (first(damageId)?.seq ?? -Infinity) });
    const baoPaiId = [...byId.keys()].find(id => id !== useId && names(id).includes('_baoPai') && isDescendant(id, useId));
    if (baoPaiId) add('bao_pai_nested_after_use_card', { use_card_event_id: useId, bao_pai_event_id: baoPaiId, use_seq: first(useId)?.seq ?? null, bao_pai_seq: first(baoPaiId)?.seq ?? null, ordered: (first(useId)?.seq ?? Infinity) < (first(baoPaiId)?.seq ?? -Infinity) });
  }
  for (const [id, values] of byId) {
    const name = values[0]?.event?.name;
    const pattern = name === '_gouMai' ? 'resource_purchase_path' : name === '_heCheng_backup' ? 'resource_synthesize_path' : name === '_tiLian_backup' ? 'resource_refine_path' : null;
    if (pattern) add(pattern, { event_id: id, seq: first(id)?.seq ?? null });
  }
  return { counts, passes, examples };
}

export function summarizeDynamicPatterns(trajectories = []) {
  const totals = Object.fromEntries(PATTERN_NAMES.map(name => [name, 0]));
  const passingTotals = Object.fromEntries(PATTERN_NAMES.map(name => [name, 0]));
  const examples = Object.fromEntries(PATTERN_NAMES.map(name => [name, []]));
  const observedMatches = Object.fromEntries(PATTERN_NAMES.map(name => [name, new Set()]));
  for (const trajectory of trajectories) {
    const matchId = trajectory.match_id || 'unknown';
    const result = analyzeTrajectory(trajectory.records || []);
    for (const name of PATTERN_NAMES) {
      totals[name] += result.counts[name];
      passingTotals[name] += result.passes[name];
      if (result.counts[name]) observedMatches[name].add(matchId);
      if (examples[name].length < 20) examples[name].push(...result.examples[name].slice(0, 20 - examples[name].length).map(example => ({ match_id: matchId, ...example })));
    }
  }
  const patterns = Object.fromEntries(PATTERN_NAMES.map(name => [name, { status: totals[name] ? 'observed_partial' : 'unobserved', semantic_status: 'not_verified', evidence_count: totals[name], passing_evidence_count: passingTotals[name], match_count: observedMatches[name].size, examples: examples[name] }]));
  return { schema_version: 'rule-dynamic-patterns.v1', source_tier: 'engine_implementation', source_refs: ['engine', 'official-timeline-v25', 'xingbei-10th-anniversary-manual'], patterns, summary: { trajectory_files: trajectories.length, patterns: PATTERN_NAMES.length, observed_patterns: Object.values(patterns).filter(pattern => pattern.status === 'observed_partial').length, fully_verified: false }, audit_policy: 'Parent/child and sequence observations identify dynamic fixture candidates; they do not prove card semantics, target legality, timing meaning, or outcome correctness.' };
}

async function loadTrajectories(dir, matchPrefix = '') {
  const output = [];
  const names = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && (!matchPrefix || entry.name.startsWith(matchPrefix)))
    .map(entry => entry.name);
  for (const name of names) {
    const records = [];
    const input = createInterface({ input: createReadStream(join(dir, name), { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of input) { if (!line.trim()) continue; try { records.push(JSON.parse(line)); } catch {} }
    const meta = records.find(record => record.type === 'trajectory_meta');
    output.push({ match_id: meta?.match_id || name.replace(/\.jsonl$/, ''), records });
  }
  return output;
}

export async function buildDynamicPatternReport({ trajectoryDir = join(defaultRuntime, 'trajectories'), output = join(defaultRuntime, 'reports', 'rule-dynamic-patterns.v1.json'), matchPrefix = '' } = {}) {
  const report = summarizeDynamicPatterns(await loadTrajectories(trajectoryDir, matchPrefix));
  report.scope = { match_prefix: matchPrefix || null };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const runtime = resolve(process.env.XB_RUNTIME_DIR || defaultRuntime);
    const output = resolve(process.env.XB_RULE_DYNAMIC_PATTERNS_OUT || join(runtime, 'reports', 'rule-dynamic-patterns.v1.json'));
    const matchPrefix = process.env.XB_MATCH_PREFIX || '';
    const report = await buildDynamicPatternReport({ trajectoryDir: process.env.XB_TRAJECTORY_DIR || join(runtime, 'trajectories'), output, matchPrefix });
    console.log(JSON.stringify(report.summary, null, 2));
    console.log(`[rule-dynamic-patterns] ${output}`);
  } catch (error) { console.error(`[rule-dynamic-patterns] ${error.message}`); process.exitCode = 1; }
}
