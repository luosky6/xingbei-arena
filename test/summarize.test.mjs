import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeMatches } from '../bridge/summarize.mjs';

test('summary reports Wilson intervals, turn statistics, dimensions and violations', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'xingbei-summary-'));
  try {
    const matches = join(temp, 'matches');
    const violations = join(temp, 'violations.jsonl');
    const decisions = join(temp, 'decisions.jsonl');
    await mkdir(matches, { recursive: true });
    const line = value => JSON.stringify({ type: 'result', ...value });
    await writeFile(join(matches, 'batch.jsonl'), [
      line({ match_id: 's_1', mode: 'two', policy_id: 'builtin-v0', overlay_side: 'both', winner_side: 'red', win_by: 'shiqi0', turns: 10 }),
      line({ match_id: 's_2', mode: 'two', policy_id: 'builtin-v0', overlay_side: 'both', winner_side: 'blue', win_by: 'xingBei5', turns: 20 }),
      line({ match_id: 's_3', mode: 'three', policy_id: 'overlay', overlay_side: 'red', status: 'timeout', ok: false }),
    ].join('\n') + '\n');
    await writeFile(violations, [
      JSON.stringify({ match_id: 's_1', reason: 'deadline_or_missing_response' }),
      JSON.stringify({ match_id: 'other', reason: 'ignored' }),
    ].join('\n') + '\n');
    await writeFile(decisions, [
      JSON.stringify({ type: 'decision_audit', match_id: 's_1', source: 'external', valid: true, latency_ms: 10, candidate_count: 3 }),
      JSON.stringify({ type: 'decision_audit', match_id: 's_1', source: 'fallback', valid: false, latency_ms: 20, candidate_count: 2 }),
      JSON.stringify({ type: 'decision_audit', match_id: 'other', source: 'inline', valid: true, latency_ms: 1, candidate_count: 1 }),
    ].join('\n') + '\n');
    const report = await summarizeMatches({ matchesDir: matches, violationsFile: violations, decisionsFile: decisions, prefix: 's_' });
    assert.equal(report.overall.samples, 3);
    assert.equal(report.overall.completed, 2);
    assert.equal(report.overall.turns.mean, 15);
    assert.equal(report.overall.turns.median, 15);
    assert.equal(report.overall.win_by.shiqi0, 1);
    assert.equal(report.by_mode.two.completed, 2);
    assert.equal(report.by_mode.three.completed, 0);
    assert.equal(report.failures.timeout, 1);
    assert.equal(report.fallback.count, 1);
    assert.equal(report.fallback.by_reason.deadline_or_missing_response, 1);
    assert.equal(report.overall.by_side.red.wins, 1);
    assert.equal(report.overall.by_side.red.bootstrap95.rounds, 1000);
    assert.ok(report.overall.by_side.red.bootstrap95.low <= report.overall.by_side.red.win_rate);
    assert.ok(report.overall.by_side.red.win_rate <= report.overall.by_side.red.bootstrap95.high);
    assert.equal(report.decisions.count, 2);
    assert.equal(report.decisions.by_source.external, 1);
    assert.equal(report.decisions.invalid, 1);
    assert.equal(report.decisions.latency_ms.p95, 19.5);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
