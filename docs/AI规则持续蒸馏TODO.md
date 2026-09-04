# AI / 规则持续蒸馏 TODO

> 本文是 UI 方向之外的唯一执行清单。范围只包括 `xingbei-arena` 的规则真源、源码差异、决策桥、角色组合、座次建模、自对弈、AI 训练和 skill 蒸馏。UI 任务见 `docs/UI方向交接.md`，不得在本清单中混入 UI 改动。

## 0. 执行原则

1. 官方规则资料决定规范预期；`noname_xingbei` 只提供当前实现事实，不能自动升级为规范真源。
2. 任何规则修改先新增最小复现测试，再修改裁定函数；规则差异必须保留 `normative_rule`、`engine_behavior`、`difference` 和来源。
3. 对局只用于验证规则、发现边界和学习策略；单局、单阵容、单座次不能形成 skill 结论。
4. 所有训练行必须能追溯到 `match_id`、seed、规则版本、引擎指纹、策略版本、合法候选和终局结果。
5. 不能验证的能力必须标记 `partial`/`hypothesis`，不得用“脚本跑完”代替覆盖率。

## 1. 当前快照（2026-09-03）

- [x] 规则与 AI/UI 轨道拆分；UI 交接入口已固定。
- [x] 规范裁定层：伤害、治疗、爆牌、资源、胜利线、无法行动通用门槛、六时点和座次纯函数。
- [x] 座次 `seating.v1`：物理座位、引擎 `seatNum`、阵营、首行动者、前后座位、行动顺序、CM/BP 序列分列。
- [x] 决策桥：基础 `choose*`、主要复合动作、`chooseCardTarget` 单卡/单目标原子候选、`chooseToMove` 保留/成对交换。
- [x] 策略基线：`first_legal`、确定性随机、`heuristic`、`epsilon_greedy`；overlay 已接入全局/角色组合/座次特征。
- [x] 审计与结果关联：`decision.v1`、`ranking.v1`、`XB_RECORD_RESULT=1`。
- [x] 测试 61/61；最新决策覆盖 76 个轨迹文件、15,002 个决策点，partial/unmodeled/invalid/fallback 均为 0；全量决策审计 178,549 条（inline 8,510、pass 170,039），其中 timeout smoke 的 pass 记录仍隔离，不进入训练标签。
- [x] 第一轮受控矩阵已完成：2v2、3v3、4v4 各 1 局，均完整落盘；4v4 使用 `supplement-8p` 且初始士气 18，报告为 `runtime/reports/todo_round1_20260903.json`。
- [x] 规则最小场景夹具 v1 已建立并可执行，报告为 `runtime/reports/rule-fixtures.v1.json`；当前 15 个规范案例全部通过，动态引擎状态明确保持 `not_run`。
- [x] 收敛门禁已机器化：`npm run convergence:check` 汇总规则动态验证、严格轨迹、决策覆盖、分组数据和挑战者门禁；当前报告为 `not_converged`，不会自动修改规则或 champion。
- [x] 引擎事件动态盘点 runner 已建立：`npm run rules:event-evidence` 输出各规则区的真实事件计数/时序样本，但统一保持 `observed_partial` + `not_verified`，等待 fixture_id 绑定的最小场景审校。
- [x] 最新事件盘点覆盖 76 个轨迹文件、440 个事件名，5/5 规则区均有观测；报告 `runtime/reports/rule-event-evidence.v1.json` 的 `fully_verified=false`，因此仍不能替代动态裁定。
- [x] 动态父子/时序模式审计已建立：`npm run rules:dynamic-patterns` 输出 `rule-dynamic-patterns.v1`，将 damage→draw、响应插入、useCard→damage、爆牌嵌套与资源路径定位到可绑定的场景样本；`rules/dynamic-fixtures.v1.json` + `npm run rules:dynamic-fixtures` 已将 7/7 模式绑定到 fixture_id，当前 7/7 模式与 5/5 事件区断言通过，报告 `runtime/reports/rule-dynamic-fixtures.v1.json` 为 `engine_status=verified`、`fully_verified=true`（仅证明声明的可观测关系，不替代卡牌文本/隐藏信息审校）。
- [x] 严格轨迹门禁支持 `XB_MANIFEST_PREFIX`/`XB_MANIFEST_PATH`：历史 20 个旧/损坏轨迹保留为全局 quarantine；`todo_round1_20260903_` 预注册批次 3/3、175,569 条记录全部有效，清单 `runtime/reports/strict-manifest.todo-round1.v1.json`，不会通过删除历史文件人为清零。
- [x] 本轮桥接采集：`bridge_distill_16300`（2v2，147 回合）与 `bridge_distill_16310`（3v3，231 回合）均完成，均为 heuristic、红方 `shiqi0` 获胜；`bridge_distill_16301` 启动竞态超时并保留失败日志，后续 seed 不覆盖该失败证据。
- [x] 本轮 profile 采集补充：`bridge_distill_16320`（4v4 / `supplement-8p`，114 回合）完成，heuristic、蓝方 `shiqi0` 获胜；4/4/8 座位统计完整。
- [x] 已完成第一轮 10 个带终局标签的 match group（含 smoke + 9 个 distill seed）；训练冻结快照 `ranking.v1` 为 7,395 行、其中 4,812 行有终局结果，按整局切分 train 3,077 / valid 1,546 / test 189，已达到数据集可训练门槛；后续 Learned/paired smoke 作为 holdout，不回写该训练快照。
- [x] Learned-v1 离线候选已重训（去除绝对座位/索引泄漏）：模型 hash `sha256:3830108a020690cf2220fb16843298c3dc587478c5322140af69e84068faf841`；train/valid/test 的 pair accuracy 分别为 0.334/0.274/0.115，报告 `runtime/reports/learned-v1-sanity.v1.json`；指标偏低但更诚实，仅作 challenger，不代表在线提升。
- [x] Learned-v1 已接入统一 Policy registry（`learned_v1`），模型缺失/非法时显式记录 violation + fallback；在线 smoke 仍需与 heuristic 做配对门禁，当前不晋级。
- [x] Learned-v1 首次在线 smoke 暴露并定位绝对座位/索引过拟合（约 30k 合法空候选循环、未终局）；已将 `target_seat/target_side/index/card_index` 从模型特征排除，需重训后重新做在线 smoke。
- [x] 重训后 `learned_smoke_16351` 在线完成（111 回合、0 fallback/非法）；同 seed heuristic 对照及 retry 均超时，尚未形成有效 paired gate，不能宣称胜率提升。
- [x] 在稳定 heuristic seed 16330 上，`learned_pair_16330` 完成（82 回合、0 fallback/非法）；与 heuristic 16330（132 回合）仅形成 1 个同 seed 同模式观察对，仍不足以评测或晋级。
- [x] 晋级门禁已增加红/蓝换边配对校验：`evaluate:gate` 同时设置 `XB_GATE_RED_PREFIX`/`XB_GATE_BLUE_PREFIX` 时要求双方样本、公共 seed 和总样本均达到阈值；当前 `gate_r_20260903`/`gate_b_20260903` 共 10 局、5 个公共 seed、overlay 胜率 0.40、Wilson95 [0.168, 0.687]，状态 `insufficient_evidence`，不会晋级。
- [x] 角色矩阵补充：`matrix_two_roles_20260903` 2v2 3 局、`matrix_three_roles_20260903` 3v3 3 局、`matrix_four_roles_retry_20260903` 4v4 补充规则 1 局均已成功落盘；4v4 首次导航竞态失败保留在 `matrix_four_roles_20260903_203200`，未覆盖原失败证据。
- [ ] 收敛尚未完成：100 局稳定 baseline、全角色规则动态裁定、复杂多选、足量独立训练/验证/测试对局、正式 learned policy 和冠军晋级均待完成。当前严格批次的动态/轨迹门禁已通过，但这只是声明范围内的机器检查；完整目标仍受规则覆盖、技能语义、跨阵容打法证据和挑战者冠军报告共同约束。

