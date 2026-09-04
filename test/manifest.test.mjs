import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../bridge/build-manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('manifest indexes valid data and quarantines malformed trajectories', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'xingbei-manifest-'));
  try {
    await mkdir(join(temp, 'trajectories'), { recursive: true });
    await mkdir(join(temp, 'matches'), { recursive: true });
    await copyFile(join(root, 'test', 'fixtures', 'trajectory.sample.jsonl'), join(temp, 'trajectories', 'ok.jsonl'));
    await copyFile(join(root, 'test', 'fixtures', 'trajectory.trailing.jsonl'), join(temp, 'trajectories', 'bad.jsonl'));
    const manifest = await buildManifest({ runtimeDir: temp });
    assert.equal(manifest.summary.trajectory_files, 2);
    assert.equal(manifest.summary.valid_trajectories, 1);
    assert.equal(manifest.summary.quarantined_trajectories, 1);
    assert.equal(manifest.trajectories.find(item => item.path.endsWith('ok.jsonl')).status, 'valid');
    assert.equal(manifest.trajectories.find(item => item.path.endsWith('bad.jsonl')).status, 'quarantine');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('manifest supports an explicit match-prefix scope without deleting legacy evidence', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'xingbei-manifest-scope-'));
  try {
    await mkdir(join(temp, 'trajectories'), { recursive: true });
    await mkdir(join(temp, 'matches'), { recursive: true });
    await copyFile(join(root, 'test', 'fixtures', 'trajectory.sample.jsonl'), join(temp, 'trajectories', 'batch_ok.jsonl'));
    await copyFile(join(root, 'test', 'fixtures', 'trajectory.trailing.jsonl'), join(temp, 'trajectories', 'legacy_bad.jsonl'));
    const manifest = await buildManifest({ runtimeDir: temp, matchPrefix: 'batch_' });
    assert.deepEqual(manifest.scope, { match_prefix: 'batch_' });
    assert.equal(manifest.summary.trajectory_files, 1);
    assert.equal(manifest.summary.valid_trajectories, 1);
    assert.equal(manifest.summary.quarantined_trajectories, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
