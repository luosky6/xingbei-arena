/**
 * ai-overlay/install.js
 * 把优化AI以 overlay 形式注入运行中的引擎。
 *
 * ⚠️ 不修改 noname_xingbei 源文件：仅在运行时猴补丁(monkey-patch)引擎暴露的对象。
 * 安装器在引擎初始化完成后调用；重复调用幂等，允许仅刷新权重和侧别。
 *
 * 用法（伪代码，具体由阶段0的 harness 决定）：
 *   import * as engine from '../../noname_xingbei/noname.js'; // 读取引擎API
 *   import { installOverlay } from './install.js';
 *   installOverlay(engine, weights);
 */

import { bindEngine, overlayActive, setWeights, stateValue, victimValue } from './valueFn.js';

export function installOverlay(engine, weights, options = {}) {
  const { lib, game, ui, get, ai, _status } = engine;
  if (!get || !_status || !game) throw new TypeError('installOverlay requires engine game/get/_status');
  bindEngine({ lib, game, ui, get, _status });
  setWeights(weights);
  _status.xbOverlaySide = options.side === true || options.side === false ? options.side : null;

  // Browser reloads and test harnesses may call the installer more than once.
  // Keep one wrapper per API; later calls only refresh weights/side selection.
  if (_status.xbOverlayInstalled) return { installed: true, reused: true, side: _status.xbOverlaySide };
  _status.xbOverlayInstalled = true;

  // 暴露 V 供搜索/调试使用
  get.stateValue = stateValue;

  // ---- Hook 1: victim 估值升级（包装 get.damageEffect） ----
  const origDamageEffect = get.damageEffect.bind(get);
  const wrappedDamageEffect = function (target, num) {
    if (!overlayActive(_status.currentPhase?.side)) return origDamageEffect(target, num);
    return victimValue(origDamageEffect, target, num);
  };
  Object.defineProperty(wrappedDamageEffect, '__xbOverlayWrapped', { value: true });
  Object.defineProperty(wrappedDamageEffect, '__xbOverlayOriginal', { value: origDamageEffect });
  get.damageEffect = wrappedDamageEffect;

  // ---- Hook 2: 浅层搜索注入（包装 ai.basic.chooseTarget / chooseCard） ----
  // 思路：原版逐候选用 check() 打分取最高；这里在“分差接近”时改用 V 的 ΔV 复评。
  if (weights.search && weights.search.enabled) {
    wrapWithShallowSearch(ai, get, _status, weights.search, game);
  }

  // ---- Hook 3: 威胁/集火态度（不动 rawAttitude，用 per-player modAttitude 钩子） ----
  installFocusAttitude(game, get, _status, weights, _status.xbOverlaySide);

  // ---- Hook 4: LLM 决策桥由 bridge/decisionBridge.mjs 独立注入 ----
  // overlay 只负责启发式估值，不与外部信箱耦合，便于红蓝换边评测。

  if (lib.config && lib.config.dev) console.log('[xb-overlay] installed');
  return { installed: true, reused: false, side: _status.xbOverlaySide };
}

/**
 * 浅层搜索包装：对“连续行动链”最关键的攻击/目标选择，用 V 做 1~2 步前瞻。
 * 这里给出轻量(解析式)版骨架：不真正执行事件，用 V 的特征近似 ΔV。
 */
/**
 * 对候选动作做稳定、可解释的重排。baseScore 仍来自引擎原有 check，
 * bonus 只使用当前公开状态推导的浅层增益；平分时保留引擎候选顺序。
 */
