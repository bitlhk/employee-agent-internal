# 灵感金融 · 投顾分析 Reference Role Pack V1

本目录组合 `investment-researcher` 现有 Role、Wind MCP、金融 Skills、Reference Knowledge、Policy 和 Eval，不引入第二套运行时配置。

状态为 `Reference Ready`：适合演示和受控验证，不构成投资建议，也不代表企业生产审批已经完成。

## 组成

- `knowledge`：十份研究作业规范和版本治理元数据；
- `skills/investment-research-assistant`：受控主路由，复用现有 Wind 和研究 Skills；
- `eval`：六项 Golden Task 的正常、拒绝、降级、来源和确认用例；
- 安装器以只增加、不删除方式更新岗位基线，不覆盖用户自装 Skill。

动态金融事实必须来自当前授权连接器并标注日期；Reference Knowledge 只提供工作方法、口径和边界。
