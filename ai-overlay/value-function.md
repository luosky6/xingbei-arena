# 状态价值函数 V(state) 设计

> V 把"当前局面对某一队的好坏"压成一个标量。浅层搜索用 `V(终局) − V(现局)` 给候选打分。
> 特征与初始权重直接来自 `skills/`（rules + tactics），后续用自对弈调参覆盖。

## 视角
`V(side)` = 站在 `side`（红/蓝）立场对全局的评估。对手价值取负。
搜索时：`scoreOfChoice = V_after(myside) − V_before(myside)`（己方视角，越大越好）。

## 特征表（feature → 含义 → 来源 skill → 初始权重 w）

| 特征 key | 含义 | 来源 | 初始 w |
|---|---|---|---|
| `shiqi_diff` | (我方士气 − 敌方士气) | rules/shiqi-and-baopai | **+10** |
| `shiqi_enemy_near0` | 敌方士气越接近0越好，`max(0, 6 − 敌士气)` | shiqi | **+6** |
| `shiqi_self_near0` | 我方濒死惩罚，`max(0, 6 − 我士气)` | shiqi | **−8** |
| `xingbei_diff` | (我方星杯 − 敌方星杯) | resource-economy | **+8** |
| `xingbei_self_progress` | 距离5杯的推进 `我方星杯` | cup-rush | **+3** |
| `zhanji_self` | 我方战绩区星石数（冲杯燃料） | resource-economy | **+1.0** |
| `actions_left` | 本回合剩余/可解锁行动数 | rules/action-economy | **+4** |
| `chain_potential` | 手牌中可触发"额外行动"的牌/技数 | chain-action-rush | **+3** |
| `pierce_potential` | 手牌中"无法应战/必中/无视盾"的能力数 | combat-and-yingzhan | **+2** |
| `hand_quality_self` | 我方可转化技能匹配度（命格/系别契合） | combat-and-yingzhan | **+1.0** |
| `zhiliao_self_team` | 我方治疗总量（抗爆牌） | heal-suppression | **+1.5** |
| `enemy_burn_exposure` | Σ敌人 `max(0, 手牌满度 − 治疗)`（越大越易被爆士气） | force-draw-then-burn | **+2** |
| `self_burn_exposure` | 同上但我方（被爆风险，取负） | force-draw-then-burn | **−2** |
| `markers_banked_self` | 我方关键指示物存量（信仰/斗气/鬼火…，归一化） | resource-economy | **+0.8** |
| `tempo` | 行动权/先手节奏（谁更接近达成胜利线） | meta | **+1.5** |

> 权重符号是先验方向；数值是占位，**必须由自对弈调参确定**（weights.json）。

## victim 估值升级（替换/包装 get.damageEffect）
原版 `damageEffect(target,num)` 只按 `chaZhi=手牌上限−手牌` 评估。升级为：

```
value = base_overflow(target, num)                 // 原逻辑：击穿手牌余量的部分
      + w_low_shiqi * max(0, 6 − enemyTeamShiQi)   // 敌队濒死时该目标更值得打
      + w_no_heal   * (target.zhiLiao === 0 ? 1 : 0)
      + w_focus     * isFocusTarget(target)        // 集火协同(见态度钩子)
```
仅对"敌方目标"生效；友方仍为保护性负值。

## 浅层搜索（命中"连续行动链"盲区）
- **范围**：只搜**自己回合内的行动链**（因为额外行动会连锁），深度 1~2、beam 宽度可调。
- **流程**：枚举当前合法行动 → 对每个用引擎模拟/估算其后 `actions_left` 与局面 → 取 `ΔV` 最大者；
  必要时再展开一层（链式）。
- **成本控制**：唯一合法/明显占优直接返回；只在分支多且 ΔV 接近时才深搜。
- **落地难点**：引擎事件不易"无副作用试算"。两种实现：
  1. 轻量：用 V 的特征做**解析式估算**（不真正执行事件），快但近似。
  2. 重量：clone 关键 game state 做**沙盒推演**，准但工程量大（阶段后期再做）。
  → 先做 1，验证收益后再考虑 2。

## 调参（weights.json 的优化）
- 方法：CEM / 坐标上升 / 网格；目标 = 对原版内置AI胜率（多阵容多变体平均）。
- 防过拟合：训练对位与验证对位分离；跨数值变体检查稳定性。
