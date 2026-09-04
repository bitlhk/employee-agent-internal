# Skill 价值评测第二阶段验证记录

验证时间：2026-09-04

## 验证方法

- 同一模型：`glm-5.2`
- A 侧：不加载目标 Skill，但保留相同的已声明工具环境
- B 侧：加载目标 Skill 的当前已发布版本
- 每个 Skill 先检查版本资产、固定业务题、模型和 Runtime 工具，再执行第一道固定业务题
- 左右结果由 Finance Skill Eval 的匿名专业 Judge 按专业匹配、业务完整、表达清晰和可执行性评审

## 适配与运行结果

| Skill | 版本 | 固定题 | 工具环境 | 最小 A/B | Judge 结果 |
| --- | --- | ---: | --- | --- | --- |
| `auto-insurance-advisor` | 1.2.5 | 2 | Ready，客户画像与保险产品考点 | 完成 | B 胜 |
| `bond-quote-parse` | 1.0.1 | 2 | Ready，债券报价解析 | 完成 | B 胜 |
| `goldencoach-stage-evaluation` | 1.0.1 | 1 | 无外部工具依赖 | 完成 | B 胜 |
| `investment-research-assistant` | 1.1.0 | 4 | Ready，Wind 股票与公告数据 | 完成 | B 胜 |
| `post-loan-risk-control-assistant` | 1.2.1 | 2 | Ready，贷后数据与平台工具 | 完成 | B 胜 |
| `smart-audit-assistant` | 1.1.0 | 4 | Ready，材料、审核规则与演示动作 | 完成 | B 胜 |

## 运行证据

| Skill | 成功任务 ID |
| --- | --- |
| `auto-insurance-advisor` | `skill-eval-fa92bcc4b345-mtmhzefu` |
| `bond-quote-parse` | `skill-eval-4ed40dcccaa2-mtmhscov` |
| `goldencoach-stage-evaluation` | `skill-eval-c9f55e9f73f4-mtmibopp` |
| `investment-research-assistant` | `skill-eval-f58c87d645d5-mtmhvu45` |
| `post-loan-risk-control-assistant` | `skill-eval-b9e172a59d79-mtmi5a01` |
| `smart-audit-assistant` | `skill-eval-1655f4e926c3-mtmi9jn8` |

## 稳定性观察

- 销售陪练首次运行的 B 侧遇到一次五分钟模型超时，第二次同条件运行成功。该现象归类为模型或 Runtime 波动，不作为 Skill 不支持的依据。
- 首次 Smoke 暴露旧评测实例缺少过期时间时写入 Unix epoch 的 MySQL 兼容问题；回收逻辑已改为记录实际回收时间。
- “完全支持”表示当前版本、题库、模型和已声明工具环境可形成真实 A/B，不保证每次模型调用都不会出现瞬时波动。

## 复现命令

```bash
pnpm skills:value:priority:verify
pnpm skills:value:priority:smoke -- --skill=bond-quote-parse
```
