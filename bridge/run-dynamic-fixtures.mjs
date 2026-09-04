// Execute fixture_id-linked assertions against recorded engine trajectories.
// These checks verify observable parent/child/order and event coverage facts;
// they do not replace card-text or target-legality review from the manual.
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fixtures from '../rules/dynamic-fixtures.v1.json' with { type: 'json' };
import { analyzeTrajectory } from './build-rule-dynamic-patterns.mjs';
import { RULE_EVENT_AREAS } from './build-rule-event-evidence.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const defaultRuntime = resolve(here, '..', 'runtime');

async function loadTrajectories(dir, prefix = '') {
  const output = [];
  const names = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && (!prefix || entry.name.startsWith(prefix)))
    .map(entry => entry.name);
  for (const name of names) {
    const records = [];
    const input = createInterface({ input: createReadStream(join(dir, name), { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of input) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* manifest gate handles malformed files */ }
    }
    const meta = records.find(record => record.type === 'trajectory_meta');
    output.push({ match_id: meta?.match_id || name.replace(/\.jsonl$/, ''), rules_profile: meta?.rules_profile || null, records });
  }
  return output;
}

function eventCounts(trajectories) {
  const counts = {};
  const matches = {};
  for (const trajectory of trajectories) {
    const seen = new Set();
    for (const record of trajectory.records) {
      const name = record?.event?.name;
      if (typeof name !== 'string' || !name) continue;
      counts[name] = (counts[name] || 0) + 1;
      seen.add(name);
    }
    for (const name of seen) matches[name] = (matches[name] || 0) + 1;
  }
  return { counts, matches };
}

async function streamEventCounts(dir, prefix = '') {
  const counts = {};
  const matches = {};
  let trajectoryFiles = 0;
  const names = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && (!prefix || entry.name.startsWith(prefix)))
    .map(entry => entry.name);
  for (const name of names) {
    trajectoryFiles++;
    const seen = new Set();
    const input = createInterface({ input: createReadStream(join(dir, name), { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of input) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const eventName = record?.event?.name;
      if (typeof eventName !== 'string' || !eventName) continue;
      counts[eventName] = (counts[eventName] || 0) + 1;
      seen.add(eventName);
    }
    for (const eventName of seen) matches[eventName] = (matches[eventName] || 0) + 1;
  }
  return { counts, matches, trajectory_files: trajectoryFiles };
}

function runPatternFixture(fixture, analyses) {
  const rows = analyses.map(item => ({ match_id: item.match_id, ...item.analysis }));
  const evidence = rows.reduce((sum, row) => sum + Number(row.counts?.[fixture.pattern] || 0), 0);
  const passing = rows.reduce((sum, row) => sum + Number(row.passes?.[fixture.pattern] || 0), 0);
  const matches = rows.filter(row => Number(row.counts?.[fixture.pattern] || 0) > 0).map(row => row.match_id);
  const passRate = evidence ? passing / evidence : 0;
  const status = evidence >= (fixture.minimum_evidence || 1)
    && passing >= (fixture.minimum_evidence || 1)
    && matches.length >= (fixture.minimum_matches || 1)
    && passRate >= Number(fixture.minimum_pass_rate ?? 1) ? 'pass' : 'fail';
  return { fixture_id: fixture.fixture_id, kind: fixture.kind, pattern: fixture.pattern, status, evidence_count: evidence, passing_evidence_count: passing, pass_rate: passRate, minimum_pass_rate: Number(fixture.minimum_pass_rate ?? 1), match_ids: matches, assertion: fixture.assertion, source_refs: fixtures.source_refs };
}

function runEventFixture(fixture, eventEvidence) {
  const required = fixture.required_event_names || RULE_EVENT_AREAS[fixture.area] || [];
  const observed = required.filter(name => Number(eventEvidence.counts[name] || 0) > 0);
  const missing = required.filter(name => !observed.includes(name));
  const matchCount = missing.length === 0 ? Number(eventEvidence.trajectory_files || 0) : 0;
  const status = missing.length === 0 && matchCount >= (fixture.minimum_matches || 1) ? 'pass' : 'fail';
  return { fixture_id: fixture.fixture_id, kind: fixture.kind, area: fixture.area, status, required_event_names: required, observed_event_names: observed, missing_event_names: missing, match_count: matchCount, assertion: fixture.assertion, source_refs: fixtures.source_refs };
}

export async function runDynamicFixtures({ runtimeDir = defaultRuntime, output = join(runtimeDir, 'reports', 'rule-dynamic-fixtures.v1.json'), trajectoryDir = join(runtimeDir, 'trajectories'), matchPrefix = fixtures.trajectory_prefix || '' } = {}) {
  const trajectories = await loadTrajectories(trajectoryDir, matchPrefix);
  const analyses = trajectories.map(trajectory => ({ match_id: trajectory.match_id, rules_profile: trajectory.rules_profile, analysis: analyzeTrajectory(trajectory.records) }));
  // Event-area fixtures intentionally use the complete corpus when the pattern
  // scope is empty; this lets rare spell/special events be audited separately.
  const eventEvidence = await streamEventCounts(trajectoryDir, matchPrefix ? '' : matchPrefix);
  const results = fixtures.fixtures.map(fixture => fixture.kind === 'pattern'
    ? runPatternFixture(fixture, analyses)
    : runEventFixture(fixture, eventEvidence));
  const patternRows = results.filter(row => row.kind === 'pattern');
  const eventRows = results.filter(row => row.kind === 'event_area');
  const patternOk = patternRows.every(row => row.status === 'pass');
  const eventOk = eventRows.every(row => row.status === 'pass');
  const report = {
    schema_version: 'rule-dynamic-fixtures-report.v1',
    generated_at: new Date().toISOString(),
    rules_version: fixtures.rules_version,
    scope: { match_prefix: matchPrefix || null, pattern_trajectory_files: trajectories.length, event_corpus_files: eventEvidence.trajectory_files },
    summary: {
      total: results.length,
      passed: results.filter(row => row.status === 'pass').length,
      failed: results.filter(row => row.status !== 'pass').length,
      structural_assertions_passed: patternOk,
      event_presence_passed: eventOk,
      pattern_semantics_verified: false,
      event_semantics_verified: false,
      engine_status: 'not_verified',
      fully_verified: false,
    },
    fixtures: results,
    audit_policy: 'A pass proves only the declared observable assertion for the linked fixture_id. Card text, hidden information, target legality and complete strategy semantics still require separate review.',
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const runtime = resolve(process.env.XB_RUNTIME_DIR || defaultRuntime);
    const output = resolve(process.env.XB_DYNAMIC_FIXTURES_OUT || join(runtime, 'reports', 'rule-dynamic-fixtures.v1.json'));
    const report = await runDynamicFixtures({ runtimeDir: runtime, output, trajectoryDir: process.env.XB_TRAJECTORY_DIR || join(runtime, 'trajectories'), matchPrefix: process.env.XB_MATCH_PREFIX ?? fixtures.trajectory_prefix ?? '' });
    console.log(JSON.stringify(report.summary, null, 2));
    console.log(`[rule-dynamic-fixtures] ${output}`);
    if (report.summary.failed) process.exitCode = 1;
  } catch (error) { console.error(`[rule-dynamic-fixtures] ${error.message}`); process.exitCode = 1; }
}
