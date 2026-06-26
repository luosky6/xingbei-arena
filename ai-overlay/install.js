/**
 * ai-overlay/install.js
 * 把优化AI以 overlay 形式注入运行中的引擎。
 *
 * ⚠️ 不修改 noname_xingbei_clone 源文件：仅在运行时猴补丁(monkey-patch)引擎暴露的对象。
 * ⚠️ 骨架：hook 点已标注；真正接通需在引擎初始化完成后调用 installOverlay()。
 *
 * 用法（伪代码，具体由阶段0的 harness 决定）：
 *   import * as engine from '../../noname_xingbei_clone/noname.js'; // 读取引擎API
 *   import { installOverlay } from './install.js';
 *   installOverlay(engine, weights);
 */

import { bindEngine, setWeights, stateValue, victimValue } from './valueFn.js';

export function installOverlay(engine, weights) {
  const { lib, game, ui, get, ai, _status } = engine;
  bindEngine({ lib, game, ui, get, _status });
  setWeights(weights);

  // 暴露 V 供搜索/调试使用
  get.stateValue = stateValue;

  // ---- Hook 1: victim 估值升级（包装 get.damageEffect） ----
  const origDamageEffect = get.damageEffect.bind(get);
  get.damageEffect = function (target, num) {
    return victimValue(origDamageEffect, target, num);
  };

  // ---- Hook 2: 浅层搜索注入（包装 ai.basic.chooseTarget / chooseCard） ----
  // 思路：原版逐候选用 check() 打分取最高；这里在“分差接近”时改用 V 的 ΔV 复评。
  if (weights.search && weights.search.enabled) {
    wrapWithShallowSearch(ai, get, _status, weights.search);
  }

  // ---- Hook 3: 威胁/集火态度（不动 rawAttitude，用 per-player modAttitude 钩子） ----
  installFocusAttitude(game, get, _status, weights);

  // ---- Hook 4: 旁路内置AI的接管点（供方案②决策桥使用） ----
  // 注意：本 overlay 是“更强的启发式AI”。若要切换到 LLM 决策，
  // 在此把 ai.basic.chooseX 替换为读写信箱(见 ../AGENTS.md 第3节)。
  // installDecisionBridge(ai, ...)   // TODO: 阶段0实现

  if (lib.config && lib.config.dev) console.log('[xb-overlay] installed');
}

/**
 * 浅层搜索包装：对“连续行动链”最关键的攻击/目标选择，用 V 做 1~2 步前瞻。
 * 这里给出轻量(解析式)版骨架：不真正执行事件，用 V 的特征近似 ΔV。
 */
function wrapWithShallowSearch(ai, get, _status, cfg) {
  const origChooseTarget = ai.basic.chooseTarget.bind(ai.basic);
  ai.basic.chooseTarget = function (check) {
    // TODO: 枚举 get.selectableTargets()，对每个候选估算 ΔV = V_after_est − V_before。
    //       V_before = get.stateValue(myside)。
    //       V_after_est：用 victimValue + 预计解锁的 actions_left 变化做解析估算。
    //       若 top1 与 top2 的原始 check 分差 > cfg.skip_if_dominant_margin → 直接走原版(省算力)。
    //       否则按 ΔV 重排后选择。
    return origChooseTarget(check); // 占位：先回退原版，确保可运行
  };

  const origChooseCard = ai.basic.chooseCard.bind(ai.basic);
  ai.basic.chooseCard = function (check) {
    // TODO: 同上，对“打哪张牌/转化成哪个技能”用 ΔV 复评，偏好解锁额外行动链的选择。
    return origChooseCard(check);
  };
}

/**
 * 集火态度：每回合标记一个“最该集火”的敌人到 _status.xb_focus，
 * 并通过 player.ai.modAttitudeTo 让对该目标的攻击态度更负(更想打)。
 */
function installFocusAttitude(game, get, _status, weights) {
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

  // TODO: 在每个行动阶段开始时调用 pickFocus 更新 _status.xb_focus。
  //       可挂在 overlay 自己的轮询里，或在 chooseTarget 包装内惰性计算。
  _status.xb_pickFocus = pickFocus;

  // 给所有玩家装一个 modAttitudeTo，使对 focus 目标的负态度被放大。
  for (const p of game.players) {
    const prev = p.ai && p.ai.modAttitudeTo;
    p.ai = p.ai || {};
    p.ai.modAttitudeTo = function (from, to, att) {
      let a = prev ? prev(from, to, att) : att;
      if (_status.xb_focus && to === _status.xb_focus && from.side !== to.side && a < 0) {
        a *= 1.5; // 集火放大
      }
      return a;
    };
  }
}
