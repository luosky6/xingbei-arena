---
id: tactics/heal-suppression
status: hypothesis
confidence: 0.55
evidence: { source: "static-code-analysis" }
source_matches: []
updated: 2026-06-26
---

# 套路：破治疗 / 抗压（Heal-Suppression & Stall）

## 两个相关主题

### A. 破治疗（压制对面护盾）
- 治疗是承伤不掉士气的护盾。对治疗流，必须削弱治疗效率。
- 工具（待验证）：
  - 裁决者·真理裁决（你造成的伤害最多被 1 点治疗抵御）。
  - 血色剑灵·血蔷薇庭院（在场时所有治疗无法抵御伤害）。
  - 圣殿骑士·神威、兽灵武士·一击无念（穿防/无视抵挡）。
- 思路：先废掉治疗，再走 force-draw-then-burn。

### B. 抗压 / 拖延（拖到资源/冲杯翻盘）
- 工具：霜雪公主/圣庭检察士（群体治疗）、月之女神·新月庇护、勇者·死斗、圣殿骑士·神之子（士气保底1）。
- 思路：用治疗 + 士气保底吃过对手爆发回合，靠冲杯或反打翻盘。

## 验证计划
- "治疗流 vs 破治疗" 与 "爆发流 vs 抗压拖延" 两组对位，看克制关系是否成立、阈值在哪。
- 指标：场均 add_zhiliao、对手 change_shiqi 被压低幅度、平均回合数。
