// Summarize engine event observations without promoting event names to rules.
// Presence/count/order are dynamic evidence only; semantic adjudication remains
// a separate, manually reviewed fixture concern.
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const defaultRuntime = resolve(here, '..', 'runtime');

export const RULE_EVENT_AREAS = Object.freeze({
  attack_and_response: ['gongJiOrFaShu', 'gongJi', 'faShu', 'yingZhan', '_yingZhan', 'damage'],
  special_combat: ['anMie', 'shengGuang', 'shengDun', 'moDan'],
  hand_and_morale: ['draw', '_baoPai', 'changeShiQi', 'changeZhiLiao'],
  resources_and_cups: ['_gouMai', '_heCheng_backup', '_tiLian_backup', 'changeXingBei', 'changeNengLiang', 'changeZhiShiWu', 'changeZhanJi'],
  timing_responses: ['damage', 'yingZhan', '_yingZhan_weiMingZhong', 'shengGuang', '_shengGuang_weiMingZhong', 'shengDun', '_shengDun'],
});

export function summarizeRuleEvents(records = []) {
  const counts = new Map();
  const files = new Set();
  const targetSequence = [];
  for (const record of records) {
    if (record?.match_id) files.add(record.match_id);
    const name = record?.event?.name;
    if (typeof name !== 'string' || !name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
    if (Object.values(RULE_EVENT_AREAS).some(names => names.includes(name)) && targetSequence.length < 5000) {
      targetSequence.push({ seq: record.seq ?? null, name, kind: record.kind || null, match_id: record.match_id || null });
    }
  }
  const areas = Object.fromEntries(Object.entries(RULE_EVENT_AREAS).map(([area, names]) => {
    const observed = names.filter(name => counts.has(name));
    return [area, {
      status: observed.length ? 'observed_partial' : 'unobserved',
      observed_event_names: observed,
      missing_expected_event_names: names.filter(name => !counts.has(name)),
      event_counts: Object.fromEntries(observed.map(name => [name, counts.get(name)])),
      semantic_assertion: 'not_verified',
    }];
  }));
  return {
    schema_version: 'rule-event-evidence.v1',
    source_tier: 'engine_implementation',
    source_refs: ['engine', 'official-timeline-v25', 'xingbei-10th-anniversary-manual'],
    trajectory_files: files.size,
    event_names: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
    areas,
    target_sequence_sample: targetSequence,
    summary: { areas: Object.keys(areas).length, observed_areas: Object.values(areas).filter(area => area.status === 'observed_partial').length, fully_verified: false },
    audit_policy: 'Event presence/count/order is dynamic observation only. It does not prove card text, timing semantics, target legality, or outcome correctness; each area needs fixture_id-linked scenario review.',
  };
}

async function readRecords(trajectoryDir, matchPrefix = '') {
  const records = [];
  const names = (await readdir(trajectoryDir, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && (!matchPrefix || entry.name.startsWith(matchPrefix)))
    .map(entry => entry.name);
  for (const name of names) {
    const input = createInterface({ input: createReadStream(join(trajectoryDir, name), { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of input) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* malformed files are handled by manifest gate */ }
    }
  }
  return records;
}

export async function buildRuleEventEvidence({ trajectoryDir = join(defaultRuntime, 'trajectories'), output = join(defaultRuntime, 'reports', 'rule-event-evidence.v1.json'), matchPrefix = '' } = {}) {
  const report = summarizeRuleEvents(await readRecords(trajectoryDir, matchPrefix));
  report.scope = { match_prefix: matchPrefix || null };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const runtime = resolve(process.env.XB_RUNTIME_DIR || defaultRuntime);
    const output = resolve(process.env.XB_RULE_EVENT_EVIDENCE_OUT || join(runtime, 'reports', 'rule-event-evidence.v1.json'));
    const matchPrefix = process.env.XB_MATCH_PREFIX || '';
    const report = await buildRuleEventEvidence({ trajectoryDir: process.env.XB_TRAJECTORY_DIR || join(runtime, 'trajectories'), output, matchPrefix });
    console.log(JSON.stringify({ trajectory_files: report.trajectory_files, event_names: Object.keys(report.event_names).length, areas: report.summary }, null, 2));
    console.log(`[rule-event-evidence] ${output}`);
  } catch (error) {
    console.error(`[rule-event-evidence] ${error.message}`);
    process.exitCode = 1;
  }
}
