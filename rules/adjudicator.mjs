// 规范规则裁定层（纯函数）。
//
// 这里不驱动 DOM，也不修改 noname_xingbei；它表达十周年核心规则的
// 可机器化部分，供差异测试、轨迹重放和 AI 特征计算使用。遇到角色/卡面
// 专属文本时，调用方必须先经过该角色的扩展裁定，不得用本文件的通用
// 默认值覆盖专属规则。

export const BASE_RULES = Object.freeze({
  supportedPlayers: Object.freeze([4, 6]),
  initialMorale: 15,
  initialHand: 4,
  handLimit: 6,
  healLimit: 2,
  energyLimit: 3,
  teamStoneLimit: 5,
  cupsToWin: 5,
  baseAttackDamage: 2,
  drawPerDamage: 1,
  buyDraw: 3,
  synthesizeCost: 3,
  refineMax: 2,
});

// 8 人 4v4 是十周年补充资料中的独立参数线：不要把 18 点初始士气
// 泄漏到基础 4/6 人规则，也不要因基础说明书未写 8 人而拒绝引擎扩展局。
export const RULE_PROFILES = Object.freeze({
  core10th: BASE_RULES,
  supplement8p: Object.freeze({ ...BASE_RULES, supportedPlayers: Object.freeze([4, 6, 8]), initialMorale: 18 }),
});

export function getRuleProfile(profile = 'core10th') {
  const normalized = String(profile).replaceAll('-', '').replaceAll('_', '').toLowerCase();
  const key = normalized === 'supplement8p' || normalized === '10thsupplement8p' ? 'supplement8p' : normalized === 'core10th' || normalized === '10thcore' ? 'core10th' : null;
  if (!key) throw new RangeError(`unknown rule profile: ${profile}`);
  return RULE_PROFILES[key];
}

export function validateSetup({ players, morale, cupsToWin, profile = 'core10th' } = {}) {
  const rules = getRuleProfile(profile);
  const initialMorale = morale ?? rules.initialMorale;
  const targetCups = cupsToWin ?? rules.cupsToWin;
  if (!rules.supportedPlayers.includes(players)) throw new RangeError(`unsupported ${profile} player count: ${players}`);
  if (!Number.isInteger(initialMorale) || initialMorale <= 0) throw new RangeError(`morale must be a positive integer: ${initialMorale}`);
  if (!Number.isInteger(targetCups) || targetCups <= 0) throw new RangeError(`cupsToWin must be a positive integer: ${targetCups}`);
  return { profile, players, morale: initialMorale, cupsToWin: targetCups };
}

/** 返回所有已满足的胜利线；同时满足时保留 simultaneous，交给模式顺序裁定。 */
export function victoryLines({ ownMorale, opponentMorale, ownCups, opponentCups, cupsToWin = BASE_RULES.cupsToWin } = {}) {
  const lines = [];
  if (opponentMorale <= 0) lines.push('opponent_morale_zero');
  if (ownCups >= cupsToWin) lines.push('own_cups_reached');
  return lines.length > 1 ? ['simultaneous', ...lines] : lines;
}

export function resolveDraw({ handCount, drawCount, handLimit = BASE_RULES.handLimit } = {}) {
  const before = Math.max(0, Number(handCount) || 0);
  const draws = Math.max(0, Number(drawCount) || 0);
  const overflow = Math.max(0, before + draws - handLimit);
  return { handBefore: before, draws, handAfter: before + draws - overflow, overflow, moraleLoss: overflow };
}

/**
 * 士气规范视图与引擎存储视图分离：胜负只关心 <=0，展示值通常裁为0；
 * raw 保留用于解释“同一结算为何出现负存储值”的实现差异。
 */
export function applyMoraleLoss({ morale, loss = 0 } = {}) {
  const before = Number.isFinite(Number(morale)) ? Number(morale) : 0;
  const amount = Math.max(0, Number(loss) || 0);
  const rawAfter = before - amount;
  return { before, loss: amount, rawAfter, displayAfter: Math.max(0, rawAfter), defeated: rawAfter <= 0 };
}

