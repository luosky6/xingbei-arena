# Evidence staging area

这里保存尚未达到 skill 晋级门槛的实验摘要、对位/座次消融和角色技能证据。每个摘要必须包含：

- `experiment_id`、`match_ids`、seed 范围、模式、规则版本和引擎指纹；
- 阵容、红蓝换边、队内座次、BP/CM 顺位及策略版本；
- 预注册假设、正/反例、消融对照、样本量、胜法和 Wilson 区间；
- 使用的 `rule_id`/`dynamic_fixture_id`，以及已知隐藏信息和失败种子边界。

证据摘要默认是 `hypothesis` 或 `partial`，不直接供 Player 作为规范规则使用。满足 `skills/meta/distillation-contract.v1.json` 后，Distiller 才能提出晋级到 `skills/` 的变更；晋级前后都应保留原始 match id 以便复核。
