/**
 * ai-overlay/valueFn.js
 * 星杯模式状态价值函数 V(side) 与 victim 估值。
 *
 * ⚠️ 这是骨架 (scaffold)：核心算式已实现，标 TODO 的特征需在接通引擎后按真实 API 补全。
 * ⚠️ 不修改 noname_xingbei_clone：本文件仅“读取”引擎运行时对象 (game/get/ui)，作为 overlay 加载。
 *
 * 设计依据：ai-overlay/value-function.md 的特征表 + skills/ 的规则结论。
 */

// 由 install.js 注入引擎引用，避免在此硬编码 import 路径。
let game, get, ui, lib, _status;
export function bindEngine(refs) { ({ game, get, ui, lib, _status } = refs); }

let W = {};
export function setWeights(weights) { W = weights || {}; }

/** side: true=红, false=蓝 */
function teamShiQi(side) { return side ? game.hongShiQi : game.lanShiQi; }
function teamXingBei(side) { return side ? game.hongXingBei : game.lanXingBei; }
function teamZhanJi(side) { return (side ? game.hongZhanJi : game.lanZhanJi) || []; }
function playersOfSide(side) { return game.players.filter(p => p.side === side); }

/** 单角色“被爆士气暴露度” = max(0, 手牌满度 − 治疗) */
function burnExposure(p) {
  const fullness = p.countCards('h') - (p.getHandcardLimit() - p.countCards('h')); // 越满越正
  const exposure = Math.max(0, p.countCards('h') - (p.getHandcardLimit() - p.countCards('h')) ); // 占位
  // 更直观：手牌越接近上限、治疗越少，越易掉士气
  const nearLimit = p.countCards('h') / Math.max(1, p.getHandcardLimit());
  return Math.max(0, nearLimit * 2 - (p.zhiLiao || 0));
}

/** TODO: 统计手牌中可触发“额外行动”的牌/技数量（需技能元数据） */
function chainPotential(p) {
  // TODO: 扫描 p 手牌可转化技能 + 已有技能中带“额外+1行动”语义的数量
  return 0;
}

/** TODO: 统计手牌中“无法应战/必中/无视盾”能力数量 */
function piercePotential(p) {
  // TODO
  return 0;
}

/** TODO: 命格/系别契合度（手牌能转化成本角色技能的比例） */
function handQuality(p) {
  // TODO
  return 0;
}

/** TODO: 关键专属指示物存量归一化（信仰/斗气/鬼火…） */
function markersBanked(p) {
  // TODO: 读 p.storage 中已知指示物 / p.countMark(...)
  return 0;
}

/**
 * 状态价值：站在 side 视角的全局评估（标量，越大越好）。
 */
export function stateValue(side) {
  const opp = !side;
  const myShi = teamShiQi(side), enShi = teamShiQi(opp);
  const myCup = teamXingBei(side), enCup = teamXingBei(opp);
  const myPlayers = playersOfSide(side), enPlayers = playersOfSide(opp);

  const f = {
    shiqi_diff: myShi - enShi,
    shiqi_enemy_near0: Math.max(0, 6 - enShi),
    shiqi_self_near0: Math.max(0, 6 - myShi),
    xingbei_diff: myCup - enCup,
    xingbei_self_progress: myCup,
    zhanji_self: teamZhanJi(side).length,
    actions_left: actionsLeftOf(_status.currentPhase),
    chain_potential: sum(myPlayers, chainPotential),
    pierce_potential: sum(myPlayers, piercePotential),
    hand_quality_self: sum(myPlayers, handQuality),
    zhiliao_self_team: sum(myPlayers, p => (p.zhiLiao || 0)),
    enemy_burn_exposure: sum(enPlayers, burnExposure),
    self_burn_exposure: sum(myPlayers, burnExposure),
    markers_banked_self: sum(myPlayers, markersBanked),
    tempo: tempoEstimate(side),
  };

  let v = 0;
  for (const k in f) v += (W[k] || 0) * f[k];
  return v;
}

/** victim 估值：包装/增强 get.damageEffect。仅对敌方目标增益。 */
export function victimValue(origDamageEffect, target, num) {
  let base = origDamageEffect(target, num); // 原版：按手牌余量
  if (!target || target.side === (_status.currentPhase && _status.currentPhase.side)) return base;
  const vw = W.victim || {};
  const enShi = teamShiQi(target.side);
  base += (vw.w_low_shiqi || 0) * (-Math.max(0, 6 - enShi)); // 敌队濒死→更负(更想打)
  base += (vw.w_no_heal || 0) * ((target.zhiLiao === 0) ? -1 : 0);
  base += (vw.w_focus || 0) * (isFocusTarget(target) ? -1 : 0);
  return base;
}

// ---- 辅助 ----
function sum(arr, fn) { let s = 0; for (const x of arr) s += fn(x) || 0; return s; }

/** 本回合剩余/可解锁行动数（近似） */
function actionsLeftOf(p) {
  if (!p || !p.storage) return 0;
  const s = p.storage;
  return (s.gongJiOrFaShu || 0) + (s.gongJi || 0) + (s.faShu || 0) + ((s.extraXingDong && s.extraXingDong.length) || 0);
}

/** TODO: 节奏估计——谁更接近达成胜利线 */
function tempoEstimate(side) {
  // 占位：星杯进度 + 敌方濒死程度
  return teamXingBei(side) - teamShiQi(!side) / 15;
}

/** 集火目标：由态度钩子标记（install.js 设置 _status.xb_focus）。 */
function isFocusTarget(target) {
  return _status && _status.xb_focus && _status.xb_focus === target;
}
