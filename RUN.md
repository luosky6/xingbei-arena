# RUN — 在 Copilot CLI 上开始训练

> 本文件是"动手手册"：先把自对弈管线跑通拿到 baseline 数据，再用 LLM 决策桥与权重调参迭代。
> 全程只读引擎目录（默认 `../noname_xingbei`，可用 `XB_ENGINE_ROOT` 覆盖），不修改它。项目说明见 [AGENTS.md](AGENTS.md)。

## 0. 前置

- Node 18+（含内置 fetch）。
- 首次安装依赖与浏览器内核：
  ```bash
  cd xingbei-arena
  npm run setup     # = npm i && npx playwright install chromium
  ```

## 1. 探针（引擎升级时的兼容性检查）

noname 是浏览器应用。当前 `startMatch()` 已经跑通无头六人局；引擎升级或更换运行环境时，先探测真实启动状态：

```bash
npm run probe       # 生成 runtime/probe.json + 控制台输出
```

若探针发现首屏或配置流程发生变化，再让 **Copilot CLI 看着 probe 结果修复启动逻辑**：

```bash
copilot -p "$(cat AGENTS.md)

任务: 阅读 runtime/probe.json 与 bridge/selfplay.mjs 的 startMatch()。
若引擎升级导致启动回归，基于 probe 暴露的真实 API(window.game/lib/_status 等)修复'进入 xingBei 模式→设人数/数值→开启 auto 全AI→开始对局'流程。
只改 xingbei-arena/ 下脚本, 不碰 ../noname_xingbei。完成后跑 npm run selfplay 验证能产出 runtime/matches/*.jsonl。"
```

> 若首屏卡在菜单：probe 的 `visibleText` 会显示按钮文案，让 CLI 改用 `page.click(...)` 走 UI 进入，或用 `lib.config`+`game.saveConfig` 预置后 reload。

## 2. 基线自对弈（拿到第一批数据 = 开始训练）

```bash
# 跑 20 局 2v2，引擎内置AI自对战，结果落 runtime/matches/
XB_MATCHES=20 XB_MODE=two npm run selfplay

# 指定阵容(可选；会在选角阶段按红/蓝方实际座位套用并校验 2/3/4 人局人数、角色存在性与重复)
XB_TEAM_A="fengZhiJianSheng,shengNv" XB_TEAM_B="kuangZhanShi,fengYinShi" XB_MATCHES=50 npm run selfplay
```

环境变量：`XB_MATCHES` 局数 / `XB_MODE` two|three|four / `XB_SEED` 起始种子 / `XB_TEAM_A`,`XB_TEAM_B` 阵容 / `XB_RULES_VERSION` 规则版本覆盖（默认 4v4 自动使用 `manual-10th-supplement-8p-v0.1`，其余为 `manual-10th-core-v0.1`） / `XB_HEADFUL=1` 可视化调试 / `XB_OVERLAY=1` 注入部分优化 AI（价值函数、伤害估值、集火态度、角色组合与座次特征、浅层候选重排已接通）。默认会记录 PRNG 种子，严格逐步回放仍需 action trace。

`XB_MODE` 会在 reload 前逐项等待写入引擎模式配置；自对弈结果还会强制校验实际座位数（two=4、three=6、four=8），因此配置落盘失败或引擎回退时会生成独立 `error` 结果，不会混入胜负统计。

视觉回归时可额外启用只读现代主题：`XB_MODERN_UI=1`。它只注入 `ui-overlay/` 作用域样式，默认关闭，不改变对局行为。

每批跑完后生成数据清单并抽查公开重放摘要：

