/**
 * Versioned feature contract for the heuristic overlay.
 *
 * The registry is deliberately data-only: it documents the perspective,
 * expected range and prior weight for every value-function input so training
 * and evaluation can reject a silently changed feature vector.
 */
export const FEATURE_SCHEMA_VERSION = 'features.v1';

const definitions = {
  shiqi_diff: { perspective: 'self', range: [-18, 18], weight: 10 },
  shiqi_enemy_near0: { perspective: 'self', range: [0, 6], weight: 6 },
  shiqi_self_near0: { perspective: 'self', range: [0, 6], weight: -8 },
  xingbei_diff: { perspective: 'self', range: [-5, 5], weight: 8 },
  xingbei_self_progress: { perspective: 'self', range: [0, 5], weight: 3 },
  zhanji_self: { perspective: 'self', range: [0, 5], weight: 1 },
  actions_left: { perspective: 'self', range: [0, 16], weight: 4 },
  chain_potential: { perspective: 'self', range: [0, 32], weight: 3 },
  pierce_potential: { perspective: 'self', range: [0, 32], weight: 2 },
  hand_quality_self: { perspective: 'self', range: [0, 8], weight: 1 },
  zhiliao_self_team: { perspective: 'self', range: [0, 16], weight: 1.5 },
  enemy_burn_exposure: { perspective: 'self', range: [0, 16], weight: 2 },
  self_burn_exposure: { perspective: 'self', range: [0, 16], weight: -2 },
  markers_banked_self: { perspective: 'self', range: [0, 8], weight: 0.8 },
  team_control_coverage: { perspective: 'self', range: [0, 1], weight: 0.8 },
  team_support_coverage: { perspective: 'self', range: [0, 1], weight: 0.8 },
  team_finisher_coverage: { perspective: 'self', range: [0, 1], weight: 1.2 },
  team_pair_synergy: { perspective: 'self', range: [0, 1], weight: 1.5 },
  team_resource_coverage: { perspective: 'self', range: [0, 1], weight: 0.8 },
  team_damage_coverage: { perspective: 'self', range: [0, 1], weight: 0.6 },
  team_defense_coverage: { perspective: 'self', range: [0, 1], weight: 0.4 },
  team_role_balance: { perspective: 'self', range: [0, 1], weight: 0.6 },
  team_composition_conflict: { perspective: 'self', range: [0, 1], weight: -0.5 },
  team_extra_action_coverage: { perspective: 'self', range: [0, 1], weight: 0.8 },
  team_pierce_coverage: { perspective: 'self', range: [0, 1], weight: 0.6 },
  team_conversion_coverage: { perspective: 'self', range: [0, 1], weight: 0.3 },
  team_seat_adjacency: { perspective: 'self', range: [0, 1], weight: 0.2 },
  first_act_control: { perspective: 'self', range: [0, 1], weight: 0.2 },
  tempo: { perspective: 'self', range: [-2, 2], weight: 1.5 },
};

export const FEATURE_REGISTRY = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, Object.freeze({ key, ...value, range: Object.freeze(value.range.slice()) })])));

export function featureKeys() {
  return Object.keys(FEATURE_REGISTRY);
}

export function normalizeFeatures(features = {}) {
  return Object.fromEntries(featureKeys().map(key => {
    const definition = FEATURE_REGISTRY[key];
    const raw = Number(features[key] ?? 0);
    const value = Number.isFinite(raw) ? raw : 0;
    return [key, Math.max(definition.range[0], Math.min(definition.range[1], value))];
  }));
}