### 1.1 规则提炼与 skill 蒸馏重审（2026-09-04）

本轮审计由 `npm run skills:audit` 生成 `runtime/reports/skill-distillation-audit.v1.json`，结论如下：

| 层级 | 机器审计结果 | 可以声称的结论 | 不能声称的结论 |
|---|---|---|---|
| 规范规则 | `rule-ontology-draft.json` 共 11 条，`confirmed=0`，均未绑定具体 `dynamic_fixture_ids` | 规范条目已分层并保留来源/差异 | 15/15 规范夹具通过不等于 11 条规则全部确认 |
| 引擎观测 | 动态夹具 12/12 通过 | 已证明所声明的事件存在性、父子关系和局部顺序 | 不能推出完整卡面语义、隐藏信息、目标合法性或所有角色技能正确 |
| skill 文件 | 11 个条目全部为 `hypothesis`，格式无硬错误，`promotion_ready=0` | 当前状态是保守且正确的研究假设库 | 不能把静态代码推演当作 verified 战术 |
| Learned-v1 | 离线 candidate；配对 gate 仍 `insufficient_evidence` | 可作为 challenger 继续测试 | 不能覆盖 heuristic 或写入 champion |

因此将蒸馏状态固定为四级：`hypothesis → partial → verified → deprecated`。规则条目另需 `adjudication_status=confirmed`；动态事件通过只属于 `engine_verified` 证据，不会自动提升规范状态。