/** 伤害先在③确定，再在④以治疗抵御，⑤得到实际伤害，⑥才摸牌并爆牌。 */
export function resolveDamage({ damage, healing = 0, handCount, handLimit = BASE_RULES.handLimit, damageKind = 'attack' } = {}) {
  const createdDamage = Math.max(0, Number(damage) || 0);
  const availableHealing = Math.max(0, Number(healing) || 0);
  const prevented = Math.min(createdDamage, availableHealing);
  const actualDamage = createdDamage - prevented;
  const draw = resolveDraw({ handCount, drawCount: actualDamage * BASE_RULES.drawPerDamage, handLimit });
  return { damageKind, createdDamage, healingUsed: prevented, actualDamage, damageDraw: draw.draws, ...draw };
}

export function canBuy({ handCount, handLimit = BASE_RULES.handLimit, drawCount = BASE_RULES.buyDraw } = {}) {
  return resolveDraw({ handCount, drawCount, handLimit }).overflow === 0;
}

export function canSynthesize({ handCount, handLimit = BASE_RULES.handLimit, teamStones, cost = BASE_RULES.synthesizeCost } = {}) {
  return Number(teamStones) >= cost && canBuy({ handCount, handLimit });
}

export function synthesize({ teamStones, ownCups, opponentMorale, handCount, handLimit = BASE_RULES.handLimit, cost = BASE_RULES.synthesizeCost } = {}) {
  if (!canSynthesize({ handCount, handLimit, teamStones, cost })) return { legal: false, reason: 'insufficient_stones_or_hand_overflow' };
  return { legal: true, teamStones: teamStones - cost, ownCups: ownCups + 1, opponentMorale: opponentMorale - 1, draw: resolveDraw({ handCount, drawCount: BASE_RULES.buyDraw, handLimit }) };
}

export function refine({ teamStones, energy, amount, energyLimit = BASE_RULES.energyLimit } = {}) {
  const n = Math.max(0, Math.min(BASE_RULES.refineMax, Number(amount) || 0));
  const available = Math.max(0, Math.min(Number(teamStones) || 0, n, energyLimit - (Number(energy) || 0)));
  return { amount: available, teamStones: (Number(teamStones) || 0) - available, energy: Math.min(energyLimit, (Number(energy) || 0) + available) };
}

/**
 * 无法行动专项的通用门槛。角色专属 mandatoryStart、抹杀行动可能和判罚
 * 由扩展数据补入；通用层只负责把“仍可提炼”与“正常行动必须执行”分开。
 */
export function noActionEligibility({ normalActions = 0, canRefine = false, mandatoryStartsPending = 0, actionPossibilityRemoved = false, taunted = false, startupUsed = false, startupCanIncreaseActions = false } = {}) {
  // 勇者挑衅是专项表明确列出的例外：本应“必须启动”的情形改为
  // 跳过接下来的行动阶段，不进行弃牌/补牌，也不把它当普通宣言。
  if (taunted && mandatoryStartsPending > 0) return { eligible: true, reason: 'taunt_skip_action_phase', canRefine: false, postDeclaration: { mode: 'skip_action_phase', discardHand: false, drawEqual: false, specialActionsAllowed: false } };
  if (startupCanIncreaseActions && !startupUsed && mandatoryStartsPending > 0) return { eligible: false, reason: 'startup_must_increase_action' };
  if (mandatoryStartsPending > 0) return { eligible: false, reason: 'mandatory_start_pending' };
  if (normalActions > 0) return { eligible: false, reason: 'normal_action_exists' };
  if (actionPossibilityRemoved) return { eligible: false, reason: 'cannot_voluntarily_remove_action_possibility' };
  return { eligible: true, canRefine, postDeclaration: { mode: 'declare_no_action', discardHand: true, drawEqual: true, specialActionsAllowed: false, sealTriggered: false, requiresConsensus: true } };
}

/** 从当前行动者开始，按顺时针/逆时针返回座位；不携带阵营语义。 */
export function seatOrder(seats, currentSeat, direction = 'clockwise') {
  const list = [...seats];
  const index = list.indexOf(currentSeat);
  if (index < 0) throw new RangeError(`unknown current seat: ${currentSeat}`);
  const step = direction === 'counterclockwise' ? -1 : 1;
  return list.slice(1).map((_, offset) => list[(index + step * (offset + 1) + list.length * 2) % list.length]);
}
