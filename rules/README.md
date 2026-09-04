# 规范裁定层

`adjudicator.mjs` 是十周年核心规则的纯函数表达：它不导入引擎、不操作 DOM，也不替代角色/卡面专属技能。用途是：

- 为轨迹回放提供可重复的胜利线、伤害、爆牌和资源结果；
- 为 `engine_behavior` 与 `normative_rule` 做差异测试；
- 给 AI 特征计算提供不依赖浏览器的基础规则函数。

规则参数按版本 profile 隔离：`core10th` 只接受基础说明书的 4/6 人（2v2/3v3，初始士气 15）；`supplement8p` 接受 4/6/8 人，并将 8 人 4v4 的初始士气设为 18。调用 `validateSetup({ players: 8, profile: 'supplement-8p' })` 显式选择扩展线，禁止把扩展参数悄悄套入基础局。

扩展角色、转化、无法行动专项、时间轴插入和版本差异必须以独立数据追加，不能修改通用函数来“硬塞”专属例外。所有裁定结果都应带规则版本和来源 ID。

官方“无法行动”专项表的当前索引位于 `knowledge/curated/rules/no-action-cases.json`：其中 `principles` 保存规范层原则，
`role_defaults` 保存角色族和引擎 ID 对照，`cases` 保存已经转成 `noActionEligibility` 输入的代表性情境。该文件明确标记为
`indexed_partial`；未完成的角色特例不得被通用规则默认值覆盖。

`timing.mjs` 只冻结六时点（①发动、②命中、③造成、④治疗、⑤实际产生、⑥实际承受）及可复现的同点座次排序；源码事件名到时点的映射必须引用对应版本官方结算时间轴，并保持 `hypothesis` 直到动态测试确认。

`applyMoraleLoss` 同时返回 `rawAfter`、规范展示值 `displayAfter` 和 `defeated`，专门防止引擎在致死伤害后保留负士气时污染策略特征；是否裁剪存储值由引擎实现层单独记录。

## 最小场景夹具

`fixtures.v1.json` 保存可机器执行的规则边界案例，覆盖开局 profile、胜利线、摸牌爆牌、伤害六时点、购买/合成、提炼、无法行动、座次和同点时序。运行
`npm run rules:fixtures` 会生成 `runtime/reports/rule-fixtures.v1.json`。

夹具报告中的 `status=pass` 只表示规范纯函数与预期一致；`engine_status=not_run` 是有意保留的隔离标记。浏览器动态场景必须另行记录 `fixture_id`、match id、引擎指纹和差异，不能把规范夹具通过直接当成引擎已验证。

`npm run convergence:check` 会把规范夹具、动态规则状态、严格轨迹、决策覆盖、分组数据和挑战者门禁汇总为 `runtime/reports/convergence.v1.json`。任一条件缺失都只输出 `not_converged`，不改变规则或 champion。

`npm run rules:event-evidence` 扫描轨迹中真实出现的引擎事件名、计数和有限时序样本，生成 `rule-event-evidence.v1`。报告默认标记 `observed_partial`/`not_verified`；事件名出现并不等价于卡面文本、目标合法性或结算语义已验证。

`npm run rules:dynamic-patterns` 进一步检查事件父子关系和局部顺序（例如 `damage` 子事件 `draw`、伤害响应插入、`useCard`→`damage`、`_baoPai` 嵌套、购买/合成/提炼路径），仍只输出 `observed_partial/not_verified`，需要 fixture_id 绑定的动态场景才能升级。
