# 引擎 AI 优化总览（ai-overlay）

> 目标：把 `skills/` 里蒸馏出的规则与套路，固化成一个**更强的、可调参的启发式 AI**，
> 以**叠加层(overlay)**形式加载，**绝不修改 `noname_xingbei/` 任何源文件**。

## 为什么用 overlay 而不是改源码
- 保持引擎 clone 纯净、可随时重拉、可对照"原版AI vs 优化AI"。
- overlay 在运行时通过引擎暴露的扩展点**猴补丁(monkey-patch)**，可热插拔、可回滚。

## 内置 AI 的三大盲区（来自分析，详见上层对话与 skills/）
1. 贪心 1-ply，无前瞻 → 不会打**连续行动链**。
2. 态度 ±6 死值 → 不会**集火/保护/威胁排序**。
3. `damageEffect` 只看单目标手牌余量 → 不看**两队士气总盘**与**冲杯节奏**。

## overlay 的四个改造点（按 ROI 排序）

| # | 改造 | 命中盲区 | 实现方式（不改源码） |
|---|---|---|---|
| 1 | **状态价值函数 V(side)** | 整体评估缺失 | 新增 `get.stateValue`，见 value-function.md |
| 2 | **回合内浅层搜索** | 连续行动链(盲区1) | 包装 `ai.basic.chooseTarget/chooseCard`：对候选做 1~2 步前瞻，用 V 评估终局 |
| 3 | **威胁/集火态度** | 盲区2 | 通过 `player.ai.modAttitudeFrom/To` 钩子加权，不动 `rawAttitude` |
| 4 | **victim 估值升级** | 盲区3 | 包装 `get.damageEffect`：叠加"目标所在队士气越低越该打""治疗为0加成" |

## 加载顺序（运行时）
```
引擎初始化完成
  → 载入 ai-overlay/install.js
      → patch get.damageEffect / 新增 get.stateValue
      → 用 setAI(new TunedAI()) 或包装 ai.basic.* 注入浅层搜索
      → 注册每个 player 的 modAttitude 钩子
配置权重来自 ai-overlay/weights.json（可被自对弈调参覆盖）
```

竞技场自对弈在 `XB_OVERLAY=1` 时会通过静态服务器的 `/__arena/` 只读前缀自动加载此模块，并在角色创建完成后安装。当前版本已生效的是价值函数、伤害估值、集火态度和可解释浅层候选重排；安装器幂等且会按行动阵营惰性刷新集火目标。浅层重排只在原版候选分差不明显时增加公开状态 bonus，优势明显时回退原版；外部 LLM 决策桥需通过 `bridge/decisionBridge.mjs` 单独启用。

当前价值函数还接入角色组合多维职责（资源/输出/控制/保护/终结）以及座次相邻协同、首行动控制两个 `seating-hypothesis` 特征。它们只读取公开 `seat/side/firstAct`，不会把视觉位置或内部 `seatNum` 混入规则；正式权重仍须经过换边、阵容和座次消融门禁。

## 与"LLM 先蒸馏"的衔接（本阶段执行顺序）
1. **LLM 蒸馏**（已起步）：`skills/` 提供"什么强、为什么强、怎么打"。
2. **编码进 V 与搜索**：把 skills 的结论变成 V 的特征项与权重先验（见 value-function.md 的特征表）。
3. **自对弈调参**：固定配对种子分别让 overlay 作为红方/蓝方，用 CEM/网格优化 `weights.json`，目标=换边后的对原版内置 AI 胜率；正式结论必须看置信区间和多阵容大样本。
4. **回灌 skills**：调参中发现的强组合/反例写回 `tactics/` 与 `meta/`，迭代。

权重晋级必须经过 `npm run evaluate:gate`：默认至少 50 局、胜率 0.55 且 Wilson 95% 下界不低于 0.50；样本不足会返回 `insufficient_evidence`，不会自动改写 champion。

## 评估口径
- 主指标：**优化AI vs 原版内置AI 的胜率**（≥N 局、固定种子集）。
- 辅助：单回合平均行动数、场均 change_shiqi、冲杯达成率、决策耗时。
- 防过拟合：在多组数值变体与多阵容上验证稳定性。

## 文件
- `value-function.md` — V(state) 的特征与权重设计。
- `valueFn.js` — V 与 victim 估值的可运行启发式实现。
- `install.js` — overlay 安装/猴补丁（幂等、侧别隔离，包含 target/card 的浅层候选重排）。
- `weights.json` — 可调参权重（自对弈优化对象）。