新增不可绕过的晋级要求：

1. `rules/` 必须同时有官方来源、引擎行为、差异说明、具体 fixture 回链，以及至少一个负例/边界例；事件名存在性报告只能作为覆盖索引。
2. `operations/` 至少 100 个有效样本；`tactics/` 与 `meta/` 至少 300 个样本、2 个数值变体、2 种队内座次、3 个阵容族、2 个模式，并通过镜像/对位、反制和消融；所有结论带 `source_matches`、`rules_version` 和反制边界。
3. 角色技能与组合结论先进入 `knowledge/evidence/`/`open-questions.md`；在跨座次、换边和组合消融完成前，不写成高置信 skill。
4. 任何策略晋级仍需独立 seed/阵容族/座次的红蓝配对，以及非法动作、fallback、胜法和延迟指标；单侧胜率和离线 ranking 只能留在 challenger。

契约与阈值见 `skills/meta/distillation-contract.v1.json`；审计命令不会改写规则或 champion，只报告阻塞项。

## 2. 每轮固定流水线

### R0：冻结实验输入

- [ ] 记录本轮 `rules_version`、engine fingerprint、策略版本、权重 hash、阵容、模式、座次、BP 顺位和 seed 区间。
- [ ] 从 `skills/meta/open-questions.md` 选择一个可证伪假设，写入实验 manifest。
- [ ] 明确本轮成功指标、最小样本量、预算、失败种子和回退策略。

### R1：生成受控对局矩阵

- [ ] 至少覆盖 2v2、3v3；规则扩展或座次问题涉及 4v4 时单独绑定 `supplement-8p`。
- [ ] 每个假设至少包含：镜像阵容、已知对位、随机阵容、替换一个角色、改变队内座次、红蓝换边。
- [ ] 需要策略比较时使用相同 seed、相同阵容和相反 overlay 侧；不能用未配对胜率下结论。
- [ ] 复杂技能必须额外提供最小场景夹具，不能只依赖自然对局偶然触发。

### R2：运行并验收轨迹

- [ ] `npm run baseline` 或 `npm run selfplay` 运行对局；失败种子使用 `XB_BASELINE_RETRIES` 隔离重试。
- [ ] `npm run manifest:build` 检查轨迹完整性、丢记录、engine fingerprint 和配置 hash。
- [ ] `npm run decision:coverage` 检查 decision method；partial/unmodeled 必须进入 backlog。
- [ ] 规则相关局执行 `trajectory:replay`，确认终局资源、行动顺序和事件父子关系。

