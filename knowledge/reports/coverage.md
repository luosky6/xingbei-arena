# 规则来源、事件与覆盖报告

生成时间：2026-09-03T00:00:00.000+08:00

- 引擎目录：`../noname_xingbei`
- 引擎指纹：`sha256:87969d59674cdcfda1060d35edbd924d12e20fa3d6aab60352726223cf18cc9d`
- 扫描源码文件：154
- 角色：119；技能：640；卡牌：11；事件：456；触发映射：214
- 解析失败/待人工队列：9
- 组合候选：7021（全部 hypothesis，尚无对局证据）

## 来源治理

规范规则来源是《星杯十周年说明书》（PDF 印刷页 00-21）；源码只记录当前 engine implementation。
- manual-text-extraction: partial — 核心规则已进入 curated/rules/rule-ontology-draft.json；仍需逐条与引擎动态行为裁定。
- official-supplements: registered — 官方 Q&A、无法行动专项、结算时间轴和技能表已登记；逐条编译待完成。
- engine-vs-manual: open — Do not promote engine behavior to normative truth without a curated adjudication.
- dynamic-computed-objects: open — Computed keys, spreads and dynamic registration require runtime confirmation.

## 事件目录

事件目录见 [events.json](../generated/events.json)。每项包含 createEvent/setContent/trigger map/event.trigger 来源、关键 event 字段和静态父子关系假设。静态父子关系不能替代运行时事件树。

## 座次与顺位

座位编号、红蓝阵营、firstAct、player.next/previous、team sequence 与 BP pick order 分别建模于 [seating.json](../generated/seating.json)，不能混用一个 seat 字段。

## 解析失败队列

- dynamic_or_spread_structure — character/boss.js:13 (character/skill object)
- dynamic_or_spread_structure — character/poXiao.js:4 (character/skill object)
- dynamic_or_spread_structure — character/sanBan.js:8 (character/skill object)
- dynamic_or_spread_structure — character/shenZiChuangLin.js:8 (character/skill object)
- dynamic_or_spread_structure — character/shiZhouNian.js:4 (character/skill object)
- dynamic_or_spread_structure — character/siBan.js:8 (character/skill object)
- dynamic_or_spread_structure — character/teDian.js:8 (character/skill object)
- dynamic_or_spread_structure — character/yiDuanYeHuo.js:8 (character/skill object)
- dynamic_or_spread_structure — character/zhongMoDaoZhu.js:8 (character/skill object)
