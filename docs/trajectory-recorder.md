# Event-level trajectory recorder

`runtime/matches/*.jsonl` 的 `result` 行只能回答谁赢、用哪条胜利线、回合数和累计统计，不能用于可靠的 AI 学习：它没有决策前状态、合法动作集合、事件顺序、触发技能、资源变化因果或失败上下文。单局结果也无法区分角色本身强度与组合/座次协同。

竞技场现在在浏览器运行时挂载 `bridge/trajectoryRecorder.mjs`。它只包装引擎已经公开的对象和方法，不修改 `noname_xingbei`：

- `game.createEvent(name, trigger, parent)`：记录事件 id、显式/运行时父事件关系和创建顺序。
- `GameEvent.prototype.setContent/trigger/start/finish`：记录内容绑定、触发名、生命周期和关键公开字段。
- `game.changeShiQi/changeXingBei/over`、`Player` 的伤害、治疗、资源、摸牌、弃牌、出牌和响应 API：记录调用方、参数摘要和返回事件。
- `Player.chooseToUse/chooseToRespond/chooseTarget/chooseControl/chooseCard/...` 以及 `gongJiOrFaShu/gongJi/faShu/yingZhan/moDan/qiTa`：记录决策请求的发起者、父事件、方法和参数摘要；同时生成脱敏的 `option_summary`（控件、可过滤目标座位、候选手牌数量/按钮数量、`selection.min/max/ordered`），`chooseCardTarget` 额外记录选卡+目标的原子候选摘要，`chooseToMove` 记录命名牌区和 `keep_or_pairwise_swap` 安排模式，并标记 `complete` 或 `candidate_only`；对应事件完成时记录控制项、目标和数量等选择结果。
- 决策桥请求还会在公开视角内附带粗粒度 `role_tags`/`role_coverage`（伤害、治疗、资源、控制、防御、终结、铺垫、座次等）和座次/先手特征；它们是供 heuristic/LLM 使用的组合假设，不参与引擎合法性裁定，也不暴露隐藏手牌身份。
- `window.__xbHooks.onEvent(fn)` / `onApi(fn)`：供决策桥、调试器或未来观战视图订阅；`snapshot()` 读取当前轨迹。

每局写入 `runtime/trajectories/<match_id>.jsonl`：首行是 `trajectory_meta`，中间是 `event_create`、`event_set_content`、`event_trigger`、`event_start`、`event_finish`、`decision_request`、`api_call`，末行是 `trajectory_end`。首尾元数据包含 `rules_version`、`engine_fingerprint`、`config_hash` 和 `policy_id`；每个事件行也带 `match_id`、`rules_version`、`schema_version`、严格递增 `seq` 和 `hook`，避免跨局拼接；关键完成事件、决策请求和周期采样包含公开状态快照。对应的版本化契约在 `knowledge/schema/trajectory.schema.json`，结果行同时携带轨迹文件路径、记录数和丢弃数。

## 可见性和完整性边界

记录器默认使用公开摘要：座位、角色、阵营、手牌数量、士气、星杯、治疗、能量和事件数值可以记录；摸牌/获得/弃牌/洗牌等事件的卡牌身份会被置空，只保留数量。它是训练观测层，不是规则裁判；`engine_event` 的最终语义仍需由引擎事件和规范资料共同 adjudicate。

当前 `decision_request` 已覆盖引擎公开的选择入口，并能提供一部分可证明完整的控件/过滤候选；复合行动的原子组合已进入记录层。决策桥另以 `decision.v1` 写入候选特征、基线分数、来源、耗时和可选外部响应，避免把桥接审计字段混入引擎事件。两者仍不能替代规则裁判或完整信息集；模型内部 logits、真实 UI 增量状态和完整信息集仍属于后续工作。

公开状态中的 `seating`（`seating.v1`）单独保存物理座位顺序、每座阵营、首行动者、从首行动者开始的顺位、前后座位关系、选将模式/队伍序列配置、阶段交换开关，以及引擎公开的 `teamSequenceList()`；BP/轮选事件可见时还保存红蓝方的公开选将顺序。没有显式座位或团队序列时写入 `null`/空数组，绝不以数组下标猜测座次。该字段用于座次特征、团队定位和顺位消融实验，不改变引擎结算。

如果达到 `max_records`，不会静默截断：`dropped_count` 会递增，评测数据管线必须把该局标成不完整并隔离。若 `window.__xbTrajectory` 缺失，selfplay 仍可记录结果，但必须把该局视为没有轨迹的 baseline，不能混入需要完整轨迹的训练集。

## 最小验收

```powershell
npm run doctor
npm test
XB_MATCHES=1 XB_MODE=two XB_SEED=1004 npm run selfplay
node bridge/validate-trajectory.mjs runtime/trajectories/m_001004.jsonl
Get-Content runtime/trajectories/m_001004.jsonl -TotalCount 3
```

验收关注：轨迹文件存在；`trajectory_meta.record_count` 与 `trajectory_end.record_count` 一致；`seq` 单调递增；结果行的 `trajectory_dropped` 为 0。默认注入的种子只约束 `Math.random` 的伪随机流，便于批次标识和对照实验；浏览器事件调度、动画计时和异步竞速仍可能令同一种子产生不同事件序列，因此它不是严格回放保证。若要做逐步策略学习或回归测试，还需要记录并重放 action trace、决策响应和时序控制。历史的 `m_001002` 只有 result 行，因此目前不足以支持事件因果学习，应在补跑后才进入 trajectory 数据集。

## 重放与批次清单

`trajectory:replay` 会先执行严格完整性校验，再从公开状态采样重建资源曲线、决策顺序和事件名计数；它是观测重放摘要，不声称重新裁判规则：

```powershell
node bridge/replay-trajectory.mjs runtime/trajectories/contract_001023.jsonl runtime/replays/contract_001023.json
```

`manifest:build` 为每个轨迹和结果文件计算 SHA-256。缺少新字段、记录丢失、首尾不一致或 JSON 损坏的文件会标记为 `quarantine`，保留在原地供调查但不会被训练器消费；该过程不删除或覆盖原始对局：

```powershell
npm run manifest:build
```

截至当前基线，`manifest.v1.json` 已验证收录 2v2、3v3、4v4 的有效样本；例如 `option_001025`（2v2）、`contract_001023`（3v3）、`four_001031`（4v4）均为 `dropped_count=0`。旧版轨迹因缺少 `rules_version`/逐条 `match_id` 会明确进入隔离区。
