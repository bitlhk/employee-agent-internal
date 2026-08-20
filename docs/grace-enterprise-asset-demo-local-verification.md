# GRACE Enterprise Asset Demo 本地验证记录

验证日期：2026-08-21  
验证范围：Demo Enterprise Asset Pack V1、企业资产接入、知识版本发布、财富经理 Context 消费  
结论：**核心链路已验证，浏览器端到端演示尚未通过最终门禁。**

## 1. 验证结果

### 1.1 资产发现与整改

- 通过管理后台登记 `演示银行企业资产包 V1` 来源并上传 ZIP。
- 60 份资产全部发现成功，耗时 469 ms，无 API 错误。
- 系统识别 37 份待整改资产，并展示缺少生效日期、重复内容、岗位建议和逻辑资产建议。
- Ground Truth Manifest 和解析验证均通过。

### 1.2 知识版本发布

通过真实管理界面完成：

1. V3.2 提交审核、审核通过、进入财富经理岗位验证；
2. WM-GT-02、WM-GT-03 候选级验证通过；
3. V3.2 启用；
4. V3.3 提交审核、审核通过、进入岗位验证；
5. V3.3 候选级验证通过并启用；
6. V3.2 变为已失效，V3.3 变为当前有效。

验证过程发现并修复两个确定性缺陷：

- Role Pack 验收时间与候选更新时间同秒时，发布门禁错误拒绝启用；现改为同秒验收有效，更早验收仍拒绝。
- Knowledge SQL 时间字符串被按本地时区二次换算，造成 8 小时时差；现按 UTC 解析 MySQL TIMESTAMP 字符串。

### 1.3 当前源码的 Context 消费

直接调用当前源码运行的受治理 Platform MCP，结果通过：

- 当前制度：`私人银行产品销售适当性管理办法V3.3.pdf`；
- 版本：`3.3`；
- 生效时间：`2026-08-20T23:13:10.000Z`；
- Readiness：`READY`；
- 已排除同系列历史版本：1 份；
- Receipt：`ea.context-receipt.v1`；
- Effective Context Snapshot 明确记录 V3.3、资产指纹和生效时间。

这证明当前源码中的 `Asset Lifecycle -> Eligibility -> Context Resolution -> Receipt` 链路成立。

### 1.4 浏览器财富经理体验

使用现有财富经理测试账号从浏览器发起“核验当前制度”任务，模型仍返回 V2.2。

原因不是 Resolver 选择错误，而是本地 JiuwenSwarm 的 Platform Tool 仍回调已安装在 `5180` 的旧版 EA；本次待验证源码运行在隔离的 `5182`。旧版 `wealth-policy-selection` 只接受配置文件名的精确命中，不支持同系列新版本选择。

因此当前状态应定义为：

> **Core Context Chain Verified / Browser E2E Blocked by Local Runtime Version Skew**

在本地 EA 与 JiuwenSwarm Platform Tool 指向同一版本前，不能对外标记为“非开发人员端到端可演示”。

## 2. 体验差距

### 必须补

1. **本地发布一致性门禁**：前端、EA API、Platform MCP 和 JiuwenSwarm 必须使用同一构建版本；演示前自动检查并阻止版本漂移。
2. **候选筛选与聚合**：60 行资产直接平铺，需支持待整改、缺 Owner、缺版本、重复、冲突、解析失败、部门和版本系列筛选。
3. **字段化 Metadata**：当前依赖原始 JSON，管理员还需要理解 `documentSeriesId`、文档 publicId 和逻辑资产英文 ID。
4. **版本关系选择**：应让管理员从同系列版本链中选择“替代 V3.2”，不应手工填写运行时文档 ID。
5. **生效时间闭环复验**：UTC 修复后重新跑一次干净的 Pending Effective 场景，保留生效前和生效后的浏览器证据。
6. **Receipt 业务化展示**：员工应看到“本次依据、版本、生效时间、已排除旧版本”，不应看到 `historicalVersionFiltered`、Schema 名等内部字段。

### 后续补

1. 万级导入的异步 Job、进度、失败重试和断点恢复；
2. 批量确认、批量指派 Owner 和异常队列；
3. 字段级建议依据、置信度和 Metadata Provenance；
4. OCR、表格解析和真实 OA/NAS/对象存储 Connector；
5. 提交人与审批人的职责分离策略；
6. 可恢复的独立 Demo Tenant 和演示数据重置。

### 明确不做

- 不让模型自动确认 Owner、Authority、生效日期或正式替代关系；
- 不自动发布正式制度；
- 不为 Demo 引入 RDS、OBS、Redis、RAGFlow、Graph 或新的 Router；
- 不把所有企业业务数据导入知识库；实时事实继续通过 MCP/API 获取。

## 3. 下一门禁

进入 UI 产品化前，先完成以下最小门禁：

1. 将本地已安装 EA/Platform MCP 更新到当前源码版本，或让隔离 JiuwenSwarm 明确指向 `5182`；
2. 从浏览器重新执行财富经理现行政策核验；
3. 确认回答和可视 Receipt 均显示 V3.3；
4. 使用新的未来生效候选复验 Pending Effective -> Active；
5. 再由不看代码的人员独立完成一次完整流程。

只有五项全部通过，状态才升级为：

> **GRACE Enterprise Asset Demo Baseline: End-to-End Scenario Ready**
