---
id: operations/special-actions
status: hypothesis
confidence: 0.7
evidence: { source: "static-code-analysis" }
updated: 2026-06-26
---

# 操作要点：特殊行动与额外行动的执行

> 通过决策桥执行时的"怎么做"与常见坑。决策端在 legal_options 中识别这些操作并据策略选择。

## 识别决策类型
- `decision_type` 区分：`chooseToUse`(出牌/选行动) / `chooseTarget`(选目标) / `chooseCard`(选牌) / `chooseControl`(选项) / `chooseBool`(是否发动) / `chooseButton`(选按钮)。
- legal_options 的 `kind`：`useCard` / `special`(gouMai/heCheng/tiLian) / `pass` / `useSkill` 等。

## 触发并延续"额外行动链"的操作思路
1. 优先选择 **会产生 `额外+1行动`** 的牌/技能（看技能文本与 state.actionsLeft 变化）。
2. 链中每一步都要保持"还能继续"的条件（如同一目标、命中、形态维持）。
3. 不要过早 `pass`：只要 `actionsLeft` 仍有余量或可解锁，应继续评估。

## 购买 vs 合成 vs 提炼（特殊行动）
- 见 tactics/cup-rush 的取舍：早期囤星石、中期合成冲杯、需要个人爆发时提炼成能量。
- 前置条件（手牌空位等）不满足时这些 option 不会出现在 legal_options 里——**不要臆造**。

## 决策桥铁律（对应 AGENTS.md 第3.2节）
- `choice` 必须是 `legal_options[].id`。
- 唯一合法 / 明显占优的决策应由 Bridge 走 fallback，不必调 LLM（省预算）。
- 观察到的真实机制写入 `rule_notes`，由 Distiller 固化进 rules/。

## 待验证
- [ ] 各 decision_type 在引擎里的字段细节（需阶段0桥接后补全）。
- [ ] 额外行动链在 UI/事件层的边界（何时真正结束）。
