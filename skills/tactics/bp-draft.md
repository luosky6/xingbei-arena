---
id: tactics/bp-draft
status: hypothesis
confidence: 0.6
evidence: { source: "static-code-analysis", files: ["mode/xingBei.js#chooseCharacterOLBP", "getRoomInfo"] }
source_matches: []
updated: 2026-06-29
---

# 套路：BP 选角（Ban/Pick 选秀策略）

## 机制（已从代码确认）
- `choose_mode` 可选：多选1 / CM01 / CM02 / BP01 / BP02 / 酒馆(jiuGuan)。
- BP 流程（chooseCharacterOLBP）：共享"酒馆"候选池（`BPchoose_number`，约4），
  - **Ban 阶段**：`banList=[red_list[0], blue_list[0]]` 双方一号位各 Ban 1 名；被 Ban 角色从池移除并随机补 1 名新角色。
  - **Pick 顺序**：BP01 = 红蓝红蓝红蓝（R,B,R,B,R,B）；BP02 = 镜像（R,B,B,R,B,R），3v3 为 6 顺位。
- 可用 `banned` 预禁用角色。两队从同一公共池轮流挑。

## 因为是公共池，BP 的核心博弈
1. **Ban 对方核心**：依 meta/tier 优先 Ban 敌方最强系（连续行动链/穿防/冲杯加速，见 chain-action-rush、cup-rush）。
2. **抢先 Pick > 留给对手**：池是共享的，先手 R 抢走的强角色对手就拿不到；估值=自身价值+"否则被对手拿走"的对冲。
3. **顺位差异**：BP01(R,B,R,B,R,B) 红方持续先手；BP02 镜像中段连选，注意 2-3 手的组合。
4. **凑套路而非单强**：选能形成 chain-action / heal-suppression / cup-rush 协同的组合，而非各自最高分。

## 决策端实现（每手 LLM 在环时）
- Ban：在 legal_options(候选池) 中选"对方威胁最大且我方拿不到也无所谓"的；
- Pick：选 max(自身价值 + 对手会拿走的损失) 且与已选队友互补的角色；
- 参考 skills/meta/tier（先验梯队）+ tactics/*；缺数据时按机制强度先验。

## 验证计划
- 跑 BP01/BP02 各 ≥100 局，记录：被 Ban 最多的角色、首抢角色胜率、先手(红)优势幅度。
- 把"高 Ban 率 + 高首抢胜率"角色回写 meta/tier 顶层，BP 顺位价值写本表。

## 多轮蒸馏产物：按角色/对位的 BP 针对表（MainAgent 持续填充）
> 由多轮 LLM 对局结果累积；status 起步 hypothesis，样本够再升 verified。每行带 n 与胜率。

### Ban 优先级（敌方出现即优先 Ban，越上越优先）
| 角色 | 理由 | 证据(n/被ban后对手胜率↓) | conf |
|---|---|---|---|
| (待填) | (连击/穿防/冲杯) | n=? | - |

### 首抢/必抢（先手红方该抢，否则被对手拿走）
| 角色 | 价值 | 证据 | conf |
|---|---|---|---|
| (待填) | | n=? | - |

### 对位针对（看到敌方A → 我方优先选B 克制）
| 敌方 | 我方应对 | 机制 | 证据 | conf |
|---|---|---|---|---|
| (待填) | | 破治疗/打断链/抢节奏 | n=? | - |

### 顺位价值（BP01/BP02 各顺位最优角色类型）
| 模式 | 顺位 | 偏好 | 证据 |
|---|---|---|---|
| BP01 | R1 | (待填) | n=? |
