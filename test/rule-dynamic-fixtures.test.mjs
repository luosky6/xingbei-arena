import test from 'node:test';
import assert from 'node:assert/strict';
import { runDynamicFixtures } from '../bridge/run-dynamic-fixtures.mjs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('dynamic fixture runner binds observable parent/order assertions to fixture ids', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'xingbei-dynamic-fixtures-'));
  try {
    await mkdir(join(runtime, 'trajectories'), { recursive: true });
    const rows = [
      { type: 'trajectory_meta', match_id: 'batch_1', rules_profile: 'core-10th' },
      { match_id: 'batch_1', seq: 1, kind: 'event_start', event_id: 'u1', event: { name: 'useCard' }, parent_event_id: null },
      { match_id: 'batch_1', seq: 2, kind: 'event_start', event_id: 'd1', event: { name: 'damage' }, parent_event_id: 'u1' },
      { match_id: 'batch_1', seq: 3, kind: 'event_start', event_id: 'draw1', event: { name: 'draw' }, parent_event_id: 'd1' },
      { match_id: 'batch_1', seq: 4, kind: 'event_finish', event_id: 'draw1', event: { name: 'draw' }, parent_event_id: 'd1' },
      { match_id: 'batch_1', seq: 5, kind: 'event_finish', event_id: 'd1', event: { name: 'damage' }, parent_event_id: 'u1' },
      { match_id: 'batch_1', seq: 6, kind: 'event_start', event_id: 'r1', event: { name: 'arrangeTrigger', triggername: 'zaoChengShangHai' }, parent_event_id: 'd1' },
      { match_id: 'batch_1', seq: 7, kind: 'event_start', event_id: 'r2', event: { name: 'arrangeTrigger', triggername: 'chengShouShangHaiAfter' }, parent_event_id: 'd1' },
      { match_id: 'batch_1', seq: 8, kind: 'event_start', event_id: 'b1', event: { name: '_baoPai' }, parent_event_id: 'u1' },
      { match_id: 'batch_1', seq: 9, kind: 'event_start', event_id: 'p1', event: { name: '_gouMai' }, parent_event_id: null },
      { match_id: 'batch_1', seq: 10, kind: 'event_start', event_id: 's1', event: { name: '_heCheng_backup' }, parent_event_id: null },
      { match_id: 'batch_1', seq: 11, kind: 'event_start', event_id: 'f1', event: { name: '_tiLian_backup' }, parent_event_id: null },
    ];
    await writeFile(join(runtime, 'trajectories', 'batch_1.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const report = await runDynamicFixtures({ runtimeDir: runtime, output: join(runtime, 'report.json'), trajectoryDir: join(runtime, 'trajectories'), matchPrefix: 'batch_' });
    assert.equal(report.schema_version, 'rule-dynamic-fixtures-report.v1');
    assert.ok(report.fixtures.some(row => row.fixture_id === 'engine_damage_draw_parent_order'));
    assert.equal(report.summary.engine_status, 'not_verified');
    assert.equal(report.summary.pattern_semantics_verified, false);
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
});
