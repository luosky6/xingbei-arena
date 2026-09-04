// Deterministic, public-feature-only pairwise ranking model.
// This is deliberately a lightweight Learned-v1 candidate; it is not a
// replacement for the rules adjudicator and has no access to hidden cards.
import { createHash } from 'node:crypto';

export const MODEL_SCHEMA = 'ranking-model.v1';

function flatten(value, prefix, out, depth = 0) {
  if (depth > 4 || value == null) return;
  if (typeof value === 'boolean') { out[prefix] = value ? 1 : 0; return; }
  if (typeof value === 'number' && Number.isFinite(value)) { out[prefix] = value; return; }
  if (typeof value === 'string') { if (value.length <= 80) out[`${prefix}=${value}`] = 1; return; }
  if (typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value).sort()) {
    if (/(?:^|_)(?:hand|cards?|private|hidden|identity)(?:$|_)/i.test(key)) continue;
    flatten(value[key], prefix ? `${prefix}.${key}` : key, out, depth + 1);
  }
}

export function candidateFeatureMap(candidate = {}) {
  const out = {};
  flatten(candidate.features || {}, 'candidate', out);
  if (Number.isFinite(Number(candidate.baseline_score))) out.baseline_score = Number(candidate.baseline_score);
  // Absolute seat/index fields are only identifiers under the default setup;
  // learning them caused the first online smoke to overfit one seat layout and
  // loop. Relative distance and enemy/ally booleans remain valid public cues.
  return Object.fromEntries(Object.entries(out).filter(([name]) => !/^candidate\.(?:index|target_index|target_seat|target_side|card_index)(?:=|$)/.test(name)));
}

export function featureNames(rows = [], maxFeatures = 256) {
  const names = new Set();
  for (const row of rows) for (const candidate of row.candidates || []) for (const name of Object.keys(candidateFeatureMap(candidate))) names.add(name);
  return [...names].sort().slice(0, maxFeatures);
}

export function vectorize(candidate, names) {
  const map = candidateFeatureMap(candidate);
  return names.map(name => Number.isFinite(Number(map[name])) ? Number(map[name]) : 0);
}

function dot(left, right) {
  let value = 0;
  for (let index = 0; index < left.length; index++) value += left[index] * right[index];
  return value;
}

function sigmoid(value) {
  if (value >= 0) { const z = Math.exp(-value); return 1 / (1 + z); }
  const z = Math.exp(value); return z / (1 + z);
}

export function pairRows(rows = []) {
  const pairs = [];
  for (const row of rows) {
    const outcome = Number(row?.label?.outcome);
    if (!Number.isFinite(outcome) || outcome === 0) continue;
    const chosenId = row?.label?.chosen_id;
    const chosen = (row.candidates || []).find(candidate => candidate.id === chosenId);
    if (!chosen) continue;
    for (const other of row.candidates || []) {
      if (other.id === chosenId) continue;
      // A winning chosen action is positive. For a losing chosen action, an
      // unchosen legal alternative is treated as the pairwise positive side.
      pairs.push(outcome > 0 ? { positive: chosen, negative: other } : { positive: other, negative: chosen });
    }
  }
  return pairs;
}

export function fitRankingModel(rows = [], { epochs = 8, learningRate = 0.025, l2 = 0.0001, maxFeatures = 256 } = {}) {
  const names = featureNames(rows, maxFeatures);
  const pairs = pairRows(rows);
  const weights = Array(names.length).fill(0);
  const vectors = new WeakMap();
  const vector = candidate => {
    if (!vectors.has(candidate)) vectors.set(candidate, vectorize(candidate, names));
    return vectors.get(candidate);
  };
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const pair of pairs) {
      const positive = vector(pair.positive);
      const negative = vector(pair.negative);
      const diff = positive.map((value, index) => value - negative[index]);
      const margin = dot(weights, diff);
      const multiplier = sigmoid(-margin);
      for (let index = 0; index < weights.length; index++) weights[index] += learningRate * (multiplier * diff[index] - l2 * weights[index]);
    }
  }
  return { schema_version: MODEL_SCHEMA, model_id: 'learned-v1', feature_schema_version: 'candidate-features.v1', feature_names: names, weights, training: { rows: rows.length, pairs: pairs.length, epochs, learning_rate: learningRate, l2 } };
}

export function scoreCandidate(model, candidate) {
  return dot(model.weights || [], vectorize(candidate, model.feature_names || []));
}

function topCandidate(model, row, scorer = candidate => scoreCandidate(model, candidate)) {
  return (row.candidates || []).reduce((best, candidate) => best == null || scorer(candidate) > scorer(best) ? candidate : best, null);
}

export function evaluateRankingModel(model, rows = []) {
  let observedCorrect = 0, outcomeConsistent = 0, outcomeRows = 0;
  for (const row of rows) {
    const predicted = topCandidate(model, row);
    const chosenId = row?.label?.chosen_id;
    if (predicted?.id === chosenId) observedCorrect++;
    const outcome = Number(row?.label?.outcome);
    if (outcome === 1 || outcome === -1) {
      outcomeRows++;
      if ((outcome === 1 && predicted?.id === chosenId) || (outcome === -1 && predicted?.id !== chosenId)) outcomeConsistent++;
    }
  }
  const pairs = pairRows(rows);
  let pairCorrect = 0;
  for (const pair of pairs) if (scoreCandidate(model, pair.positive) > scoreCandidate(model, pair.negative)) pairCorrect++;
  return { rows: rows.length, pairs: pairs.length, observed_top1: rows.length ? observedCorrect / rows.length : null, outcome_consistency: outcomeRows ? outcomeConsistent / outcomeRows : null, pair_accuracy: pairs.length ? pairCorrect / pairs.length : null };
}

export function modelHash(model) {
  return `sha256:${createHash('sha256').update(JSON.stringify(model)).digest('hex')}`;
}
