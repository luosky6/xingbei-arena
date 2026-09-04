import test from 'node:test';
import assert from 'node:assert/strict';
import { installOverlay, rankCandidates } from '../ai-overlay/install.js';
import { bindEngine, setWeights, stateValue, featureVector, FEATURE_REGISTRY, FEATURE_SCHEMA_VERSION } from '../ai-overlay/valueFn.js';
import { compositionProfile, roleVector } from '../ai-overlay/lineup.js';
import { installModernTheme, uninstallModernTheme } from '../ui-overlay/install.js';

test('overlay installation is idempotent and updates side selection', () => {
  const status = { currentPhase: { side: true } };
  const engine = {
    lib: { skill: {}, translate: {}, config: {} },
    game: { players: [], hongShiQi: 15, lanShiQi: 15, hongXingBei: 0, lanXingBei: 0, hongZhanJi: [], lanZhanJi: [] },
    ui: {},
    get: { damageEffect: () => 0 },
    ai: { basic: {} },
    _status: status,
  };
  const first = installOverlay(engine, { shiqi_diff: 1 }, { side: true });
  assert.deepEqual(first, { installed: true, reused: false, side: true });
  const wrapped = engine.get.damageEffect;
  const second = installOverlay(engine, { shiqi_diff: 2 }, { side: false });
  assert.deepEqual(second, { installed: true, reused: true, side: false });
  assert.equal(engine.get.damageEffect, wrapped);
});

test('value function accounts for role-composition features without DOM access', () => {
  const player = (side, skill, cards = [], seatNum = null) => ({
    side,
    seatNum,
    skills: [skill],
    storage: {},
    zhiLiao: 1,
    getSkills: () => [skill],
    getCards: () => cards,
    countCards: () => cards.length,
    getHandcardLimit: () => 6,
    countMark: () => 0,
  });
  const game = {
    players: [player(true, 'support', [], 1), player(true, 'finisher', [], 2), player(false, 'enemy', [], 3)],
    hongShiQi: 15, lanShiQi: 12, hongXingBei: 1, lanXingBei: 0,
    hongZhanJi: ['baoShi'], lanZhanJi: [],
  };
  const engine = { game, get: {}, ui: {}, _status: { currentPhase: null, firstAct: game.players[0] }, lib: { skill: {
    support: { description: '治疗和保护队友，获得宝石' },
    finisher: { description: '额外行动并强制命中，推进星杯' },
    enemy: { description: '普通攻击' },
  }, translate: {} }, ai: { basic: {} } };
  bindEngine(engine);
  setWeights({ shiqi_diff: 1, team_pair_synergy: 2, team_finisher_coverage: 1 });
  assert.equal(Number.isFinite(stateValue(true)), true);
  game.lanShiQi = -2;
  setWeights({ shiqi_enemy_near0: 1 });
  assert.equal(stateValue(true), 6);
  const vector = featureVector(true);
  assert.equal(FEATURE_SCHEMA_VERSION, 'features.v1');
  assert.ok(Object.keys(FEATURE_REGISTRY).every(key => Object.hasOwn(vector, key)));
  assert.ok(vector.shiqi_enemy_near0 <= FEATURE_REGISTRY.shiqi_enemy_near0.range[1]);
  assert.equal(vector.team_seat_adjacency, 0.5);
  assert.equal(vector.first_act_control, 1);
  assert.ok(vector.team_extra_action_coverage >= 0);
  assert.ok(vector.team_pierce_coverage >= 0);
});

test('shallow candidate ranking is deterministic and preserves base score provenance', () => {
  const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const ranked = rankCandidates(candidates, candidate => ({ a: 1, b: 1, c: 0 }[candidate.id]), candidate => ({ a: 0, b: 0.2, c: 3 }[candidate.id]));
  assert.deepEqual(ranked.map(item => item.candidate.id), ['c', 'b', 'a']);
  assert.equal(ranked[0].baseScore, 0);
  assert.equal(ranked[0].bonusScore, 3);
  assert.equal(ranked.at(-1).baseScore, 1);
});

test('role composition exposes complementary responsibilities and soft conflicts', () => {
  assert.equal(roleVector({ text: '治疗和宝石资源' }).heal, 1);
  assert.equal(roleVector({ text: '额外行动、必中、交换顺序' }).extra_action, 1);
  assert.equal(roleVector({ text: '额外行动、必中、交换顺序' }).pierce, 1);
  assert.equal(roleVector({ text: '额外行动、必中、交换顺序' }).complexity, 1);
  const profile = compositionProfile([
    { id: 'support', text: '治疗、宝石、能量' },
    { id: 'finisher', text: '额外行动、强制命中、星杯' },
    { id: 'control', text: '横置、弃牌、无法应战' },
  ]);
  assert.ok(profile.coverage.resource > 0);
  assert.ok(profile.coverage.finisher > 0);
  assert.ok(profile.coverage.control > 0);
  assert.ok(profile.pair_synergy > 0);
  assert.ok(profile.role_balance > 0);
  assert.match(profile.evidence, /hypothesis/);
});

test('modern UI theme is reversible and does not require engine globals', async () => {
  const classes = new Set();
  const root = { dataset: {}, classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
  const body = { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
  const head = { appendChild: node => { head.node = node; } };
  const document = {
    documentElement: root,
    body,
    head,
    createElement: () => ({ id: '', textContent: '' }),
    getElementById: () => head.node,
  };
  const installed = await installModernTheme({ document, matchId: 'm1', policyId: 'policy', fetchImpl: async () => ({ ok: true, text: async () => 'body.xb-modern{}' }) });
  assert.equal(installed.installed, true);
  assert.equal(root.dataset.xbModernTheme, '1');
  assert.equal(root.dataset.xbMatchId, 'm1');
  assert.equal(classes.has('xb-modern'), true);
  assert.deepEqual(uninstallModernTheme(document), { installed: false });
  assert.equal(root.dataset.xbModernTheme, undefined);
  assert.equal(classes.has('xb-modern'), false);
});
