/**
 * ai-overlay/valueFn.js
 * 星杯模式状态价值函数 V(side) 与 victim 估值。
 *
 * 核心算式和技能文本驱动的连锁/穿防/手牌质量/标记特征已实现；特征仍是
 * 启发式近似，必须经过配对自对弈验证后才能晋级为正式策略。
 * ⚠️ 不修改 noname_xingbei：本文件仅“读取”引擎运行时对象 (game/get/ui)，作为 overlay 加载。
 *
 * 设计依据：ai-overlay/value-function.md 的特征表 + skills/ 的规则结论。
 */

import { FEATURE_REGISTRY, FEATURE_SCHEMA_VERSION, normalizeFeatures } from './featureRegistry.js';
import { compositionProfile } from './lineup.js';

// 由 install.js 注入引擎引用，避免在此硬编码 import 路径。
let game, get, ui, lib, _status;
export function bindEngine(refs) { ({ game, get, ui, lib, _status } = refs); }

let W = {};
export function setWeights(weights) { W = weights || {}; }

/** 当配置了单侧 overlay 时，只在该阵营行动/评估时生效。 */
export function overlayActive(side) {
  const configured = _status?.xbOverlaySide;
  return configured == null || side == null || configured === side;
}

export { FEATURE_REGISTRY, FEATURE_SCHEMA_VERSION };

/** side: true=红, false=蓝 */
function teamShiQi(side) { return side ? game.hongShiQi : game.lanShiQi; }
function teamXingBei(side) { return side ? game.hongXingBei : game.lanXingBei; }
function teamZhanJi(side) { return (side ? game.hongZhanJi : game.lanZhanJi) || []; }
function playersOfSide(side) { return game.players.filter(p => p.side === side); }
function normalizedMorale(value) { return Math.max(0, Number(value) || 0); }

/** 单角色“被爆士气暴露度” = max(0, 手牌满度 − 治疗) */
function burnExposure(p) {
  // 更直观：手牌越接近上限、治疗越少，越易掉士气
  const nearLimit = p.countCards('h') / Math.max(1, p.getHandcardLimit());
  return Math.max(0, nearLimit * 2 - (p.zhiLiao || 0));
}

function skillText(p) {
  const ids = (typeof p.getSkills === 'function' ? p.getSkills('invisible') : p.skills) || [];
  return ids.map(id => {
    const info = lib?.skill?.[id] || {};
    return [id, lib?.translate?.[`${id}_info`], info.description, info.prompt, info.name].filter(Boolean).join(' ');
  });
}

function handCards(p) {
  try { return typeof p.getCards === 'function' ? p.getCards('h') || [] : []; } catch { return []; }
}

function cardText(card) {
  if (!card) return '';
  const name = card.name || card.viewAs || '';
  return [name, lib?.translate?.[name], lib?.translate?.[`${name}_info`]].filter(Boolean).join(' ');
}

/** 统计可延长当前回合的显式技能/牌语义；未知文本不强行推断。 */
function chainPotential(p) {
  const texts = [...skillText(p), ...handCards(p).map(cardText)];
  return texts.reduce((n, text) => n + (/额外\s*(?:\+?\d+)?\s*(?:攻击|法术|行动)|额外行动|额外回合/.test(text) ? 1 : 0), 0);
}

/** 统计已知的穿防、必中和禁止应战语义；只作为启发式特征。 */
function piercePotential(p) {
  const texts = [...skillText(p), ...handCards(p).map(cardText)];
  return texts.reduce((n, text) => n + (/无法应战|不能应战|不可应战|强制命中|必中|无视【?圣盾|无视圣盾/.test(text) ? 1 : 0), 0);
}

/** 命格/系别契合度：以角色技能文本关键词匹配当前手牌。 */
function handQuality(p) {
  const cards = handCards(p);
  if (!cards.length) return 0;
  const roleText = skillText(p).join(' ');
  const keys = ['风', '水', '火', '雷', '地', '暗', '圣', '技', '魔', '战'];
  const wanted = keys.filter(key => roleText.includes(key));
  if (!wanted.length) return 0;
  let matched = 0;
  for (const card of cards) if (wanted.some(key => cardText(card).includes(key))) matched++;
  return matched / cards.length;
}

/** 汇总带 mark 标记的技能存量，避免把任意 storage 数字误当资源。 */
function markersBanked(p) {
  const ids = (typeof p.getSkills === 'function' ? p.getSkills('invisible') : p.skills) || [];
  let total = 0;
  for (const id of ids) {
    const info = lib?.skill?.[id] || {};
    if (!info.mark && !info.marktext && !info.intro) continue;
    try { total += Math.max(0, Number(p.countMark?.(id) || 0)); } catch {}
  }
  return Math.min(5, total) / 5;
}