```bash
npm run manifest:build
node bridge/replay-trajectory.mjs runtime/trajectories/<match_id>.jsonl runtime/replays/<match_id>.json
npm run summarize -- <可选match_id前缀>
npm run dataset:split   # 按整局 match_id 分组切分 train/valid/test；无终局标签另存 unlabeled
npm run rules:fixtures  # 运行规范规则最小场景夹具（不等于引擎动态验证）
npm run rules:event-evidence  # 盘点真实轨迹事件名/计数/有限时序样本
npm run rules:dynamic-patterns  # 审计真实事件父子关系和局部时序（仍不等于语义验证）
npm run rules:dynamic-fixtures  # 执行 fixture_id 绑定的动态关系/事件覆盖断言
npm run skills:audit  # 审计规则回链与 skill 晋级字段；只报告，不改写规则/champion
npm run convergence:check  # 汇总所有硬门禁；未满足时返回 not_converged
npm run train:ranking  # 训练 Learned-v1 候选并输出模型/离线 sanity 报告（不自动晋级）
```

完成离线 sanity 后，可用 `XB_INLINE_POLICY=learned_v1 XB_RANKING_MODEL=runtime/models/learned-v1.json` 做独立 bridge smoke。模型文件缺失或非法时会记录 violation 并按显式 fallback 继续，不能把 fallback 结果算作 Learned-v1 胜率。

`summary.v1` 会同时给出红/蓝胜率及 Wilson 95% 区间、均值/中位回合、`shiqi0`/`xingBei5` 胜法、按模式/策略/overlay 侧拆分，以及超时、非法回写和 fallback 违规计数；如果存在决策审计，还会汇总来源、非法选择、P50/P95 延迟和候选数量。它只做描述统计；是否晋级仍由 `npm run evaluate:gate` 的预注册门禁决定。

启用 `bridge/decisionBridge.mjs` 时，`runtime/decisions/events.jsonl` 记录 `decision.v1` 审计事件：候选 ID、候选特征、基线分数、实际选择、来源（inline/external/fallback/pass）、合法性和延迟。它与 `runtime/violations/events.jsonl` 分离，便于区分“策略选择”与“桥接违规”。

manifest 中只有 `status=valid` 且 `dropped_count=0` 的轨迹允许进入训练；旧版或损坏轨迹会保留在原处并标为 `quarantine`。

历史轨迹可以保留在全局 manifest 中，同时为一轮预注册实验建立严格作用域清单，避免旧证据污染当前验收：

```bash
XB_MANIFEST_PREFIX=todo_round1_20260903_ npm run manifest:build runtime/reports/strict-manifest.todo-round1.v1.json
XB_MANIFEST_PATH=runtime/reports/strict-manifest.todo-round1.v1.json npm run convergence:check
```

`XB_MANIFEST_PREFIX` 只筛选文件名，不删除或覆盖任何轨迹；收敛报告会使用该清单，动态 fixture 则通过 `rules/dynamic-fixtures.v1.json` 的 `fixture_id` 绑定关系断言。

## 3. 蒸馏（让 LLM 把 baseline 数据写进 skill）

```bash
copilot -p "$(cat AGENTS.md)

你现在是 Distiller。读取 runtime/matches/ 本批 jsonl, 按第5节更新 skills/{rules,operations,tactics,meta}:
- 统计各阵容胜率、按 win_by(shiqi0/xingBei5) 分布、场均 change_shiqi/add_zhanji。
- 只把满足 skills/meta/distillation-contract.v1.json 的结论升级：规则需官方来源/引擎差异/fixture 回链/负例；套路需跨模式、阵容、座次的镜像/反制/消融和足量样本。其余保持 hypothesis 或 partial，不能因为脚本跑完就升级。
- 向 skills/meta/open-questions.md 追加下一轮该验证的假设。"
```

## 4. （进阶）LLM 在环逐手决策（方案②）

只让关键座位交给 LLM，其余走 fallback 省预算：

```bash
# 终端A: 启动决策桥(引擎+信箱)。除 chooseControl/Bool/Target/Card/Button 外，
# gongJiOrFaShu、gongJi、faShu、yingZhan、moDan、qiTa 也会作为“选卡+选目标”原子动作输出；chooseToMove 输出保留/成对交换候选。
XB_LLM_SEATS=0,1,2,3 XB_AUTO_START=1 XB_MODE=two npm run bridge

# 终端B: 让 Copilot CLI 扮演 Player, 持续处理信箱
copilot -p "$(cat AGENTS.md)

你是 Player 子智能体。持续处理 runtime/inbox/*.req.json:
对每个请求, 在 legal_options 中按 skills/tactics 选最优, 写 runtime/outbox/<decision_id>.res.json,
严格符合 AGENTS.md 3.2 schema 与铁律(choice 必须合法; 不臆测隐藏信息; 观察写 rule_notes)。"
```

