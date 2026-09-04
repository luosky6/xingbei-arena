// 角色职责与组合协同的纯函数层。
// 输入只接受公开的角色/技能/卡牌文本；输出是可落盘、可用于候选排序
// 的多维向量。文本分类是先验假设，必须由竞技场消融对局验证后才能升级。

export const ROLE_DIMENSIONS = Object.freeze(['damage', 'heal', 'resource', 'control', 'defense', 'finisher', 'setup', 'draw', 'discard', 'position', 'cup', 'extra_action', 'extra_turn', 'pierce', 'aoe', 'conversion', 'complexity']);

const PATTERNS = Object.freeze({
  damage: /伤害|攻击|法术|输出|额外+?1.*伤害|强制命中|必中/,
  heal: /治疗|回复|抵御|恢复/,
  resource: /宝石|水晶|能量|星石|提炼|资源/,
  control: /横置|虚弱|中毒|封印|无法应战|不能应战|控制|挑衅/,
  defense: /圣盾|保护|无视伤害|抵挡|免疫|防御/,
  finisher: /星杯|合成|终结|致命|强制命中|必中|额外回合|额外行动/,
  setup: /标记|指示物|蓄力|充能|形态|准备|铺垫/,
  draw: /摸牌|抽牌|补牌|展示.*牌/,
  discard: /弃牌|丢弃|爆牌/,
  position: /座位|顺位|相邻|最近|传递|行动顺序|挑衅/,
  cup: /星杯|合成|杯区/,
  extra_action: /额外行动|追加行动|行动次数|连续行动/,
  extra_turn: /额外回合|追加回合|再进行一个回合/,
  pierce: /穿透|破防|强制命中|必中|无视.*盾/,
  aoe: /所有对手|全体|各对手|群体|范围/,
  conversion: /转化|转换|变为|视为/,
  complexity: /选择.*顺序|依次|分配|交换|多选|条件.*(?:若|当)/,
});

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join(' ');
  if (typeof value === 'object') return Object.values(value).map(textOf).join(' ');
  return String(value);
}

export function roleVector(input = {}) {
  const text = textOf(input.text ?? input.description ?? input.skills ?? input.cards ?? input);
  return Object.fromEntries(ROLE_DIMENSIONS.map(dimension => [dimension, PATTERNS[dimension].test(text) ? 1 : 0]));
}

function pairContribution(left, right) {
  const pair = (a, b, weight) => left[a] && right[b] ? weight : 0;
  return pair('resource', 'finisher', 1) + pair('finisher', 'resource', 1) +
    pair('control', 'damage', 0.8) + pair('damage', 'control', 0.8) +
    pair('heal', 'finisher', 0.7) + pair('finisher', 'heal', 0.7) +
    pair('setup', 'finisher', 0.5) + pair('finisher', 'setup', 0.5) +
    pair('extra_action', 'finisher', 0.7) + pair('finisher', 'extra_action', 0.7) +
    pair('pierce', 'damage', 0.5) + pair('damage', 'pierce', 0.5) +
    pair('aoe', 'control', 0.35) + pair('control', 'aoe', 0.35) +
    pair('conversion', 'resource', 0.35) + pair('resource', 'conversion', 0.35) +
    pair('position', 'damage', 0.35) + pair('damage', 'position', 0.35);
}

export function compositionProfile(players = []) {
  const vectors = (Array.isArray(players) ? players : []).map(player => ({ id: player?.id || player?.name || null, vector: roleVector(player) }));
  const count = Math.max(1, vectors.length);
  const coverage = Object.fromEntries(ROLE_DIMENSIONS.map(dimension => [dimension, vectors.reduce((sum, item) => sum + item.vector[dimension], 0) / count]));
  let synergy = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) for (let j = i + 1; j < vectors.length; j++) { synergy += pairContribution(vectors[i].vector, vectors[j].vector); pairs++; }
  // Multiple characters competing for the same narrow resource/finisher slot
  // is a soft conflict, not a hard legality rule.
  const conflict = Math.max(0, coverage.resource + coverage.finisher - 1.5) + Math.max(0, coverage.setup - 0.8);
  const activeDimensions = ROLE_DIMENSIONS.filter(dimension => coverage[dimension] > 0.25).length;
  const roleBalance = activeDimensions / ROLE_DIMENSIONS.length;
  return {
    vectors,
    coverage,
    pair_synergy: pairs ? Math.min(1, synergy / pairs / 2) : 0,
    conflict: Math.min(1, conflict),
    role_balance: roleBalance,
    evidence: 'static skill/card text classification; hypothesis until dynamic ablation evidence',
  };
}
