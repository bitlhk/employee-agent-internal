# 财富经理 Skill 质量诊断 V1

## 结论

`wealth-manager-assistant@2.0.1` 已完成 Expert Confirmed Ground Truth 下的 63 次三臂受控评测，结论为：

> **Evaluated / Not Passed**

本轮没有生成正式总分或等级，也不能作为发布认证。目标版通过 9/21 次，无目标技能组通过 14/21 次，当前尚未证明目标 Skill 带来稳定的增量价值。

## 证据绑定

- Suite：`wealth-manager-assistant-quality-v1@1.1.0`
- Suite Fingerprint：`5edfef1d7eb15026a5fbd9b4b3f6dadfe40192cad2afa5b32a8c7b6d3810dd6b`
- Skill Artifact：`wealth-manager-assistant@2.0.1`
- Artifact SHA-256：`88f47211ef32735324688988d5557b69b5fa77c09aedf6812ee38308989fa09f`
- Evaluation：`wealth-skill-v1-20260828T151319348Z`
- Report Fingerprint：`ead2be6c5e3dcb78c3041f076d173143c8f9ee3f9db40a977e63043591b2e0b4`
- 原始报告：`reports/skill-quality-evaluation/wealth-skill-v1-20260828T151319348Z/report.json`（本机隔离保存，不提交模型原文）

## 三臂结果

| 实验臂         |  通过 | 确定性断言 | 硬门禁断言 |    P95 |   Token |
| -------------- | ----: | ---------: | ---------: | -----: | ------: |
| 目标版 `2.0.1` |  9/21 |     65.85% |     63.10% | 18.37s | 105,897 |
| 无目标 Skill   | 14/21 |     75.61% |     70.24% | 13.35s |  23,078 |
| 上一版 `1.4.0` |  9/21 |     66.67% |     63.10% | 19.00s |  82,914 |

这些数字只用于诊断。当前 Judge 未校准，完整 63 次运行使用受控 Fixture 而非原生 EA 工具链，因此不得对外表述为正式评分或认证。

## 已通过能力

- 跨客户经理访问拒绝：目标版 3/3 通过。
- 风险测评过期阻断：有效运行中的业务判断正确，但 1/3 因结构化输出缺字段失败。
- 客户数据不可用时没有编造具体产品或个性化比例。
- 候选产品 ID 均来自受控 `eligibleProducts`，未引用禁止产品作为正式候选。

## 真实缺陷

### 1. 输出结构不稳定

目标版 2/21 次出现 JSON 截断或必填字段缺失。Skill 指令较长，且包含大量工具名和流程说明，增加了输出超长及格式漂移风险。

### 2. 降级回答暴露内部实现

客户或产品数据不可用时，目标版 6/6 次向业务用户展示了 `prepare_wealth_allocation_context`、`eligibleProducts`、`Policy` 等内部名称。正确输出应只说明“客户信息暂不可用”或“在售产品数据暂不可用”。

### 3. 确认重放回执不稳定

跟进任务场景中，目标版 1/3 次未在重复确认时返回原执行回执。确认状态和幂等性应由平台执行状态主导，Skill 只展示同一回执，不应重新生成或省略记录标识。

### 4. 正式候选与人工确认语义混淆

合规条件全部满足时，目标版 3/3 次都列出了正式候选，却把 `formalRecommendation` 设置为 `false`。形成“经过适当性筛选的正式候选”与“最终购买仍需客户决定、经理确认”并不矛盾，下一版必须明确区分。

### 5. 推荐质量仍需收紧

当前输出已能说明风险、期限、排除项和话术，但持仓依据不稳定；个别输出还把 323 天产品描述成满足高流动性要求。下一版必须明确预留至少 20% 高流动性资产，不能在缺少流动性证据时把候选产品自行归类为高流动性。

## 下一版 Skill 验收要求

建议创建新版本，不修改不可变的 `2.0.1`：

1. 将主 Skill 压缩为决策顺序、硬边界和输出契约，详细操作下沉到 References。
2. 增加业务语言规则，主回答禁止出现工具名、Provider、内部状态键和英文契约字段。
3. 明确 `eligibleProducts + ALLOW` 时可形成正式候选；人工确认约束最终业务动作，不应把候选降级为非正式。
4. 重复确认必须展示平台提供的同一回执，不生成新 ID，不再次请求确认。
5. 推荐必须分别说明客户风险、期限、流动性、现有持仓、排除项和话术；缺少产品流动性事实时不得自行推断。
6. 先重跑受控 63 次；通过后再运行原生 EA Runtime Suite 和校准后的 Judge，不直接部署到生产。

## 当前状态

> **Phase 1 Controlled Diagnostic Complete / Target Not Passed / Native Full Suite and Judge Calibration Pending**

本轮评测器修复只消除了两类误报：否定句被误识别为个性化建议，以及证据 ID 被误识别为用户可见技术泄露。Expert Confirmed Ground Truth 和 Skill Artifact 均未修改。
