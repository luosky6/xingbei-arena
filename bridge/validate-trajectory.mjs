// Streaming integrity check for runtime/trajectories/*.jsonl.
// A trajectory with dropped records is intentionally rejected from training.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function validateTrajectoryFile(path) {
  const input = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNo = 0, meta = null, end = null, records = 0, previousSeq = 0, sawEnd = false;
  const kinds = new Map();
  const allowedKinds = new Set(['event_create', 'event_set_content', 'event_trigger', 'event_start', 'event_finish', 'decision_request', 'api_call', 'public_hook']);
  for await (const line of input) {
    lineNo++;
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch (error) { throw new Error(`line ${lineNo}: invalid JSON (${error.message})`); }
    if (lineNo === 1) {
      if (value.type !== 'trajectory_meta') throw new Error('first line must be trajectory_meta');
      if (value.schema_version !== 'trajectory.v1') throw new Error('trajectory_meta has unexpected schema_version');
      if (!Number.isInteger(value.record_count) || value.record_count < 0) throw new Error('trajectory_meta has invalid record_count');
      if (!Number.isInteger(value.dropped_count) || value.dropped_count < 0) throw new Error('trajectory_meta has invalid dropped_count');
      for (const key of ['match_id', 'rules_version', 'engine_fingerprint', 'config_hash', 'policy_id']) {
        if (typeof value[key] !== 'string' || !value[key]) throw new Error(`trajectory_meta missing ${key}`);
      }
      meta = value;
      continue;
    }
    if (value.type === 'trajectory_end') {
      if (sawEnd) throw new Error(`line ${lineNo}: duplicate trajectory_end`);
      sawEnd = true;
      end = value;
      continue;
    }
    if (sawEnd) throw new Error(`line ${lineNo}: records found after trajectory_end`);
    if (value.schema_version !== 'trajectory.v1') throw new Error(`line ${lineNo}: unexpected schema_version`);
    if (typeof value.match_id !== 'string' || !value.match_id) throw new Error(`line ${lineNo}: record missing match_id`);
    if (value.match_id !== meta.match_id) throw new Error(`line ${lineNo}: record match_id mismatch`);
    if (typeof value.rules_version !== 'string' || !value.rules_version) throw new Error(`line ${lineNo}: record missing rules_version`);
    if (value.rules_version !== meta.rules_version) throw new Error(`line ${lineNo}: record rules_version mismatch`);
    if (!Number.isInteger(value.ts_ms) || value.ts_ms < 0) throw new Error(`line ${lineNo}: record has invalid ts_ms`);
    if (typeof value.hook !== 'string') throw new Error(`line ${lineNo}: record has invalid hook`);
    if (!allowedKinds.has(value.kind)) throw new Error(`line ${lineNo}: unknown record kind ${String(value.kind)}`);
    if (value.kind === 'decision_request' && (!value.decision || typeof value.decision.method !== 'string')) throw new Error(`line ${lineNo}: decision_request missing decision.method`);
    if (!Number.isInteger(value.seq) || value.seq <= previousSeq) throw new Error(`line ${lineNo}: seq is not strictly increasing`);
    previousSeq = value.seq;
    records++;
    kinds.set(value.kind, (kinds.get(value.kind) || 0) + 1);
  }
  if (!meta) throw new Error('missing trajectory_meta');
  if (!end) throw new Error('missing trajectory_end');
  if (end.schema_version !== 'trajectory.v1') throw new Error('trajectory_end has unexpected schema_version');
  if (!Number.isInteger(end.record_count) || end.record_count < 0) throw new Error('trajectory_end has invalid record_count');
  if (!Number.isInteger(end.dropped_count) || end.dropped_count < 0) throw new Error('trajectory_end has invalid dropped_count');
  for (const key of ['match_id', 'rules_version', 'engine_fingerprint', 'config_hash', 'policy_id']) {
    if (typeof end[key] !== 'string' || !end[key]) throw new Error(`trajectory_end missing ${key}`);
    if (meta[key] !== end[key]) throw new Error(`trajectory metadata mismatch for ${key}`);
  }
  for (const key of ['rules_profile', 'initial_morale']) {
    if (meta[key] !== undefined || end[key] !== undefined) {
      if (meta[key] !== end[key]) throw new Error(`trajectory metadata mismatch for ${key}`);
    }
  }
  if (meta.record_count !== records || end.record_count !== records) throw new Error(`record count mismatch meta=${meta.record_count} end=${end.record_count} actual=${records}`);
  if (meta.dropped_count !== 0 || end.dropped_count !== 0) throw new Error(`trajectory incomplete: dropped_count=${meta.dropped_count ?? end.dropped_count}`);
  return { ok: true, match_id: meta.match_id, record_count: records, dropped_count: 0, kinds: Object.fromEntries(kinds) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const path = process.argv[2] || process.env.XB_TRAJECTORY;
  if (!path) { console.error('Usage: node bridge/validate-trajectory.mjs <trajectory.jsonl>'); process.exit(2); }
  try { console.log(JSON.stringify(await validateTrajectoryFile(path), null, 2)); }
  catch (error) { console.error(`[trajectory] ${error.message}`); process.exit(1); }
}