function capabilityScore(p, pattern) {
  return pattern.test([...skillText(p), ...handCards(p).map(cardText)].join(' ')) ? 1 : 0;
}

/** 角色组合覆盖度：只从文字中提取可解释的能力族，未知技能不强行归类。 */
function teamCapabilities(side) {
  const roster = playersOfSide(side);
  const profile = compositionProfile(roster.map(player => ({ id: player.name1 || player.name, skills: skillText(player), cards: handCards(player).map(cardText) })));
  return { control: profile.coverage.control, support: Math.max(profile.coverage.heal, profile.coverage.resource), finisher: profile.coverage.finisher, pairSynergy: profile.pair_synergy, resource: profile.coverage.resource, damage: profile.coverage.damage, defense: profile.coverage.defense, extraAction: profile.coverage.extra_action, pierce: profile.coverage.pierce, conversion: profile.coverage.conversion, roleBalance: profile.role_balance, conflict: profile.conflict };
}

/** 座次特征：只使用公开的 seat/side/firstAct，不把数组下标当座位。 */
function seatingFeatures(side) {
  const rows = (Array.isArray(game?.players) ? game.players : []).map((player, sourceIndex) => ({ player, sourceIndex, seat: Number.isInteger(Number(player?.dataset?.position)) ? Number(player.dataset.position) : Number.isInteger(player?.seatNum) ? player.seatNum : NaN })).filter(row => Number.isFinite(row.seat)).sort((left, right) => left.seat - right.seat || left.sourceIndex - right.sourceIndex);
  if (rows.length < 2 || new Set(rows.map(row => row.seat)).size !== rows.length) return { adjacency: 0, firstActControl: 0 };
  const own = rows.filter(row => row.player?.side === side);
  let ownEdges = 0;
  rows.forEach((row, index) => { const next = rows[(index + 1) % rows.length]; if (row.player?.side === side && next?.player?.side === side) ownEdges++; });
  const firstActSide = _status?.firstAct?.side;
  return { adjacency: Math.max(0, Math.min(1, ownEdges / Math.max(1, own.length))), firstActControl: firstActSide === side ? 1 : 0 };
}

/**
 * 状态价值：站在 side 视角的全局评估（标量，越大越好）。
 */
export function stateValue(side) {
  const f = featureVector(side);
  let v = 0;
  for (const k in f) v += (W[k] || 0) * f[k];
  return v;
}

/** 返回经过 registry 范围约束的、可直接落盘/训练的特征向量。 */
export function featureVector(side) {
  const opp = !side;
  const myShi = normalizedMorale(teamShiQi(side)), enShi = normalizedMorale(teamShiQi(opp));
  const myCup = teamXingBei(side), enCup = teamXingBei(opp);
  const myPlayers = playersOfSide(side), enPlayers = playersOfSide(opp);
  const capabilities = teamCapabilities(side);
  const seating = seatingFeatures(side);

  const f = normalizeFeatures({
    shiqi_diff: myShi - enShi,
    shiqi_enemy_near0: Math.min(6, Math.max(0, 6 - enShi)),
    shiqi_self_near0: Math.min(6, Math.max(0, 6 - myShi)),
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
    team_control_coverage: capabilities.control,
    team_support_coverage: capabilities.support,
    team_finisher_coverage: capabilities.finisher,
    team_pair_synergy: capabilities.pairSynergy,
    team_resource_coverage: capabilities.resource,
    team_damage_coverage: capabilities.damage,
    team_defense_coverage: capabilities.defense,
    team_role_balance: capabilities.roleBalance,
    team_composition_conflict: capabilities.conflict,
    team_extra_action_coverage: capabilities.extraAction,
    team_pierce_coverage: capabilities.pierce,
    team_conversion_coverage: capabilities.conversion,
    team_seat_adjacency: seating.adjacency,
    first_act_control: seating.firstActControl,
    tempo: tempoEstimate(side),
  });
  return f;
}

/** victim 估值：包装/增强 get.damageEffect。仅对敌方目标增益。 */
export function victimValue(origDamageEffect, target, num) {
  let base = origDamageEffect(target, num); // 原版：按手牌余量
  if (!target || target.side === (_status.currentPhase && _status.currentPhase.side)) return base;
  const vw = W.victim || {};
  const enShi = normalizedMorale(teamShiQi(target.side));
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

function tempoEstimate(side) {
  // 两条胜利线归一到约 [-1,1]，避免杯数和士气绝对量纲互相淹没。
  const cupRace = (teamXingBei(side) - teamXingBei(!side)) / 5;
  const moraleRace = (normalizedMorale(teamShiQi(!side)) - normalizedMorale(teamShiQi(side))) / 15;
  return cupRace + moraleRace;
}

/** 集火目标：由态度钩子标记（install.js 设置 _status.xb_focus）。 */
function isFocusTarget(target) {
  return _status && _status.xb_focus && _status.xb_focus === target;
}
