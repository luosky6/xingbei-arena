// 分级 baseline/smoke runner。
//
// B0.8 的入口只编排已经验证过的 selfplay runner：每一批使用独立前缀和
// 种子区间，完成后立即核对 result/trajectory 数量与轨迹完整性，并把引擎
// 指纹、配置和失败种子写成一个可审计报告。它不会改写 noname_xingbei。
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineFingerprint, inspectEngine, resolveEngineRoot } from './engine.mjs';
import { validateTrajectoryFile } from './validate-trajectory.mjs';
import { getRuleProfile, validateSetup } from '../rules/adjudicator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ARENA_ROOT = resolve(here, '..');
export const RUNTIME_ROOT = resolve(process.env.XB_RUNTIME_DIR || join(ARENA_ROOT, 'runtime'));
const MATCH_DIR = join(RUNTIME_ROOT, 'matches');
const TRAJECTORY_DIR = join(RUNTIME_ROOT, 'trajectories');
const REPORT_DIR = join(RUNTIME_ROOT, 'reports');

export function parseList(value, fallback) {
  const values = String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
  return values.length ? values : [...fallback];
}

export function parsePositiveIntegers(value, fallback = [1, 20, 100]) {
  const values = parseList(value, fallback).map(item => Number(item));
  if (!values.length || values.some(item => !Number.isInteger(item) || item <= 0)) {
    throw new RangeError(`baseline batches must be positive integers: ${value}`);
  }
  return values;
}

export function resultFilesForPrefix(names, prefix) {
  return names.filter(name => name.startsWith(`${prefix}_`) && name.endsWith('.jsonl')).sort();
}

/**
 * Return the seed ids that need a retry after a batch has been inspected.
 * Missing result/trajectory files and explicit error/timeout records are kept
 * separate from the original batch so a recovery can never hide evidence of
 * a flaky run.
 */
export function retrySeedsForArtifacts(artifacts, { seedStart = 0, expected = 0 } = {}) {
  const seeds = new Set();
  for (const seed of artifacts?.failed_seeds || []) if (Number.isInteger(seed)) seeds.add(seed);
  const parseId = value => {
    const match = String(value || '').match(/_(\d+)$/);
    return match ? Number(match[1]) : NaN;
  };
  for (const id of [...(artifacts?.missing_result_ids || []), ...(artifacts?.missing_trajectory_ids || [])]) {
    const seed = parseId(id);
    if (Number.isInteger(seed)) seeds.add(seed);
  }
  return [...seeds].filter(seed => seed >= Number(seedStart) && seed < Number(seedStart) + Number(expected)).sort((a, b) => a - b);
}

export function parseResultFile(text, path) {
  const values = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value?.type === 'result') values.push({ ...value, _line: index + 1, _path: path });
    } catch (error) {
      values.push({ type: 'result', status: 'error', ok: false, error: `invalid JSON at line ${index + 1}: ${error.message}`, _line: index + 1, _path: path });
    }
  }
  return values;
}

