# 星杯竞技场知识库

本目录把“规则资料”和“引擎实现”分开治理，避免把当前 `noname_xingbei` 的缺陷自动当成完整世界规则。

`generated/` 由 `npm run knowledge:generate` 从指定引擎源码重复生成，禁止手工修改；它记录源码事实、引用、解析失败和静态假设。`curated/` 由人工结合《星杯十周年说明书》审校，任何与引擎不一致的地方都必须保留 `difference`，并填写 `adjudication_status`。`evidence/` 只收录动态对局和规则测试证据。

可机器化的十周年核心裁定位于 `../rules/adjudicator.mjs`，它是纯函数测试层，不替代角色/卡面专属裁定；轨迹或差异报告应同时记录规则版本、引擎指纹和测试 ID。

参数按 profile 隔离：`core10th` 对应基础 4/6 人、15 士气；`supplement8p` 对应补充资料的 4v4/8 人扩展、18 初始士气。运行结果的 `rules_profile` 与 `rules_version` 必须一起保存，禁止跨版本混合训练样本。

轨迹契约位于 `schema/trajectory.schema.json`；`bridge/validate-trajectory.mjs` 执行其关键约束（首尾元数据、局标识、规则版本、事件类型、序号和零丢失）。`bridge/replay-trajectory.mjs` 只重建公开资源曲线/决策序列，不冒充引擎重裁判；`bridge/build-manifest.mjs` 通过 SHA-256 和完整性结果把坏局标为 `quarantine`。

决策审计契约位于 `schema/decision.schema.json`；桥接器将候选特征、基线分数、选择来源、合法性、耗时和（若策略提供）外部分数写入 `runtime/decisions/events.jsonl`，与违规日志分离，供训练筛选和策略回溯使用。

每条规则至少包含四层：

1. `normative_rule`：规范资料中的规则文本或语义（P0 来源为 `../星杯十周年说明书.pdf`）。
2. `engine_behavior`：源码实际执行路径，只代表当前引擎版本。
3. `difference`：两者差异、未知项或待复现项，不能静默合并。
4. `adjudication_status`：`confirmed`、`hypothesis`、`conflict` 或 `needs_dynamic_test`。

静态推导出的角色定位、组合、座次收益和 ①~⑥ 映射统一标记为 `hypothesis`，只有带动态测试/对局证据后才能进入竞技场策略 skill。

## 证据等级与双向回链

规则与 skill 不共用一个“已验证”开关：

- `normative_confirmed`：官方资料、源码差异、正/负例和具体 `fixture_id` 均已审校；这是唯一可以进入规范裁定层的状态。
- `engine_verified`：只证明某个轨迹中声明的事件存在、父子关系或局部顺序；不代表卡面语义、隐藏信息或目标合法性正确。
- `hypothesis`：静态推演、单局观察或样本不足，只能驱动下一轮实验。
- `partial`：部分模式/条件已证实，边界和反制尚未覆盖。

每条进入 `confirmed` 的 curated rule 必须回链到具体 `dynamic_fixture_ids`；动态 fixture 也必须声明它验证的 `rule_id` 或明确标注为“覆盖索引”，不能批量把事件存在性报告冒充规则确认。`skills/meta/distillation-contract.v1.json` 定义了打法 skill 的样本、模式、阵容、座次、镜像/反制/消融和来源门禁，`npm run skills:audit` 只读扫描并生成审计报告。
