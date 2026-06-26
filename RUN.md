# RUN — 在 Copilot CLI 上开始训练

> 本文件是"动手手册"：先把自对弈管线跑通拿到 baseline 数据，再用 LLM 决策桥与权重调参迭代。
> 全程只读引擎 clone（`../noname_xingbei_clone`），不修改它。项目说明见 [AGENTS.md](AGENTS.md)。

## 0. 前置

- Node 18+（含内置 fetch）。
- 首次安装依赖与浏览器内核：
  ```bash
  cd xingbei-arena
  npm run setup     # = npm i && npx playwright install chromium
  ```

## 1. 探针（DISCOVER，关键一次性步骤）

noname 是浏览器应用，**无头启动一局星杯对局的具体序列依机器而异**（首屏菜单/配置/auto 开关）。先探测真实情况：

```bash
npm run probe       # 生成 runtime/probe.json + 控制台输出
```

然后让 **Copilot CLI 看着 probe 结果补全启动逻辑**：

```bash
copilot -p "$(cat AGENTS.md)

任务: 阅读 runtime/probe.json 与 bridge/selfplay.mjs 中标 [DISCOVER] 的 startMatch()。
基于 probe 暴露的真实 API(window.game/lib/_status 等), 实现'进入 xingBei 模式→设人数/数值→开启 auto 全AI→开始对局'的最小可行启动。
只改 xingbei-arena/ 下脚本, 不碰 ../noname_xingbei_clone。完成后跑 npm run selfplay 验证能产出 runtime/matches/*.jsonl。"
```

> 若首屏卡在菜单：probe 的 `visibleText` 会显示按钮文案，让 CLI 改用 `page.click(...)` 走 UI 进入，或用 `lib.config`+`game.saveConfig` 预置后 reload。

## 2. 基线自对弈（拿到第一批数据 = 开始训练）

```bash
# 跑 20 局 2v2，引擎内置AI自对战，结果落 runtime/matches/
XB_MATCHES=20 XB_MODE=two npm run selfplay

# 指定阵容(可选)
XB_TEAM_A="fengZhiJianSheng,shengNv" XB_TEAM_B="kuangZhanShi,fengYinShi" XB_MATCHES=50 npm run selfplay
```

环境变量：`XB_MATCHES` 局数 / `XB_MODE` two|three|four / `XB_SEED` 起始种子 / `XB_TEAM_A`,`XB_TEAM_B` 阵容 / `XB_HEADFUL=1` 可视化调试 / `XB_OVERLAY=1` 注入优化AI。

## 3. 蒸馏（让 LLM 把 baseline 数据写进 skill）

```bash
copilot -p "$(cat AGENTS.md)

你现在是 Distiller。读取 runtime/matches/ 本批 jsonl, 按第5节更新 skills/{rules,operations,tactics,meta}:
- 统计各阵容胜率、按 win_by(shiqi0/xingBei5) 分布、场均 change_shiqi/add_zhanji。
- 把已验证结论从 status:hypothesis 升级为 verified(带 samples/win_rate/source_matches)。
- 向 skills/meta/open-questions.md 追加下一轮该验证的假设。"
```

## 4. （进阶）LLM 在环逐手决策（方案②）

只让关键座位交给 LLM，其余走 fallback 省预算：

```bash
# 终端A: 启动决策桥(引擎+信箱)。先按 bridge/decisionBridge.mjs 的 [DISCOVER] 补全注入点。
XB_LLM_SEATS=1 npm run bridge

# 终端B: 让 Copilot CLI 扮演 Player, 持续处理信箱
copilot -p "$(cat AGENTS.md)

你是 Player 子智能体。持续处理 runtime/inbox/*.req.json:
对每个请求, 在 legal_options 中按 skills/tactics 选最优, 写 runtime/outbox/<decision_id>.res.json,
严格符合 AGENTS.md 3.2 schema 与铁律(choice 必须合法; 不臆测隐藏信息; 观察写 rule_notes)。"
```

## 5. （进阶）优化AI权重调参

先确认 overlay 能注入、selfplay 支持"一侧 overlay 一侧 baseline"，再：

```bash
XB_GEN=6 XB_POP=12 XB_EVAL=40 npm run optimize   # CEM 优化 ai-overlay/weights.json
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
| AI 优化 overlay 设计+骨架 | ✅ 已产出 | 特征/搜索 TODO 待引擎接通 |
| 服务器/探针/自对弈/桥/调参 脚本 | ✅ 骨架可运行 | `startMatch()` 与桥注入点需 probe 后补全([DISCOVER]) |
| baseline 数据 | ⬜ | 跑通 step1-2 即产出 |

> **唯一真正的工程阻塞**：step1 的 `[DISCOVER]`——把"无头启动一局星杯对局"跑通。完成后 step2 起全部自动化。这步最适合直接交给 Copilot CLI 配合 probe 输出来做。
