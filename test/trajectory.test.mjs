import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTrajectory } from '../bridge/trajectoryRecorder.mjs';
import { validateTrajectoryFile } from '../bridge/validate-trajectory.mjs';
import { replayTrajectoryFile } from '../bridge/replay-trajectory.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('trajectory reader reports a missing hook explicitly', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    const fakePage = { evaluate: async fn => fn() };
    const snapshot = await readTrajectory(fakePage);
    assert.equal(snapshot.schema_version, 'trajectory.v1');
    assert.equal(snapshot.missing, true);
    assert.deepEqual(snapshot.records, []);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('trajectory contract documents result-only baseline limitation', async () => {
  const doc = await readFile(join(root, 'docs', 'trajectory-recorder.md'), 'utf8');
  assert.match(doc, /不能用于可靠的 AI 学习/);
  assert.match(doc, /runtime\/trajectories/);
  assert.match(doc, /dropped_count/);
});

test('trajectory recorder exposes decision request hooks', async () => {
  const source = await readFile(join(root, 'bridge', 'trajectoryRecorder.mjs'), 'utf8');
  assert.match(source, /decision_request/);
  assert.match(source, /chooseToUse/);
  assert.match(source, /chooseToRespond/);
  assert.match(source, /gongJiOrFaShu/);
  assert.match(source, /actions = \[\]/);
  assert.match(source, /option_summary/);
  assert.match(source, /candidate_only/);
  assert.match(source, /assignment_mode/);
  assert.match(source, /out\.move/);
  assert.match(source, /seating: {/);
  assert.match(source, /team_sequence_kind/);
  assert.match(source, /turn_order_from_first_act/);
  assert.match(source, /actual_action_order/);
  assert.match(source, /actionOrder\.push/);
});

test('trajectory validator accepts a complete monotonic fixture', async () => {
  const report = await validateTrajectoryFile(join(root, 'test', 'fixtures', 'trajectory.sample.jsonl'));
  assert.equal(report.ok, true);
  assert.equal(report.record_count, 2);
  assert.equal(report.dropped_count, 0);
});

test('trajectory validator rejects records after the terminal marker', async () => {
  await assert.rejects(
    validateTrajectoryFile(join(root, 'test', 'fixtures', 'trajectory.trailing.jsonl')),
    /records found after trajectory_end/
  );
});

test('trajectory replay rebuilds a public event summary', async () => {
  const report = await replayTrajectoryFile(join(root, 'test', 'fixtures', 'trajectory.sample.jsonl'));
  assert.equal(report.schema_version, 'replay.v1');
  assert.equal(report.match_id, 'fixture');
  assert.equal(report.validated_record_count, 2);
  assert.equal(report.resource_curve.length, 0);
  assert.equal(report.event_names.phase, 1);
});