export async function inspectBatchArtifacts({ prefix, expected, seedStart = 0, mode, runtimeDir = RUNTIME_ROOT } = {}) {
  const matchDir = join(runtimeDir, 'matches');
  const trajectoryDir = join(runtimeDir, 'trajectories');
  const matchNames = await readdir(matchDir).catch(() => []);
  const trajectoryNames = await readdir(trajectoryDir).catch(() => []);
  const resultPaths = resultFilesForPrefix(matchNames, prefix).map(name => join(matchDir, name));
  const results = [];
  for (const path of resultPaths) {
    const text = await readFile(path, 'utf8').catch(error => `{"type":"result","status":"error","ok":false,"error":${JSON.stringify(error.message)}}`);
    results.push(...parseResultFile(text, path));
  }
  const trajectoryPaths = resultFilesForPrefix(trajectoryNames, prefix).map(name => join(trajectoryDir, name));
  const trajectoryChecks = [];
  for (const path of trajectoryPaths) {
    try {
      trajectoryChecks.push({ path, ...(await validateTrajectoryFile(path)) });
    } catch (error) {
      trajectoryChecks.push({ path, ok: false, error: String(error?.message || error) });
    }
  }
  const successfulResults = results.filter(result => result.status !== 'error' && result.status !== 'timeout' && result.ok !== false);
  const failures = results.filter(result => result.status === 'error' || result.status === 'timeout' || result.ok === false);
  const expectedIds = new Set(Array.from({ length: expected }, (_, index) => `${prefix}_${String(Number(seedStart) + index).padStart(6, '0')}`));
  const resultIds = new Set(results.map(result => result.match_id).filter(Boolean));
  const missingIds = [...expectedIds].filter(id => !resultIds.has(id));
  const validTrajectories = trajectoryChecks.filter(item => item.ok && item.dropped_count === 0);
  const missingTrajectories = [...expectedIds].filter(id => !trajectoryChecks.some(item => item.match_id === id));
  return {
    mode,
    prefix,
    expected,
    result_files: resultPaths.length,
    result_records: results.length,
    trajectory_files: trajectoryPaths.length,
    valid_trajectory_files: validTrajectories.length,
    failed_results: failures.length,
    missing_result_ids: missingIds,
    missing_trajectory_ids: missingTrajectories,
    trajectory_errors: trajectoryChecks.filter(item => !item.ok).map(item => ({ path: item.path, error: item.error })),
    failed_seeds: failures.map(result => result.seed).filter(seed => Number.isInteger(seed)),
    winner_counts: successfulResults.reduce((counts, result) => {
      if (result.winner_side === 'red' || result.winner_side === 'blue') counts[result.winner_side]++;
      return counts;
    }, { red: 0, blue: 0 }),
    result_paths: resultPaths.map(path => basename(path)),
    trajectory_paths: trajectoryPaths.map(path => basename(path)),
    ok: results.length === expected && resultPaths.length === expected && trajectoryPaths.length === expected && failures.length === 0 && validTrajectories.length === expected && missingIds.length === 0 && missingTrajectories.length === 0,
  };
}

function runNode(script, env) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [script], { cwd: ARENA_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolvePromise({ code: null, signal: null, stdout, stderr, error: String(error) }));
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

