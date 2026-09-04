# 规范资料索引

竞技场不复制或改写官方资料；以下路径是本地工作区中已核验的原始材料。生成知识对象只保存来源 ID、相对路径/二维码入口和 SHA-256，避免把引擎实现误当规范规则。

| source_id | 本地材料 | SHA-256 | 用途 |
|---|---|---|---|
| `xingbei-10th-anniversary-manual` | `../星杯十周年说明书.pdf` | `5F525E5F691915EAF756383D8E02EE768CB64D6822FE3DF34C6B43FAA5517779` | 十周年核心规则 |
| `official-no-action-v25.4.5` | `../tmp/pdfs/official-qr/十周年二扩终末-无法行动-v25.4.5.docx` | `35C67A3F6B5280160F7D3F734CE11237D961E5B64BBCE07577177F8093233382` | 无法行动与行动可能性裁定 |
| `official-timeline-v25` | `../tmp/pdfs/official-qr/十周年二扩-结算时间轴终末.xlsx` | `2C79DA9AAD6AF390CDE4A5BA871D0CCC5819BF2D96B6822B532285D3A7540866` | 阶段/伤害时间轴 |
| `official-skill-table-v25` | `../tmp/pdfs/official-qr/星杯传说十周年至补完包技能表.xlsx` | `5FAA20C724D12DF8B600ED15A345F1F8897607C184CB5FD58FD710ED659E7B72` | 角色与技能全集 |
| `official-change-log` | `../tmp/pdfs/official-qr/星杯历届改动.xlsx` | `7432E011286C6EF660C3C849A3AAD5F9EB87A2C9BA074942215D04FFEEC08EA7` | 版本变更与勘误 |
| `official-universe-index` | `../tmp/pdfs/official-qr/星杯宇宙-v25.9.4.xlsx` | `63EB920E58501C4C927F58D6BD250DFC48BE59C0D64D1523BB6011DCF82D6EA5` | 扩展包/角色宇宙索引 |

官方二维码资料入口：<https://drive.google.com/drive/folders/1tFEuqt2cjeSkfuYKv7MD9_H2DLI-S8dV?usp=sharing>。

如果路径不存在，规则管线必须把对应对象标记为 `source_missing`，不能回退为“引擎即规范”。
