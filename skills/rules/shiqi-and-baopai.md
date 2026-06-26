---
id: rules/shiqi-and-baopai
status: hypothesis            # 来自静态代码分析，待对局验证升级为 verified
confidence: 0.85
evidence: { source: "static-code-analysis", files: ["noname/library/element/content.js#damage", "noname/game/index.js#changeShiQi"] }
updated: 2026-06-26
---

# 士气与爆牌（核心生命循环）

## 规则要点（已从代码确认）
- **没有传统掉血死亡**。`damage()`（content.js ~10804）不直接扣 hp，而是：
  1. 结算伤害点数 `num`（攻击伤害 / 法术伤害，由 `faShu` 标记区分）。
  2. 若目标有 `治疗(zhiLiao)>0` 且本次可被治疗抵消 → 优先消耗治疗减伤。
  3. 剩余伤害 → 目标**被迫摸 `num` 张牌**（`cause='damage'`）。
  4. 摸后手牌 > 手牌上限 → **爆牌(baoPai)** 强制弃超出部分。
  5. **每弃 1 张爆牌 → 该队士气 -1**（`changeShiQi(-弃牌数)`）。
- 胜负：对方士气 → 0 即败（或己方星杯达上限即胜）。

## 对 AI / 决策的含义
- 伤害的真实价值 = **min(伤害, 目标手牌余量被击穿的部分)** 才转化为士气损失。
  - 目标手牌余量 `chaZhi = 手牌上限 − 当前手牌`。
  - `chaZhi >= num`：本次基本不掉士气（只是逼摸牌）。
  - `chaZhi < num`：掉 `num - chaZhi` 点士气。
- 引擎 `get.damageEffect`（get/index.js ~5559）已按 `chaZhi` 评估，但**只看单目标、不看两队士气总盘**。
- **治疗是防爆牌护盾**；治疗充足时承伤几乎不掉士气。

## 衍生策略钩子
- 先让目标"补满/强制摸牌"再打伤害 → 等量伤害掉更多士气（见 tactics/force-draw-then-burn）。
- 集火"治疗低 + 手牌满 + 本队士气低"的敌人，单位伤害换士气效率最高。

## 待验证
- [ ] 治疗抵消的精确顺序与可被哪些伤害类型抵消的边界。
- [ ] "本次士气最少/最多为 X" 类保底技能对爆牌结算的精确影响。
