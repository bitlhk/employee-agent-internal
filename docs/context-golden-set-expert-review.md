# Context Golden Set 专家审核指引

本轮只审核财富经理 Context Golden Set V1 的 16 条案例，不扩充案例数量，也不调整系统实现来迎合 proposed 预期。

## 每条案例确认项

知识专家逐条确认：

1. `expectedLogicalAssets`：完成任务实际需要哪些逻辑 Context；
2. `expectedDocuments`：哪些正式文档允许作为依据；
3. `expectedVersions`：必须采用哪个有效版本；
4. `expectedPositions`：应命中的章节、页码或原文位置；
5. `forbiddenDocuments`、`expectedStatus` 和 `expectedReasonCodes`：哪些来源不得进入，以及缺失时应 BLOCKED 还是 DEGRADED。

专家不同意 proposed 内容时，直接修改 Ground Truth，并在 `reviewComment` 说明业务依据。不要先修改 Retriever、Resolver 或测试实现来让当前 proposed case 通过。

## 审核状态

开始审核：

```json
{
  "status": "expert_reviewing",
  "reviewerId": "knowledge-expert-01",
  "reviewerRole": "财富管理制度专家"
}
```

存在争议：

```json
{
  "status": "needs_resolution",
  "reviewerId": "knowledge-expert-01",
  "reviewerRole": "财富管理制度专家",
  "reviewComment": "V2.2 与销售检查清单对例外流程的适用范围需要合规部门共同确认。"
}
```

确认完成：

```json
{
  "status": "expert_confirmed",
  "reviewerId": "knowledge-expert-01",
  "reviewerRole": "财富管理制度专家",
  "reviewedAt": "2026-08-21T12:00:00+08:00",
  "reviewComment": "已核对现行制度、历史版本和任务降级边界。",
  "groundTruthVersion": "1.0.0"
}
```

`reviewerId` 使用企业内部稳定标识，不在公开演示材料中展示个人敏感信息。Git 历史和契约指纹共同记录基线变更。

## 验证与冻结

审核过程中运行：

```bash
pnpm context:quality:verify
```

16 条全部确认后运行：

```bash
pnpm context:quality:freeze
```

只有冻结门禁通过，才可将状态标记为 `GRACE Context Quality Baseline V1: Expert Confirmed`。