export function rankCandidates(candidates, check, bonus = () => 0) {
  return (Array.isArray(candidates) ? candidates : []).map((candidate, index, all) => {
    let baseScore = 0;
    try { baseScore = Number(check(candidate, all)) || 0; } catch {}
    let bonusScore = 0;
    try { bonusScore = Number(bonus(candidate, index, all)) || 0; } catch {}
    return { candidate, index, baseScore, bonusScore, score: baseScore + bonusScore };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
}

function handCount(player) {
  try { return typeof player?.countCards === 'function' ? player.countCards('h') : (player?.getCards?.('h') || []).length; } catch { return 0; }
}

function targetBonus(target, actor, cfg, game) {
  if (!target || !actor || target.side === actor.side) return 0;
  const limit = Math.max(1, Number(target.getHandcardLimit?.() ?? 6) || 6);
  const exposure = Math.max(0, Math.min(2, handCount(target) / limit * 2 - (Number(target.zhiLiao) || 0)));
  const enemyMorale = target.side ? Number(game?.hongShiQi) : Number(game?.lanShiQi);
  const moraleUrgency = Number.isFinite(enemyMorale) ? Math.max(0, Math.min(1, (6 - Math.max(0, enemyMorale)) / 6)) : 0;
  const focusWeight = Number(cfg?.target_focus_weight ?? 0.25);
  return (exposure + moraleUrgency) * (Number.isFinite(focusWeight) ? focusWeight : 0.25);
}

function cardBonus(card, cfg) {
  const text = String(card?.name || card?.viewAs || '');
  let bonus = 0;
  if (/额外行动|额外回合/.test(text)) bonus += Number(cfg?.card_chain_weight ?? 0.12);
  if (/无法应战|强制命中|必中|无视.*盾/.test(text)) bonus += Number(cfg?.card_pierce_weight ?? 0.08);
  return Number.isFinite(bonus) ? bonus : 0;
}

function dominantBaseMargin(ranked) {
  if (!ranked.length) return 0;
  return (ranked[0]?.baseScore ?? 0) - (ranked[1]?.baseScore ?? 0);
}

function wrapWithShallowSearch(ai, get, _status, cfg, game) {
  const origChooseTarget = ai.basic.chooseTarget.bind(ai.basic);
  ai.basic.chooseTarget = function (check) {
    if (typeof get.selectableTargets !== 'function') return origChooseTarget(check);
    let candidates;
    try { candidates = get.selectableTargets(); } catch { return origChooseTarget(check); }
    const ranked = rankCandidates(candidates, check, target => targetBonus(target, _status?.event?.player, cfg, game));
    if (ranked.length < 2 || dominantBaseMargin(ranked) > Number(cfg?.skip_if_dominant_margin ?? 2)) return origChooseTarget(check);
    const byCandidate = new Map(ranked.map(item => [item.candidate, item.bonusScore]));
    return origChooseTarget((target, targets) => Number(check(target, targets) || 0) + (byCandidate.get(target) || 0));
  };

  const origChooseCard = ai.basic.chooseCard.bind(ai.basic);
  ai.basic.chooseCard = function (check) {
    let candidates = [];
    try { if (typeof get.selectableCards === 'function') candidates = get.selectableCards(); } catch {}
    if (candidates.length < 2) return origChooseCard(check);
    const ranked = rankCandidates(candidates, check, card => cardBonus(card, cfg));
    if (ranked.length < 2 || dominantBaseMargin(ranked) > Number(cfg?.skip_if_dominant_margin ?? 2)) return origChooseCard(check);
    const byCandidate = new Map(ranked.map(item => [item.candidate, item.bonusScore]));
    // Keep skill-string candidates and unusual engine objects on the original
    // path; only actual Card nodes receive the text-derived shallow bonus.
    return origChooseCard((card, cards) => Number(check(card, cards) || 0) + (typeof card === 'object' ? (byCandidate.get(card) || 0) : 0));
  };
}

// Legacy wrapper retained only as an inert source-history reference; the
// installer calls the functional wrapper above.
function wrapWithShallowSearchLegacy(ai, get, _status, cfg) {
  const origChooseTarget = ai.basic.chooseTarget.bind(ai.basic);
  ai.basic.chooseTarget = function (check) {
    return origChooseTarget(check); // legacy source-history fallback
  };

  const origChooseCard = ai.basic.chooseCard.bind(ai.basic);
  ai.basic.chooseCard = function (check) {
    // Legacy source-history fallback.
    return origChooseCard(check);
  };
}

/**
 * 集火态度：每回合标记一个“最该集火”的敌人到 _status.xb_focus，
 * 并通过 player.ai.modAttitudeTo 让对该目标的攻击态度更负(更想打)。
 */
function installFocusAttitude(game, get, _status, weights, overlaySide) {
  // 选择规则(来自 skills)：敌方中 (手牌满度高 & 治疗低 & 本队士气低) 优先。
  function pickFocus(side) {
    const enemies = game.players.filter(p => p.side !== side);
    let best = null, bestScore = -Infinity;
    for (const p of enemies) {
      const nearLimit = p.countCards('h') / Math.max(1, p.getHandcardLimit());
      const teamShi = p.side ? game.hongShiQi : game.lanShiQi;
      const score = nearLimit * 2 - (p.zhiLiao || 0) + Math.max(0, 6 - teamShi);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  _status.xb_pickFocus = pickFocus;

  // 给所有玩家装一个 modAttitudeTo，使对 focus 目标的负态度被放大。
  for (const p of game.players) {
    const prev = p.ai && p.ai.modAttitudeTo;
    p.ai = p.ai || {};
    p.ai.modAttitudeTo = function (from, to, att) {
      let a = prev ? prev(from, to, att) : att;
      const activeSide = _status.currentPhase?.side ?? from?.side;
      if (_status.xb_focus == null || _status.xb_focus.side === activeSide || !game.players.includes(_status.xb_focus)) {
        _status.xb_focus = pickFocus(activeSide);
      }
      if (overlaySide !== null && from?.side !== overlaySide) return a;
      if (_status.xb_focus && to === _status.xb_focus && from?.side !== to?.side && a < 0) {
        a *= 1.5; // 集火放大
      }
      return a;
    };
  }
}