### R3：规则差异与数据质量

- [ ] 将源码行为与官方规范逐条比对；差异写入 curated rule object，不直接改规则真源。
- [ ] 终局结果缺失、候选为空、非法响应、超时、轨迹不完整的行全部隔离。
- [ ] 只有公开视角特征进入数据集；隐藏手牌、暗置牌、私有 storage 不得泄漏。
- [ ] `npm run dataset:ranking` 后执行 `npm run dataset:split`；切分必须按整局 `match_id` 分组。

### R4：蒸馏规则与打法

- [ ] 规则结论写入 `knowledge/curated/rules/`，必须带来源、版本、差异状态、动态测试 id。
- [ ] 角色/组合结论先写 `knowledge/evidence/` 和 `skills/meta/open-questions.md`，状态为 `hypothesis`。
- [ ] 只有跨 seed、跨座次、跨对位且通过消融的结论，才写入 `skills/rules/`、`skills/tactics/` 或 `skills/meta/tier.md`。
- [ ] 每条已验证 skill 必须包含：适用模式、阵容/座次、前置条件、行动顺序、反制点、镜像/反制/消融结果、样本量、胜率/区间、source match ids、规则版本和动态 fixture 回链；缺一项保持 `hypothesis` 或 `partial`。

### R5：AI 评测与晋级

- [ ] 先做离线 sanity check，再做配对在线对局；离线指标不能单独晋级模型。
- [ ] 评测必须同时报告总胜率、胜法、回合数、士气/杯差、非法动作、fallback、P50/P95 延迟和分层指标。
- [ ] 新策略至少覆盖未参与训练的 seed、阵容族、角色族和座次排列。
- [ ] 只有达到预注册门禁（建议至少 300 个配对局、跨至少 3 个阵容族、净胜率 Wilson 下界 > 0、非法动作不增加）才能更新 champion。

### R6：收敛与回滚

- [ ] 保存每轮 experiment manifest、数据 manifest、模型/权重 hash、评测报告和下一轮假设。
- [ ] 失败策略保留报告但不覆盖 champion；历史 champion 可一键回退。
- [ ] 同一假设连续两轮无显著提升则停止；连续三次回归则回退并建立失败案例。
- [ ] 规则真源不由自动流程改写；任何规则变更必须人工审校后重新跑规则回归。

## 3. 规则专题队列（Track C）

### C1 核心规则动态裁定

- [ ] 为攻击、应战、暗灭、圣光、圣盾、魔弹多轮分别建立最小场景。
- [x] 已先建立跨公共规则的最小夹具注册表与 runner；攻击/治疗/爆牌/购买/合成/提炼/无法行动/座次/时序已有规范基线，攻击应战等角色与卡牌专属动态夹具继续排队。
- [ ] 为伤害六时点分别建立插入响应夹具，记录文字顺序、座次顺序和父子事件。
- [ ] 验证购买/合成“不因摸 3 爆牌”、满战绩区、提炼上限、合成致胜和同时胜利。
- [ ] 建立转换 FAQ 矩阵：元素、命格、牌种、应战、封印、增伤分别验证，禁止只读单一字段。
- [ ] 将 `no-action-cases.json` 的每个角色族扩展为至少一个可宣言和一个不可宣言动态案例。

### C2 角色与技能

- [ ] 119 个源码角色、640 个技能对象完成版本/形态/触发/费用/目标/效果映射。
- [ ] 缺少说明、动态注册、随机 AI、content 与 `*_info` 不一致的对象进入人工审校队列。
- [ ] 生成 producer/consumer 图：宝石、水晶、能量、治疗、手牌、指示物、额外行动。
- [ ] 为每个复杂技能增加 `action_possibility_delta`、`mandatory`、`once_scope`、`seat_relation`。

