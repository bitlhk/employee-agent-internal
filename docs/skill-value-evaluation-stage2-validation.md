# Skill 价值评测第二阶段验证记录

验证时间：2026-09-04

## 验证方法

- 同一模型：`glm-5.2`
- A 侧：不加载目标 Skill，但保留相同的已声明工具环境
- B 侧：加载目标 Skill 的当前已发布版本
- 每个 Skill 先检查版本资产、固定业务题、模型和 Runtime 工具，再执行第一道固定业务题
- 左右结果由 Finance Skill Eval 的匿名专业 Judge 按专业匹配、业务完整、表达清晰和可执行性评审

## 本地基线适配与运行结果

| Skill | 版本 | 固定题 | 工具环境 | 最小 A/B | Judge 结果 |
| --- | --- | ---: | --- | --- | --- |
| `auto-insurance-advisor` | 1.2.5 | 2 | Ready，客户画像与保险产品考点 | 完成 | B 胜 |
| `bond-quote-parse` | 1.0.1 | 2 | Ready，债券报价解析 | 完成 | B 胜 |
| `goldencoach-stage-evaluation` | 1.0.1 | 1 | 无外部工具依赖 | 完成 | B 胜 |
| `investment-research-assistant` | 1.1.0 | 4 | Ready，Wind 股票与公告数据 | 完成 | B 胜 |
| `post-loan-risk-control-assistant` | 1.2.1 | 2 | Ready，贷后数据与平台工具 | 完成 | B 胜 |
| `smart-audit-assistant` | 1.1.0 | 4 | Ready，材料、审核规则与演示动作 | 完成 | B 胜 |

## 上海环境发布验收

发布后，动态适配矩阵按上海实际版本和环境重新检查，六项均为“完全支持”：

| Skill | 上海版本 | 固定题 | 环境状态 |
| --- | --- | ---: | --- |
| `auto-insurance-advisor` | 1.2.5 | 2 | Ready |
| `bond-quote-parse` | 1.0.1 | 2 | Ready |
| `goldencoach-stage-evaluation` | 2.2.0 | 1 | Not required |
| `investment-research-assistant` | 1.1.0 | 4 | Ready |
| `post-loan-risk-control-assistant` | 1.2.1 | 2 | Ready |
| `smart-audit-assistant` | 1.1.0 | 4 | Ready |

其中两项针对环境差异执行了线上真实 A/B：

| Skill | 任务 ID | 结果 | 结论 |
| --- | --- | --- | --- |
| `auto-insurance-advisor@1.2.5` | `skill-eval-e22e68c64c6f-mtmjohbx` | B 胜 | 企业 Runtime 动态装配客户上下文后可完成真实对比 |
| `goldencoach-stage-evaluation@2.2.0` | `skill-eval-23c6e487c82e-mtmk4iyz` | A 胜 | Skill 输出完整，但对阶段点评过度套用七模块、总分和推测性画像，当前版本需要收敛任务模式和表达 |

“完全支持”只表示该 Skill 具备可重复评测条件，不表示 Skill 一定优于无 Skill。销售陪练的有效负向结果正是本阶段要发现的质量改进证据。

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
- 销售陪练首次线上运行中，短结束语覆盖了此前流式输出的完整点评；解析规则已改为保留更完整的业务正文并增加回归测试。修复后 B 侧正文为 5,782 字，Judge 仍判 A 胜，因此最终结论属于业务质量差异，而不是技术提取错误。
- “完全支持”表示当前版本、题库、模型和已声明工具环境可形成真实 A/B，不保证每次模型调用都不会出现瞬时波动。

## 复现命令

```bash
pnpm skills:value:priority:verify
pnpm skills:value:priority:smoke -- --skill=bond-quote-parse
```
