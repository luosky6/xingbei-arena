// 决策桥覆盖报告：把真实 trajectory 中出现的决策点与桥接适配器注册表
// 对齐。未知或仅部分支持的 method 必须显式暴露，不能被“自对弈跑完”掩盖。
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineFingerprint, resolveEngineRoot } from './engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const defaultRuntime = resolve(here, '..', 'runtime');

export const DECISION_METHOD_REGISTRY = Object.freeze({
  modeled: Object.freeze(['chooseButton', 'chooseCard', 'chooseTarget', 'chooseControl', 'chooseBool', 'chooseToDiscard', 'chooseCardTarget', 'chooseToMove', 'gongJiOrFaShu', 'gongJi', 'faShu', 'yingZhan', 'moDan', 'qiTa']),
  partial: Object.freeze([]),
});

export function classifyDecisionMethod(method, { selection = null } = {}) {
  const name = String(method || 'unknown');
  if (name === 'chooseCardTarget' && selection?.composition === 'atomic_card_target' && selection.multi_supported === false) return { status: 'partial', category: 'choose', reason: 'multi-card-or-target selection is not atomically adapted' };
  if (name === 'chooseToMove' && selection?.composition !== 'move_assignment') return { status: 'partial', category: 'choose', reason: 'move assignment summary is missing' };
  if (DECISION_METHOD_REGISTRY.modeled.includes(name)) return { status: 'modeled', category: name.startsWith('choose') ? 'choose' : 'action', reason: null };
  if (DECISION_METHOD_REGISTRY.partial.includes(name)) return { status: 'partial', category: 'choose', reason: 'incremental ordered intermediate state is not yet fully adapted' };
  if (/^choose[A-Z]/.test(name)) return { status: 'unmodeled', category: 'choose', reason: 'choose* method is not registered by the decision bridge' };
  return { status: 'unmodeled', category: 'other', reason: 'decision method is not registered by the decision bridge' };
}

export function createCoverageAccumulator() {
  return { files_seen: 0, records_seen: 0, decision_requests: 0, methods: new Map(), modes: new Map(), matches: new Set() };
}

function bump(map, key, amount = 1) {
  if (map instanceof Map) map.set(key, (map.get(key) || 0) + amount);
  else map[key] = (map[key] || 0) + amount;
}

export function addDecisionRecord(accumulator, { method, mode = null, matchId = null, selection = null } = {}) {
  const name = String(method || 'unknown');
  const classification = classifyDecisionMethod(name, { selection });
  accumulator.records_seen++;
  accumulator.decision_requests++;
  accumulator.matches.add(String(matchId || 'unknown'));
  const current = accumulator.methods.get(name) || { method: name, count: 0, ...classification };
  current.count++;
  accumulator.methods.set(name, current);
  if (mode) {
    const modeEntry = accumulator.modes.get(mode) || { mode, decision_requests: 0, methods: new Map() };
    modeEntry.decision_requests++;
    bump(modeEntry.methods, name);
    accumulator.modes.set(mode, modeEntry);
  }
  return classification;
}

export function finalizeCoverage(accumulator, { audit = null } = {}) {
  const methods = [...accumulator.methods.values()].sort((left, right) => right.count - left.count || left.method.localeCompare(right.method));
  const modeled = methods.filter(item => item.status === 'modeled').reduce((sum, item) => sum + item.count, 0);
  const partial = methods.filter(item => item.status === 'partial').reduce((sum, item) => sum + item.count, 0);
  const unmodeled = methods.filter(item => item.status === 'unmodeled').reduce((sum, item) => sum + item.count, 0);
  const total = modeled + partial + unmodeled;
  return {
    decision_requests: total,
    coverage: { modeled, partial, unmodeled, modeled_rate: total ? modeled / total : 1, fully_covered: partial === 0 && unmodeled === 0 },
    methods,
    modes: [...accumulator.modes.values()].sort((left, right) => left.mode.localeCompare(right.mode)).map(item => ({ ...item, methods: Object.fromEntries([...item.methods.entries()].sort()) })),
    matches: [...accumulator.matches].sort(),
    audit: audit || { records: 0, sources: {}, invalid: 0, fallback: 0 },
  };
}

async function trajectoryPaths(directory) {
  const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return names.filter(item => item.isFile() && item.name.endsWith('.jsonl')).map(item => join(directory, item.name)).sort();
}

export async function collectDecisionCoverage({ trajectoryDir = join(defaultRuntime, 'trajectories'), auditPath = join(defaultRuntime, 'decisions', 'events.jsonl') } = {}) {
  const accumulator = createCoverageAccumulator();
  for (const path of await trajectoryPaths(trajectoryDir)) {
    accumulator.files_seen++;
    let mode = null;
    let matchId = null;
    const input = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of input) {
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value.type === 'trajectory_meta') { mode = value.mode || null; matchId = value.match_id || null; continue; }
      if (value.kind !== 'decision_request') continue;
      addDecisionRecord(accumulator, { method: value.decision?.method, mode: mode || value.mode || null, matchId: matchId || value.match_id, selection: value.decision?.option_summary?.selection || null });
    }
  }
  const audit = { records: 0, sources: {}, invalid: 0, fallback: 0 };
  const rawAudit = await readFile(auditPath, 'utf8').catch(() => '');
  for (const line of rawAudit.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value.type !== 'decision_audit') continue;
      audit.records++;
      const source = String(value.source || 'unknown');
      bump(audit.sources, source);
      if (value.valid === false) audit.invalid++;
      if (source === 'fallback') audit.fallback++;
    } catch {}
  }
  return { schema_version: 'decision-coverage.v1', generated_at: new Date().toISOString(), trajectory_dir: trajectoryDir, audit_path: auditPath, files_seen: accumulator.files_seen, records_seen: accumulator.records_seen, ...finalizeCoverage(accumulator, { audit }) };
}

export async function writeDecisionCoverage({ trajectoryDir, auditPath, output } = {}) {
  const report = await collectDecisionCoverage({ trajectoryDir, auditPath });
  const destination = output || join(dirname(trajectoryDir), 'reports', 'decision-coverage.v1.json');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  return { report, destination };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const runtime = resolve(process.env.XB_RUNTIME_DIR || defaultRuntime);
    const { report, destination } = await writeDecisionCoverage({
      trajectoryDir: process.env.XB_TRAJECTORY_DIR || join(runtime, 'trajectories'),
      auditPath: process.env.XB_DECISION_AUDIT || join(runtime, 'decisions', 'events.jsonl'),
      output: process.env.XB_COVERAGE_OUTPUT || join(runtime, 'reports', 'decision-coverage.v1.json'),
    });
    console.log(JSON.stringify({ files_seen: report.files_seen, decision_requests: report.decision_requests, coverage: report.coverage, audit: report.audit }, null, 2));
    console.log(`[decision-coverage] ${destination}`);
    if (process.env.XB_COVERAGE_STRICT && !report.coverage.fully_covered) process.exitCode = 1;
  } catch (error) {
    console.error(`[decision-coverage] ${error.message}`);
    process.exitCode = 1;
  }
}
