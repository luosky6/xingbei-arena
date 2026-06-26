---
id: rules/action-economy
status: hypothesis
confidence: 0.85
evidence: { source: "static-code-analysis", files: ["noname/library/element/content.js#xingDong"] }
updated: 2026-06-26
---

# 行动经济（每回合行动数 = 强度核心）

## 规则要点（已从代码确认，content.js `xingDong` ~4451）
- 进入行动阶段时默认：`gongJiOrFaShu = 1`，`faShu = 0`，`gongJi = 0`，`extraXingDong = []`。
- **基础每回合只有 1 个行动**（一次【攻击行动】或【法术行动】）。
- 技能里的 `额外+1[攻击行动]/[法术行动]` 会压入 `extraXingDong` 队列或增加对应计数 →
  `xingDong` 的 step4→step5 循环会**连续执行**直到所有计数/队列耗尽。
- 三类行动：`gongJi`（攻击）/`faShu`（法术）/`gongJiOrFaShu`（二选一）。
- 特殊行动（购买/合成/提炼）在 `canTeShu` 允许时可在行动中执行。

## 对 AI / 决策的含义
- **连续行动链是本作第一强度来源**。能"行动→触发额外行动→再行动"的角色可在单回合滚出多次输出。
- 评估一次决策时，**必须考虑它是否解锁/延续额外行动**，而不仅是本次的即时收益。
- 这正是贪心 1-ply 内置 AI 的最大盲区（它不前瞻链条）。

## 触发额外行动的常见条件（示例，来自技能文本）
- "[攻击行动]结束后/结束时" 额外+1（风之剑圣·风怒追击、剑影；战斗法师等）。
- "命中时②/未命中时②" 触发追加行动。
- "[法术行动]结束后" 转+1[攻击行动]（法术激荡等）。
- 形态/指示物达标后释放的额外回合/额外行动（圣弓、月之女神等）。

## 待验证
- [ ] `extraXingDong` 的入队顺序（LIFO `pop`）对多来源叠加时的结算次序。
- [ ] 额外行动是否继承"首次行动"的特殊判定（`firstAction`）。