export async function runBaseline({ batches = [1, 20, 100], modes = ['three'], seed = 10000, prefix = `baseline_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`, timeoutMs = 120000, retries = 0, runtimeDir = RUNTIME_ROOT } = {}) {
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError(`baseline retries must be a non-negative integer: ${retries}`);
  const engineRoot = resolveEngineRoot();
  const inspection = await inspectEngine(engineRoot);
  if (!inspection.ready) throw new Error(`engine checkout is incomplete: ${inspection.files.filter(item => !item.exists).map(item => item.file).join(', ')}`);
  const fingerprint = await engineFingerprint(engineRoot);
  await Promise.all([mkdir(join(runtimeDir, 'matches'), { recursive: true }), mkdir(join(runtimeDir, 'trajectories'), { recursive: true }), mkdir(join(runtimeDir, 'reports'), { recursive: true })]);
  const report = {
    schema_version: 'baseline.v1',
    started_at: new Date().toISOString(),
    runtime_dir: runtimeDir,
    engine_root: engineRoot,
    engine_fingerprint: fingerprint,
    batches: [],
    ok: true,
  };
  let seedCursor = Number(seed);
  for (const mode of modes) {
    const rulesProfile = mode === 'four' ? 'supplement-8p' : 'core-10th';
    const rules = validateSetup({ players: ({ two: 4, three: 6, four: 8 })[mode], profile: rulesProfile });
    // Each size/mode gets a disjoint seed range and prefix; rerunning a failed
    // batch therefore cannot silently combine records from a different batch.
    for (const count of batches) {
      const batchPrefix = `${prefix}_${mode}_${count}`;
      const batchSeed = seedCursor;
      seedCursor += count;
      const env = {
        ...process.env,
        XB_MATCHES: String(count),
        XB_MODE: mode,
        XB_SEED: String(batchSeed),
        XB_MATCH_PREFIX: batchPrefix,
        XB_MATCH_TIMEOUT_MS: String(timeoutMs),
        XB_OVERLAY: '',
        XB_OVERLAY_SIDE: 'both',
        XB_MODERN_UI: '',
        XB_RANDOM: '',
        XB_TEAM_A: '',
        XB_TEAM_B: '',
        XB_RUNTIME_DIR: runtimeDir,
      };
      const started = Date.now();
      const child = await runNode(join(ARENA_ROOT, 'bridge', 'selfplay.mjs'), env);
      const artifacts = await inspectBatchArtifacts({ prefix: batchPrefix, expected: count, seedStart: batchSeed, mode, runtimeDir });
      const retryRuns = [];
      const retrySeeds = retries > 0 ? retrySeedsForArtifacts(artifacts, { seedStart: batchSeed, expected: count }) : [];
      const recoveredIds = [];
      for (const retrySeed of retrySeeds) {
        let recovered = false;
        let lastRun = null;
        for (let attempt = 1; attempt <= retries; attempt++) {
          const retryPrefix = `${batchPrefix}_retry${attempt}_${String(retrySeed).padStart(6, '0')}`;
          const retryEnv = { ...env, XB_MATCHES: '1', XB_SEED: String(retrySeed), XB_MATCH_PREFIX: retryPrefix };
          const retryStarted = Date.now();
          const retryChild = await runNode(join(ARENA_ROOT, 'bridge', 'selfplay.mjs'), retryEnv);
          const retryArtifacts = await inspectBatchArtifacts({ prefix: retryPrefix, expected: 1, seedStart: retrySeed, mode, runtimeDir });
          lastRun = { attempt, prefix: retryPrefix, seed: retrySeed, child_exit_code: retryChild.code, child_signal: retryChild.signal, elapsed_ms: Date.now() - retryStarted, artifacts: retryArtifacts, stderr_tail: retryChild.stderr.slice(-1000) };
          retryRuns.push(lastRun);
          if (retryChild.code === 0 && retryArtifacts.ok) { lastRun.recovered = true; recovered = true; break; }
        }
        if (recovered) recoveredIds.push(`${batchPrefix}_${String(retrySeed).padStart(6, '0')}`);
        else if (lastRun) lastRun.recovered = false;
      }
      const recoveredAll = retrySeeds.length > 0 && retrySeeds.every(seed => retryRuns.some(run => run.seed === seed && run.recovered === true));
      const item = {
        batch: count,
        mode,
        prefix: batchPrefix,
        seed_start: batchSeed,
        seed_end: batchSeed + count - 1,
        timeout_ms: timeoutMs,
        rules_profile: rulesProfile,
        initial_morale: rules.morale,
        child_exit_code: child.code,
        child_signal: child.signal,
        elapsed_ms: Date.now() - started,
        stdout_tail: child.stdout.slice(-4000),
        stderr_tail: child.stderr.slice(-4000),
        artifacts,
        strict_ok: child.code === 0 && artifacts.ok,
        retries_requested: retries,
        retry_seeds: retrySeeds,
        recovered_ids: recoveredIds,
        retry_runs: retryRuns,
        ok: child.code === 0 && artifacts.ok || recoveredAll,
      };
      report.batches.push(item);
      if (!item.ok) report.ok = false;
      console.log(`[baseline] ${mode} n=${count} ${item.ok ? 'OK' : 'FAILED'} results=${artifacts.result_records}/${count} trajectories=${artifacts.valid_trajectory_files}/${count}`);
    }
  }
  report.finished_at = new Date().toISOString();
  const reportPath = join(runtimeDir, 'reports', `${prefix}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`[baseline] report ${reportPath}`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const batches = parsePositiveIntegers(process.env.XB_BASELINE_BATCHES, [1, 20, 100]);
    const modes = parseList(process.env.XB_BASELINE_MODES, [process.env.XB_MODE || 'three']);
    const invalid = modes.filter(mode => !['two', 'three', 'four'].includes(mode));
    if (invalid.length) throw new RangeError(`XB_BASELINE_MODES must contain only two,three,four: ${invalid.join(',')}`);
    await runBaseline({ batches, modes, seed: Number(process.env.XB_BASELINE_SEED || 10000), prefix: process.env.XB_BASELINE_PREFIX, timeoutMs: Number(process.env.XB_BASELINE_TIMEOUT_MS || 120000), retries: Number(process.env.XB_BASELINE_RETRIES || 0) });
  } catch (error) {
    console.error(`[baseline] ${error.message}`);
    process.exitCode = 1;
  }
}