桥接层也提供低成本的进程内烟测策略。它只用于验证“暂停→请求→合法回写→继续”链路，不能作为 AI 质量结论：

```bash
XB_LLM_SEATS=0,1,2,3 XB_AUTO_START=1 XB_MODE=two XB_INLINE_POLICY=first_legal XB_DEBUG=1 npm run bridge
# 可选: XB_INLINE_POLICY=deterministic_random（按 decision_id 做可复现哈希抽样）或 heuristic（只用公开候选/角色组合特征）
```

未设置 `XB_INLINE_POLICY` 时仍使用 inbox/outbox 外部 Player；超时、非法 choice 和策略异常都会记录到 `runtime/violations/events.jsonl` 并按显式 fallback 继续。

若要让决策桥在对局结束时把终局摘要写入 `runtime/matches/<match_id>.jsonl`，额外设置 `XB_RECORD_RESULT=1`；这样可以把同一 `match_id` 的 decision audit 与结果关联到 ranking dataset，桥接仍不改变规则裁定。

批量基线遇到浏览器导航竞态时，可保留首轮失败证据并自动按失败种子隔离重跑；例如最多重试两次：

```bash
XB_BASELINE_BATCHES=20 XB_BASELINE_MODES=two XB_BASELINE_RETRIES=2 npm run baseline
```

报告同时给出 `strict_ok`（首轮是否完整）与 `recovered_ids`（重试后恢复的种子），不会覆盖原始失败结果。

## 5. （进阶）优化AI权重调参

先确认 overlay 能注入、selfplay 支持"一侧 overlay 一侧 baseline"，再：

```bash
XB_GEN=6 XB_POP=12 XB_EVAL=40 npm run optimize   # CEM 优化 ai-overlay/weights.json

# 预注册晋级门禁：只统计完整、可归因 overlay 结果；正式评测要求红/蓝换边共用 seed
XB_GATE_RED_PREFIX=gate_r_20260903 XB_GATE_BLUE_PREFIX=gate_b_20260903 \
  XB_GATE_MIN_GAMES=50 XB_GATE_MIN_SIDE=25 XB_GATE_MIN_PAIRS=25 \
  XB_GATE_OUT=runtime/reports/gate.v1.json npm run evaluate:gate
```

## 6. 主循环（让 MainAgent 串起整轮）

```bash
copilot -p "$(cat AGENTS.md)

你是 MainAgent。执行第6节主循环一轮:
读 skills/meta/open-questions.md 取假设 → 用 npm run selfplay 排对局矩阵(够样本) →
调起 Distiller 更新 skills/ → 汇报本轮结论与下一轮计划。固定种子, 只看大样本, 不改引擎不动 git。"
```

---

## 进度与阻塞点一览

| 步骤 | 状态 | 阻塞 |
|---|---|---|
| 静态规则/套路蒸馏 → skills/ | ✅ 已产出(hypothesis) | 待对局验证 |
| AI 优化 overlay 启发式实现 | ✅ 已产出 | 浅层搜索、全量候选评分和大样本门禁待补 |
| 现代 UI 运行时主题/截图基线 | ✅ 已产出 | 选角/BP/观战专属组件和视觉阈值待补 |
| 服务器/探针/自对弈/桥/调参 脚本 | ✅ 已跑通 | 基础 choose*、chooseCardTarget 单卡/单目标原子动作与 chooseToMove 保留/成对交换已接通；增量多选和全量候选评分仍需补 |
| baseline 数据 | ✅ 已产出 | 继续扩大矩阵并进入轨迹数据集 |

> 当前主线阻塞已从“启动对局”转为：补齐逐决策 action trace、把规范规则映射为可执行 adjudicator，补足角色特例/组合与座次实验，并验证 overlay/LLM 决策桥不会破坏引擎事件顺序。