### C3 组合与座次

- [ ] 为资源供给→消费、铺垫→收割、控制→爆发、保护→核心、续动链生成候选协同边。
- [ ] 为资源争抢、手牌条件冲突、节奏冲突、重复防御生成冲突边。
- [ ] 2v2、3v3、4v4 分开评测组合；3v3 至少覆盖六种队内顺序，4v4 使用约束搜索。
- [ ] 记录 BP pick order 与最终 seat order，不能把“先选到强角”误判为座次收益。
- [ ] 统计 `synergy_lift`、角色级兑现率、先手收益和相邻/传递方向收益，并报告区间。

## 4. AI 算法队列（Track B）

- [ ] 完成 `chooseCardTarget` 多卡/多目标和 `chooseToMove` 大于 8 张/复杂排列的显式能力边界或增量协议。
- [ ] 将角色档案、队友/敌方组合覆盖、座次和当前胜利目标加入统一 Policy request。
- [ ] 补齐候选动作的即时收益、胜利线推进、资源机会成本、反制概率和行动链延续特征。
- [ ] 将 `epsilon_greedy` 用于正式探索采集，并校准行为概率；禁止把 deterministic policy 当随机行为。
- [ ] 训练第一版 GBDT/MLP ranking model，按整局分组切分，输出模型 hash 与可解释特征贡献。
- [x] 已产出 Learned-v1 轻量 pairwise ranking 候选（`npm run train:ranking`）：仅公开候选特征、按整局切分、输出模型 hash 与 train/valid/test sanity；GBDT/MLP、特征贡献校准和在线晋级仍待完成。
- [ ] 进行 champion/历史 champion/随机/反制策略混合评测，防止循环克制和策略坍缩。
- [ ] action trace 完成后再评估 determinization/短视 rollout；未具备快速状态复制前不伪造 MCTS。

## 5. 当前下一轮推荐顺序

1. 先运行 `npm run skills:audit` 固定证据分层；为 11 条规范条目建立一对一 `rule_id → fixture_id` 回链，不能把当前 12 个通用动态夹具批量充当规则确认。
2. 为攻击/应战/治疗/爆牌/魔弹/购买/合成/提炼补齐可控的正例、负例和边界夹具，特别是目标合法性、转换视图、同名响应、同时胜利与“无法行动”责任。
3. 扩展跨阵容/换边/座次的配对矩阵；每个角色/组合假设至少覆盖 3 个阵容族、2 个模式、2 种座次，并保留镜像、反制和消融结果。
4. 只有满足契约的角色/套路才从 `knowledge/evidence` 晋级到 skills；其余继续留在 `open-questions`，不因自然对局偶然触发而升级。
5. 累积足量、独立且无泄漏的标签后再训练 Learned-v1/后续模型，先做 challenger gate，通过后才允许 champion 更新。

## 6. 收敛定义

当且仅当以下条件全部满足，AI/规则方向才算收敛：

- 规则：官方可机器化规则均有版本、来源、实现差异、与具体 fixture 的双向回链、负例/边界测试和已知例外；未裁定项全部隔离。动态事件存在性或父子顺序通过不能替代规范确认。
- 轨迹：runner 可复现，坏局可识别，决策覆盖无 unmodeled，非法动作率为 0，严格 action trace 可回放。
- 数据：训练/验证/测试按整局和阵容族隔离，带标签样本量达到预注册门槛，隐藏信息审计通过。
- AI：至少一个挑战者跨未见 seed、阵容、座次和换边通过晋级门禁；特征贡献和关键 skill 选择可解释。
- 蒸馏：每条高置信打法 skill 都有机制、适用条件、座次/组合边界、镜像/反制/消融、样本区间和对局证据；连续两轮无显著提升时自动停止当前假设。`hypothesis`/`partial` 永不作为已确认规则注入策略。

收敛前允许持续模拟，但每轮必须产生可审计报告；“跑了很多局”本身不是收敛条件。
