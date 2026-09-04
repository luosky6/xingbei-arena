import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCandidate } from '../tune/ranking-model.mjs';

export const POLICY_IDS = Object.freeze(['first_legal', 'deterministic_random', 'heuristic', 'epsilon_greedy', 'learned_v1']);
const defaultModelPath = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'runtime', 'models', 'learned-v1.json');
let learnedModelPromise = null;
let learnedModelPath = null;

export async function loadLearnedModel(path = process.env.XB_RANKING_MODEL || defaultModelPath) {
  if (!learnedModelPromise || learnedModelPath !== path) {
    learnedModelPath = path;
    learnedModelPromise = readFile(path, 'utf8').then(raw => JSON.parse(raw)).then(model => {
    if (model?.schema_version !== 'ranking-model.v1' || !Array.isArray(model.feature_names) || !Array.isArray(model.weights) || model.feature_names.length !== model.weights.length) throw new Error('invalid learned-v1 model artifact');
    return model;
    });
  }
  return learnedModelPromise;
}

export async function learnedChoice(request = {}) {
  const options = Array.isArray(request.legal_options) ? request.legal_options : [];
  if (!options.length) return 0;
  const model = await loadLearnedModel();
  const scored = options.map((option, index) => ({ option, index, score: scoreCandidate(model, { features: option.candidate_features || {}, baseline_score: option.baseline_score }) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const min = Number.isInteger(request?.selection?.min) ? Math.max(1, request.selection.min) : 1;
  if (min > 1) return scored.slice(0, min).sort((left, right) => left.index - right.index).map(item => item.option.id);
  return scored[0]?.option?.id ?? 0;
}

// All in-process policies implement the same tiny contract as an external
// Player worker: decide(request) resolves to an object containing a legal
// option id. Keeping this registry here prevents smoke-test policies from
// silently diverging from the inbox/outbox validation path.
export function createPolicy(id = 'first_legal') {
  if (!POLICY_IDS.includes(id)) throw new Error(`unknown policy: ${id}`);
  return Object.freeze({
    id,
    async decide(request = {}) {
      if (id === 'learned_v1') return { choice: await learnedChoice(request), policy_id: id };
      return { choice: fallbackChoice(request, id) };
    },
  });
}

export async function decideWithPolicy(request = {}, id = 'first_legal') {
  const response = await createPolicy(id).decide(request);
  const checked = validateResponse(request, response);
  if (!checked.ok) throw new Error(`policy ${id} returned an illegal choice: ${checked.reason}`);
  return checked.choice;
}

export function legalIds(request = {}) {
  return Array.isArray(request.legal_options) ? request.legal_options.map(option => option?.id).filter(id => id !== undefined && id !== null) : [];
}

export function validateResponse(request, response) {
  const ids = legalIds(request);
  const selection = request?.selection && typeof request.selection === 'object' ? request.selection : null;
  const hasSelection = !!selection;
  const min = Number.isInteger(selection?.min) ? selection.min : 0;
  const max = Number.isInteger(selection?.max) ? selection.max : Number.MAX_SAFE_INTEGER;
  if (!response || !Object.prototype.hasOwnProperty.call(response, 'choice')) return { ok: false, reason: 'missing_choice' };
  if (Array.isArray(response.choice)) {
    const choices = response.choice;
    const invalid = choices.find(choice => !ids.includes(choice));
    const unique = new Set(choices).size === choices.length;
    if (invalid !== undefined || !unique) return { ok: false, reason: invalid !== undefined ? 'choice_not_legal' : 'duplicate_choice', choice: response.choice, legal_ids: ids };
    if (hasSelection && (choices.length < min || choices.length > max)) return { ok: false, reason: 'choice_count_out_of_range', choice: response.choice, legal_ids: ids, selection: { min, max } };
    return { ok: true, choice: choices.slice() };
  }
  if (hasSelection && (min > 1 || max < 1)) return { ok: false, reason: 'choice_count_out_of_range', choice: response.choice, legal_ids: ids, selection: { min, max } };
  return ids.includes(response.choice) ? { ok: true, choice: response.choice } : { ok: false, reason: 'choice_not_legal', choice: response.choice, legal_ids: ids };
}

export function firstLegal(request = {}) {
  const ids = legalIds(request);
  const min = Number.isInteger(request?.selection?.min) ? request.selection.min : 1;
  return min > 1 ? ids.slice(0, min) : ids[0] ?? 0;
}

export function deterministicRandom(request = {}) {
  const ids = legalIds(request);
  if (!ids.length) return 0;
  const digest = createHash('sha256').update(String(request.decision_id || '')).digest();
  const index = digest.readUInt32BE(0) % ids.length;
  const min = Number.isInteger(request?.selection?.min) ? request.selection.min : 1;
  if (min <= 1) return ids[index];
  return Array.from({ length: Math.min(min, ids.length) }, (_, offset) => ids[(index + offset) % ids.length]);
}

function hashUnit(value) {
  const digest = createHash('sha256').update(String(value || '')).digest();
  return digest.readUInt32BE(0) / 0x100000000;
}

/**
 * Deterministic epsilon-greedy behavior policy. The hash makes a run
 * reproducible while epsilon still appears in the dataset as an explicit
 * exploration probability; it never uses hidden engine state.
 */
export function epsilonGreedy(request = {}) {
  const ids = legalIds(request);
  if (!ids.length) return 0;
  const epsilonRaw = Number(request?.behavior?.epsilon ?? request?.epsilon ?? 0.1);
  const epsilon = Number.isFinite(epsilonRaw) ? Math.max(0, Math.min(1, epsilonRaw)) : 0.1;
  const explore = hashUnit(`${request.decision_id || ''}#explore`) < epsilon;
  if (!explore) return firstLegal(request);
  return deterministicRandom({ ...request, decision_id: `${request.decision_id || ''}#explore` });
}

/**
 * Public-state-only tactical policy. It deliberately consumes the candidate
 * features emitted by decisionBridge rather than reaching into the engine;
 * this makes it a reproducible intermediate baseline between first-legal and
 * a learned/LLM policy. The feature weights are conservative so legality and
 * base engine score remain dominant.
 */
export function heuristicChoice(request = {}) {
  const options = Array.isArray(request.legal_options) ? request.legal_options : [];
  if (!options.length) return 0;
  const score = option => {
    const feature = option?.candidate_features && typeof option.candidate_features === 'object' ? option.candidate_features : {};
    let value = Number(option?.baseline_score);
    if (!Number.isFinite(value)) value = 0;
    if (feature.target_is_enemy) value += 0.35;
    if (Number.isFinite(Number(feature.enemy_shiqi))) value += Math.max(0, Math.min(0.6, (6 - Math.max(0, Number(feature.enemy_shiqi))) * 0.1));
    const role = feature.target_role_tags && typeof feature.target_role_tags === 'object' ? feature.target_role_tags : {};
    if (role.finisher) value += 0.18;
    if (role.resource) value += 0.1;
    if (role.control) value += 0.08;
    if (feature.kind === 'use') value += 0.04;
    // Stable, tiny index tie-break avoids Math.random and preserves auditability.
    return value - options.indexOf(option) * 1e-6;
  };
  const ranked = options.map((option, index) => ({ option, index, value: score(option) })).sort((left, right) => right.value - left.value || left.index - right.index);
  const min = Number.isInteger(request?.selection?.min) ? Math.max(1, request.selection.min) : 1;
  if (min > 1) return ranked.slice(0, min).sort((left, right) => left.index - right.index).map(item => item.option.id);
  return ranked[0]?.option?.id ?? 0;
}

/** Record the policy-level probability without pretending a deterministic
 * request has a stochastic model. `choice_probability` is exact for
 * first_legal and epsilon_greedy and is the support probability for the
 * deterministic hash policy across decision ids. */
export function behaviorMetadata(request = {}, policy = 'first_legal', choice = null) {
  const ids = legalIds(request);
  const n = ids.length;
  const chosen = Array.isArray(choice) ? choice[0] : choice;
  if (!n) return { policy_id: policy, epsilon: null, choice_probability: null, probability_status: 'no_candidates' };
  if (policy === 'epsilon_greedy') {
    const epsilonRaw = Number(request?.behavior?.epsilon ?? request?.epsilon ?? 0.1);
    const epsilon = Number.isFinite(epsilonRaw) ? Math.max(0, Math.min(1, epsilonRaw)) : 0.1;
    const first = ids[0];
    return { policy_id: policy, epsilon, choice_probability: chosen === first ? (1 - epsilon) + epsilon / n : epsilon / n, probability_status: 'epsilon_policy' };
  }
  if (policy === 'deterministic_random') return { policy_id: policy, epsilon: null, choice_probability: 1 / n, probability_status: 'hash_support_probability' };
  if (policy === 'heuristic') {
    const best = heuristicChoice({ ...request, selection: { min: 1 } });
    const chosenId = Array.isArray(choice) ? choice[0] : choice;
    return { policy_id: policy, epsilon: 0, choice_probability: chosenId === best ? 1 : 0, probability_status: 'deterministic_heuristic' };
  }
  if (policy === 'learned_v1') return { policy_id: policy, epsilon: null, choice_probability: null, probability_status: 'learned_model_deterministic_not_calibrated' };
  return { policy_id: policy, epsilon: 0, choice_probability: chosen === ids[0] ? 1 : 0, probability_status: 'deterministic' };
}

export function fallbackChoice(request = {}, policy = 'first_legal') {
  if (policy === 'deterministic_random') return deterministicRandom(request);
  if (policy === 'heuristic') return heuristicChoice(request);
  if (policy === 'epsilon_greedy') return epsilonGreedy(request);
  // learned_v1 is intentionally not used as a synchronous emergency fallback:
  // if its artifact is missing, first_legal makes the failure explicit in the
  // bridge violation/audit stream instead of silently claiming model use.
  return firstLegal(request);
}
