// Build a content-addressed batch manifest for training ingestion.
// Invalid or legacy trajectories remain on disk for forensics, but are marked
// quarantine and must not be consumed by a trainer.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTrajectoryFile } from './validate-trajectory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const defaultRuntime = resolve(here, '..', 'runtime');

async function sha256File(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { sha256: `sha256:${hash.digest('hex')}`, bytes };
}

async function firstJsonLine(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  let buffer = '';
  try {
    for await (const chunk of stream) {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end >= 0) buffer = buffer.slice(0, end);
      if (buffer.trim()) break;
    }
  } finally {
    stream.destroy();
  }
  return buffer.trim() ? JSON.parse(buffer) : null;
}

async function filesIn(dir, prefix = '') {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(item => item.isFile() && item.name.endsWith('.jsonl') && (!prefix || item.name.startsWith(prefix)))
      .map(item => join(dir, item.name)).sort();
  }
  catch { return []; }
}

export async function buildManifest({ runtimeDir = defaultRuntime, output = join(runtimeDir, 'manifest.v1.json'), matchPrefix = '' } = {}) {
  const scopePrefix = String(matchPrefix || '').trim();
  if (scopePrefix && !/^[A-Za-z0-9_-]+$/.test(scopePrefix)) {
    throw new Error(`matchPrefix contains unsafe characters: ${scopePrefix}`);
  }
  const trajectoryDir = join(runtimeDir, 'trajectories');
  const matchDir = join(runtimeDir, 'matches');
  const trajectories = [];
  for (const path of await filesIn(trajectoryDir, scopePrefix)) {
    const relativePath = relative(runtimeDir, path).replaceAll('\\', '/');
    const digest = await sha256File(path);
    let metadata = null;
    let validation = null;
    let error = null;
    try {
      metadata = await firstJsonLine(path);
      validation = await validateTrajectoryFile(path);
    } catch (cause) {
      error = String(cause?.message || cause);
    }
    trajectories.push({
      path: relativePath,
      ...digest,
      status: validation?.ok && validation.dropped_count === 0 ? 'valid' : 'quarantine',
      metadata: metadata && metadata.type === 'trajectory_meta' ? {
        match_id: metadata.match_id,
        rules_profile: metadata.rules_profile || null,
        initial_morale: metadata.initial_morale ?? null,
        rules_version: metadata.rules_version || null,
        engine_fingerprint: metadata.engine_fingerprint || null,
        config_hash: metadata.config_hash || null,
        policy_id: metadata.policy_id || null,
      } : null,
      validation,
      error,
    });
  }

  const results = [];
  for (const path of await filesIn(matchDir, scopePrefix)) {
    const digest = await sha256File(path);
    const text = await readFile(path, 'utf8');
    const resultLines = text.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(value => value?.type === 'result');
    results.push({
      path: relative(runtimeDir, path).replaceAll('\\', '/'),
      ...digest,
      result_count: resultLines.length,
      match_ids: resultLines.map(value => value.match_id).filter(Boolean),
      status: resultLines.length ? 'indexed' : 'quarantine',
    });
  }

  const valid = trajectories.filter(item => item.status === 'valid');
  const manifest = {
    schema_version: 'manifest.v1',
    generated_at: new Date().toISOString(),
    runtime_dir: runtimeDir,
    scope: { match_prefix: scopePrefix || null },
    policy: 'Only status=valid trajectories may enter training; quarantine entries are retained for forensics.',
    summary: {
      trajectory_files: trajectories.length,
      valid_trajectories: valid.length,
      quarantined_trajectories: trajectories.length - valid.length,
      valid_records: valid.reduce((sum, item) => sum + (item.validation?.record_count || 0), 0),
      result_files: results.length,
    },
    trajectories,
    results,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const runtimeDir = process.env.XB_RUNTIME_DIR ? resolve(process.env.XB_RUNTIME_DIR) : defaultRuntime;
  const output = process.argv[2] ? resolve(process.argv[2]) : join(runtimeDir, 'manifest.v1.json');
  const matchPrefix = process.env.XB_MANIFEST_PREFIX || '';
  try {
    const manifest = await buildManifest({ runtimeDir, output, matchPrefix });
    console.log(JSON.stringify(manifest.summary, null, 2));
    console.log(`[manifest] ${output}`);
  } catch (error) {
    console.error(`[manifest] ${error.message}`);
    process.exit(1);
  }
}
