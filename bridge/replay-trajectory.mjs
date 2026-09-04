// Minimal, deterministic replay of a public trajectory.
// This does not re-run the engine. It reconstructs the observable resource
// curve, decision order and event-name histogram so failed/interesting games
// can be inspected without exposing hidden cards.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTrajectoryFile } from './validate-trajectory.mjs';

const scalar = value => (Number.isFinite(value) ? value : null);
const team = state => ({
  shiqi: scalar(state?.shiqi ?? state?.shi_qi),
  xingbei: scalar(state?.xingbei ?? state?.xing_bei),
});

export async function replayTrajectoryFile(path, { maxPoints = 5000 } = {}) {
  const validation = await validateTrajectoryFile(path);
  const input = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let meta = null;
  let lastResourceKey = null;
  const resourceCurve = [];
  const decisions = [];
  const eventNames = new Map();
  let recordsSeen = 0;

  for await (const line of input) {
    if (!line.trim()) continue;
    const value = JSON.parse(line);
    if (value.type === 'trajectory_meta') {
      meta = value;
      continue;
    }
    if (value.type === 'trajectory_end') continue;
    recordsSeen++;
    const eventName = value.event?.name;
    if (eventName) eventNames.set(eventName, (eventNames.get(eventName) || 0) + 1);
    if (value.kind === 'decision_request') {
      const decision = value.decision || {};
      decisions.push({
        seq: value.seq,
        ts_ms: value.ts_ms,
        actor: decision.actor || null,
        method: decision.method || null,
        parent_event_id: decision.parent_event_id || value.parent_event_id || null,
        result_event_id: value.result_event_id || null,
        args: decision.args || [],
      });
    }
    const state = value.public_state;
    if (!state || resourceCurve.length >= maxPoints) continue;
    const point = {
      seq: value.seq,
      ts_ms: value.ts_ms,
      phase_number: scalar(state.phase_number),
      current_phase: state.current_phase || null,
      red: team({ shiqi: state.hong_shiqi, xingbei: state.hong_xingbei }),
      blue: team({ shiqi: state.lan_shiqi, xingbei: state.lan_xingbei }),
      players: Array.isArray(state.players) ? state.players.map(player => ({
        seat: player.seat ?? null,
        side: player.side ?? null,
        actor: player.actor ?? null,
        hand_count: scalar(player.hand_count),
        zhi_liao: scalar(player.zhi_liao),
        energy: scalar(player.energy),
      })) : [],
    };
    const key = JSON.stringify(point);
    if (key !== lastResourceKey) {
      resourceCurve.push(point);
      lastResourceKey = key;
    }
  }
  return {
    schema_version: 'replay.v1',
    match_id: meta?.match_id || validation.match_id,
    rules_version: meta?.rules_version || null,
    engine_fingerprint: meta?.engine_fingerprint || null,
    config_hash: meta?.config_hash || null,
    policy_id: meta?.policy_id || null,
    source_record_count: recordsSeen,
    validated_record_count: validation.record_count,
    resource_curve: resourceCurve,
    decisions,
    event_names: Object.fromEntries([...eventNames].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => [name, count])),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const path = process.argv[2] || process.env.XB_TRAJECTORY;
  if (!path) { console.error('Usage: node bridge/replay-trajectory.mjs <trajectory.jsonl> [out.json]'); process.exit(2); }
  try {
    const report = await replayTrajectoryFile(path);
    const out = process.argv[3] || process.env.XB_REPLAY_OUT;
    if (out) await writeFile(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`[replay] ${error.message}`);
    process.exit(1);
  }
}
