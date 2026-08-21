# GRACE Enterprise Asset Demo 本地验证记录

验证日期：2026-08-21  
验证范围：Demo Enterprise Asset Pack V1、企业资产接入、知识版本发布、财富经理 Context 消费  
结论：**核心生命周期与浏览器真实运行链均已通过，当前基线可用于端到端场景演示。**

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

### 1.3 受治理的 Context 消费

受治理 Platform MCP 与浏览器实际运行结果均通过：

- 当前制度：`私人银行产品销售适当性管理办法V3.3.pdf`；
- 版本：`3.3`；
- 生效时间：`2026-08-20T23:13:10.000Z`；
- Readiness：`READY`；
- 已排除同系列历史版本：1 份；
- Receipt：`ea.context-receipt.v1`；
- Effective Context Snapshot 明确记录 V3.3、资产指纹和生效时间。

这证明 `Asset Lifecycle -> Eligibility -> Context Resolution -> Receipt` 链路成立。

### 1.4 浏览器财富经理体验

本地实际运行组件已对齐：

- EA / Platform MCP：提交 `0a601518`，不可变 release `20260821T010059Z-0a601518a3eb`；
- JiuwenSwarm：提交 `14e75bb9`；
- Browser、EA、Platform MCP、Knowledge Service 和 JiuwenSwarm 均走本地 `5180` 正式运行链。

使用现有财富经理测试账号从浏览器发起“核验当前制度”任务，验收结果：

- 回答采用 V3.3；
- “本次依据”面板可见；
- 面板显示版本 `3.3` 与 `08/21 07:13` 生效时间；
- 面板显示已过滤 1 份失效或尚未生效的同系列资料；
- 浏览器刷新/历史对账后仍可从 Jiuwen 历史恢复可信 Receipt；
- 无页面异常或 HTTP 5xx。

机器验收报告：`reports/demo-enterprise-assets/wealth-agent-v33-aligned-report.json`，结果 `PASS`。

本轮额外修复了三处真实链路缺陷：

- JiuwenSwarm 在标准 MCP 结果复制过程中丢失 `_meta`；
- EA 与 Jiuwen 之间未将可信原始工具元数据稳定桥接到响应证据；
- 前端历史对账和 EA 历史解析会用紧凑工具结果覆盖 Receipt。

当前状态定义为：

> **GRACE Enterprise Asset Demo Baseline: End-to-End Scenario Ready**

该结论由两组证据共同组成：管理界面/后端已验证 V3.2 -> V3.3 生命周期切换，浏览器正式运行链已验证当前有效 V3.3 与 Receipt。此次没有重新创建另一份未来生效资产，因此不宣称同一轮浏览器会话重复观察了生效前后两个时点。

## 2. 体验差距

### 必须补

1. **本地发布一致性门禁**：演示前自动检查前端、EA API、Platform MCP 和 JiuwenSwarm 的运行版本，防止版本再次漂移。
2. **候选筛选与聚合**：60 行资产直接平铺，需支持待整改、缺 Owner、缺版本、重复、冲突、解析失败、部门和版本系列筛选。
3. **字段化 Metadata**：当前依赖原始 JSON，管理员还需要理解 `documentSeriesId`、文档 publicId 和逻辑资产英文 ID。
4. **版本关系选择**：应让管理员从同系列版本链中选择“替代 V3.2”，不应手工填写运行时文档 ID。
5. **生效时间浏览器证据**：后续用新的未来生效候选保留 Pending Effective -> Active 的浏览器双时点证据。

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

运行链门禁已经通过。进入 UI 产品化前，只保留两项体验验证：

1. 使用新的未来生效候选补一份 Pending Effective -> Active 浏览器双时点证据；
2. 由不看代码的人员独立完成一次上传、整改、发布和财富经理核验流程。

UI 优先级仍由真实操作摩擦决定，当前候选为 Metadata 字段化、整改队列筛选和建议依据/Provenance 展示，不扩展新的知识引擎或 Router。

本轮所有修改仅发生在本地环境，上海环境未变更。
