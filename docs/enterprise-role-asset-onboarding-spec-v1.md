# 灵感企业岗位资产接入规范 V1.0

> 文档状态：设计基线
>
> 适用对象：企业 IT、业务部门、知识管理员、合规与风险人员、平台管理员、MCP 与 Skill 开发者、实施与测试人员
>
> 适用范围：企业岗位知识、业务数据、业务规则、岗位流程、能力接口及其在 GRACE 运行时中的接入、治理、发布和验证
>
> 核心目标：不要求企业重写既有制度，通过受控接入和岗位映射，让企业现有资产成为 Agent 当前任务可使用、可执行、可审计的 Context

---

## 1. 结论

灵感的岗位包不是用平台提供的演示资料替代企业自己的制度、流程和系统。

企业部署的正确关系是：

```text
灵感 Reference Role Pack
  提供岗位结构、参考 Skill、参考 Policy、Capability Contract、标杆任务和 Eval
                           +
企业真实资产
  企业岗位、制度、SOP、业务规则、CRM、产品系统、权限和审批流程
                           ↓
             Enterprise Asset Onboarding
                           ↓
                  GRACE Context Layer
                           ↓
       当前任务的 Eligible Context Pack
                           ↓
       Agent + Governance + Capability + Evidence
```

规范冻结以下原则：

1. 企业原始制度和业务系统始终是权威来源，灵感不替企业改写制度。
2. 企业资产统一通过接入流程进入 GRACE Context 层，不直接散落到 Prompt、Skill 或运行时配置。
3. Context 不是文件集合，而是当前岗位、当前用户、当前任务有资格使用的企业现场。
4. 文档正文原则上不改写；通过元数据、岗位映射、版本关系和任务标签增强其可用性。
5. 动态客户、产品、持仓、风险和业务状态通过 MCP 获取，不作为静态知识文档导入。
6. 确定性业务规则不能只存在于文档或 Prompt 中，必须经人工确认后形成 Governance Policy。
7. 岗位流程不能只依赖模型阅读 SOP 临场发挥，稳定流程应由 Skill 或 Workflow 承载。
8. AI 可以建议元数据、规则候选和流程候选，但不能自行发布正式知识或启用业务 Policy。
9. 每项已发布资产必须可追溯到来源、版本、责任部门、审批记录和验证结果。
10. 缺少必要资产或资产状态不确定时，高风险业务任务必须 fail-close，低风险任务应给出可恢复说明。

---

## 2. GRACE 中的资产接入位置

### 2.1 Context 是企业资产的统一入口

企业资产接入首先进入 GRACE Context 层，由 Context 层完成：

- 来源登记；
- 结构解析；
- 元数据补充；
- 岗位和组织映射；
- 密级与权限映射；
- 生命周期与版本管理；
- 当前任务资格判定；
- 数据、知识、记忆和能力元数据的装配；
- Context Evidence 生成。

```text
Enterprise Sources
  ├── 制度与文档
  ├── CRM / AUM / 产品 / 风险系统
  ├── 岗位流程与检查表
  ├── 业务规则
  └── API / MCP / Workflow
             ↓
Enterprise Asset Onboarding
             ↓
GRACE Context Layer
  ├── Knowledge Context
  ├── Business Data Context
  ├── Task State Context
  ├── Memory Context
  └── Capability Metadata Context
             ↓
Eligible Context Pack
```

### 2.2 Context 不是最终执行位置

资产进入 Context 后，根据资产性质形成受控投影：

| 资产 | Context 中的形态 | 后续消费位置 |
|---|---|---|
| 制度、办法、操作手册 | 有效知识、引用和适用范围 | Agent 回答、解释和任务规划 |
| 客户、产品、持仓、风险状态 | MCP 返回的当前业务数据 | Agent 分析和 Policy 输入 |
| 确定性规则 | 规则依据、版本和参数 | Governance Policy Adapter |
| 岗位流程 | 流程依据、步骤和前置条件 | Skill / Workflow |
| 业务能力 | Tool Schema、风险属性、授权范围 | Capability Registry 和 PEP |
| 运行记忆 | 当前岗位实例的稳定偏好与任务状态 | Agent Memory / Task State |

规则进入 Governance、流程进入 Skill、动作进入 Capability，并不意味着绕过 Context。它们必须保留对 Context 中原始资产、当前版本和适用范围的引用。

---

## 3. 接入资产分类

### 3.1 Knowledge：岗位知识与企业制度

典型资产：

- 法律法规与监管文件；
- 企业制度、管理办法和实施细则；
- 岗位 SOP、作业指导书和检查表；
- 产品说明、业务口径和常见问题；
- 培训材料、营销材料和标准话术；
- 操作手册、审批目录和异常处理指引。

处理原则：

- 保留原始文件和校验值；
- 正文原则上不修改；
- 解析后的文本、表格和章节必须可定位回原文；
- 补充岗位、密级、有效期、来源和版本关系；
- 当前任务只检索资格判定通过的文档；
- 引用必须关联原始文件、章节或页码。

### 3.2 Data：当前业务数据

典型资产：

- 客户基本信息和客户归属；
- AUM、持仓、交易和产品到期信息；
- 风险评级、测评结果和有效期；
- 当前在售产品、风险等级、销售期限和渠道限制；
- 贷后指标、预警信号和处置状态；
- 审核材料状态、业务工单和审批进度。

处理原则：

- 通过企业 MCP 或受控业务接口按需查询；
- 不复制到知识库，不写入长期记忆；
- 服务端按 tenant、user、role 和业务归属做行级过滤；
- 返回数据必须包含业务时间或 `asOf`；
- 敏感字段遵循最小必要和脱敏展示；
- MCP 是业务数据入口，原业务系统仍是真相源。

### 3.3 Policy：确定性业务规则

适合规则化的内容：

- 客户与产品风险等级匹配；
- 风险测评是否仍在有效期；
- 产品是否在售、渠道是否允许；
- 岗位是否有权查询、提交或发送；
- 金额、等级、地区或事项对应的审批层级；
- 数据是否允许外发；
- 业务动作是否需要确认、幂等和强审计。

不宜规则化的内容：

- 沟通风格和措辞偏好；
- 开放式分析方法；
- 需要专业人员综合判断的建议；
- 缺少稳定结构化输入的原则性条款。

处理原则：

```text
权威制度条款
  ↓ AI 或实施人员提取规则候选
业务部门确认语义和参数
  ↓
合规 / 风险确认控制要求
  ↓
开发或配置 Policy Adapter
  ↓
测试、审批和版本发布
  ↓
Governance PEP 强制执行
```

Policy 必须记录来源文档、条款位置、规则版本、审批人、生效时间和回滚版本。文档负责解释，Policy 负责裁决。

### 3.4 Process：岗位流程

典型资产：

- 客户访前准备；
- 资产配置方案制作；
- 产品适配与推荐；
- 客户回访和 CRM 留痕；
- 贷后预警核实与升级；
- 凭证审核和缺件处理；
- 保险需求分析和方案生成；
- 投研报告编制和复核。

处理原则：

- 原 SOP 作为 Knowledge 保留；
- 稳定步骤、输入、工具依赖和输出格式映射为 Skill；
- 跨系统、长时间或需要状态流转的流程映射为 Workflow；
- 每一步需要的业务能力由 Capability Registry 管理；
- 高风险步骤由 Governance 决定 ALLOW、DENY 或 REQUIRE_APPROVAL。

### 3.5 Capability：业务能力

典型资产：

- MCP Tool；
- 企业 API；
- Workflow；
- A2A Agent；
- 内部函数；
- 文件、沙箱、浏览器和通知能力。

处理原则：

- 企业 MCP 由管理员登记并授权到岗位；
- Tool 名称、Schema、sideEffect、scope、审批和幂等要求必须明确；
- 动态数据读取与业务写操作必须区分；
- 外部服务声明不能降低平台判断的风险等级；
- 所有业务副作用必须具有确定性 PEP。

### 3.6 不属于企业预置资产的内容

以下内容不应作为企业 Reference Role Pack 的静态资产导入：

- 真实客户数据；
- 实时产品状态和行情；
- 用户密码、Token、密钥和连接凭证；
- 个人短期对话内容；
- 未经确认的 AI 推断；
- 与当前岗位无关的大范围敏感数据。

---

## 4. 企业是否需要改造原文档

### 4.1 默认答案：不需要重写

灵感不要求企业把全部制度改写成平台模板。大多数原文可以保持不变，通过独立元数据完成治理。

| 资产类型 | 企业提供 | 灵感处理 | 是否改正文 |
|---|---|---|---|
| 法规、制度和管理办法 | 原文件、来源、版本和权限信息 | 解析、索引、元数据和引用 | 通常不需要 |
| SOP 和作业指导书 | 原文件、适用岗位和流程责任人 | 知识解析和 Skill 映射 | 通常不需要 |
| 表格与检查表 | 原表格、字段说明和版本 | 结构解析、字段校验和任务映射 | 可能需要整理表头 |
| 扫描件和复杂版式 | 原文件和原始影像 | OCR、版面解析和人工抽查 | 不改原件，可能生成受控解析副本 |
| 确定性规则 | 权威条款、参数和例外 | 生成 Policy 候选并人工确认 | 原文不改，另建规则记录 |
| 动态数据 | 系统接口和权限模型 | MCP 适配和行级授权 | 不进入文档 |

### 4.2 可能需要整理的情况

以下情况不要求改写权威原文，但需要在接入过程中补充或拆分：

- 多个版本文件名相同；
- 正文未写明生效和失效时间；
- 扫描件无法稳定提取文字；
- 同一文件包含多个岗位、密级或生命周期不同的附件；
- 表格缺少稳定字段名或单位；
- 制度正文与附件、补充通知之间存在替代关系；
- 同一条规则在多个文件中冲突；
- 文件没有明确责任部门和发布依据。

所有整理结果必须作为派生资产保存，不能覆盖企业原始文件。

---

## 5. 元数据规范

### 5.1 V1 必填字段

| 字段 | 含义 | 示例 |
|---|---|---|
| `assetId` | 企业内稳定资产标识 | `doc_wealth_sales_policy` |
| `name` | 资产名称 | 财富产品销售管理细则 |
| `assetType` | 资产类别 | `knowledge_document` |
| `sourceSystem` | 来源系统 | OA 制度库 |
| `ownerDepartment` | 责任部门 | 财富管理部 |
| `classification` | 密级 | `internal` |
| `applicableRoles` | 适用岗位 | `wealth-manager` |
| `lifecycle` | 生命周期 | `active` |
| `versionLabel` | 版本 | `V2.2` |
| `authority` | 权威等级 | `approved` |
| `externalProcessingAllowed` | 是否允许外部模型处理 | `false` |
| `checksum` | 原始内容校验值 | SHA-256 |

### 5.2 条件必填字段

| 字段 | 使用条件 | 示例 |
|---|---|---|
| `effectiveAt` | 存在明确生效时间 | `2026-07-01T00:00:00+08:00` |
| `expiresAt` | 存在失效时间 | `2027-06-30T23:59:59+08:00` |
| `documentSeriesId` | 存在连续版本 | `wealth-sales-policy` |
| `supersedes` | 替代上一版本 | `doc_wealth_sales_policy_v21` |
| `sourceUri` | 来源可定位 | OA 文档 ID 或受控 URL |
| `applicableOrganizations` | 仅适用部分组织 | 上海分行 |
| `relatedTasks` | 与岗位任务关联 | `customer-previsit` |
| `policyCandidates` | 含确定性规则 | `suitability-match` |
| `retentionPolicy` | 有法定保存要求 | `sales-record-20y` |

### 5.3 当前系统已支持字段

当前 Employee Agent 已支持并实际参与运行时治理的字段：

```text
knowledge base:
  scope
  roleTemplate
  classification
  externalProcessingAllowed

knowledge document:
  versionLabel
  lifecycle
  sourceDepartment
  classification
  authority
  effectiveAt
  expiresAt
  externalProcessingAllowed
```

V1 目标需要补充的关键字段：

```text
sourceSystem
sourceUri
documentSeriesId
supersedes
applicableOrganizations
relatedTasks
policyCandidates
checksum 的管理端可见性
```

### 5.4 接入清单模板

企业可以使用 CSV、JSON 或 YAML 提交元数据清单。清单只是原始资产的接入侧车文件，用于批量导入、审核和来源同步，不是新的 Runtime 配置源；发布后仍由现有 Knowledge、Role、Policy、Skill、Enterprise MCP 和 Governance 模块消费。

推荐的最小 YAML 样例如下：

```yaml
schemaVersion: linggan.enterprise-asset/v1
enterpriseId: example-bank
assets:
  - assetId: doc_wealth_sales_policy_v22
    name: 财富产品销售管理细则
    assetType: knowledge_document
    sourceSystem: oa-policy-center
    sourceUri: oa://policy/wealth-sales/2026-v22
    ownerDepartment: 财富管理部
    classification: internal
    applicableRoles:
      - wealth-manager
    applicableOrganizations:
      - head-office
      - shanghai-branch
    lifecycle: active
    versionLabel: V2.2
    documentSeriesId: wealth-sales-policy
    supersedes: doc_wealth_sales_policy_v21
    authority: approved
    effectiveAt: 2026-07-01T00:00:00+08:00
    expiresAt: null
    externalProcessingAllowed: false
    relatedTasks:
      - customer-previsit
      - product-recommendation
    policyCandidates:
      - suitability-match
    checksum: sha256:<由导入工具计算或企业提供>
    file: originals/财富产品销售管理细则-V2.2.pdf
```

导入时必须执行以下校验：

- `assetId` 在企业范围内稳定且唯一；
- `file` 或 `sourceUri` 至少存在一个；
- 实际文件校验值与 `checksum` 一致；
- 岗位和组织标识能够映射到企业身份目录；
- 生命周期、有效期和替代关系无冲突；
- 清单不能包含密码、Token、私钥或业务系统长期凭证；
- 未被当前平台支持的扩展字段可以保留，但不得静默影响运行时授权。

批量交付建议使用以下目录：

```text
enterprise-assets/
  manifest.yaml
  originals/
    财富产品销售管理细则-V2.2.pdf
    客户访前准备作业指导书-V1.3.docx
  attachments/
    财富产品销售检查表-V2.2.xlsx
```

平台导入完成后应生成接入报告，至少列出：成功资产、失败资产、重复资产、元数据缺失、版本冲突、解析质量、权限映射结果和待人工确认事项。

---

## 6. 角色、组织与权限映射

### 6.1 三类知识作用域

| scope | 使用对象 | 示例 |
|---|---|---|
| `enterprise` | 企业内所有有相应密级权限的岗位 | 差旅、信息安全、基础合规 |
| `role` | 指定岗位 | 财富经理销售 SOP、风控预警指引 |
| `personal` | 当前用户 | 个人研究、工作沉淀、未发布草稿 |

### 6.2 企业岗位映射

银行不需要把内部岗位名称改成灵感模板名称。实施时建立映射：

```text
银行岗位：零售财富客户经理
  -> Reference Role：wealth-manager
  -> 组织范围：上海分行零售金融部
  -> Permission Profile：internal
  -> Knowledge：总行制度 + 上海分行实施细则
  -> MCP：客户、产品、CRM
  -> Policy：适当性、渠道、数据权限
```

岗位映射必须由企业管理员确认。岗位名称相同不代表权限相同，授权不得只依赖字符串角色名。

### 6.3 权限事实来源

- 用户和组织身份由企业 IAM、SSO 或受控账号系统提供；
- 岗位实例由 Adoption 和 Role Template 绑定；
- 文档访问由 scope、role、organization、classification 和 clearance 共同决定；
- 客户数据归属由业务系统和 MCP 服务端判定；
- Capability 授权由岗位资产授权和企业 MCP Policy 判定；
- 高风险动作的最终决策由 Governance PEP 执行。

---

## 7. 接入流程

### 7.1 阶段 0：资产盘点

企业与实施方共同形成资产清单：

- 岗位和组织；
- 制度、SOP、检查表和产品资料；
- CRM、产品、风险、营销和审批系统；
- 确定性业务规则；
- 可调用业务动作；
- 数据密级和外部处理限制；
- 当前版本和责任部门。

产出：`Enterprise Asset Inventory`。

### 7.2 阶段 1：来源接入

V1 当前支持：

- 文件上传；
- 对话和工作空间产物沉淀到个人知识；
- 管理脚本导入岗位和企业知识；
- 企业 MCP 注册和岗位授权。

目标支持：

- 批量文件和元数据清单导入；
- OA、SharePoint、对象存储和企业知识平台连接器；
- 增量同步、删除同步和来源变更检测；
- 来源系统 ACL 映射；
- 断点续传和大批量任务状态。

### 7.3 阶段 2：解析与建议

平台执行：

- 文件类型和恶意内容检查；
- 文本、章节、表格和页码解析；
- 内容指纹和重复检查；
- 元数据候选建议；
- 版本系列和替代关系候选；
- 适用岗位和任务候选；
- 确定性规则候选；
- 解析质量和敏感信息提示。

所有候选均为草稿状态。

### 7.4 阶段 3：人工确认

至少需要以下角色参与：

| 内容 | 确认责任 |
|---|---|
| 文档来源、版本和有效期 | 知识管理员 / 责任部门 |
| 岗位和组织适用范围 | 业务部门 / 人力权限管理员 |
| 密级和外部处理限制 | 数据安全 / 合规 |
| 规则语义和例外 | 业务部门 / 合规 / 风险 |
| Skill 流程 | 岗位专家 / 流程责任人 |
| MCP 数据权限 | 业务系统负责人 / IT / 安全 |

### 7.5 阶段 4：发布与索引

发布前必须满足：

- 来源可验证；
- 元数据完整；
- 权限映射明确；
- 生效和失效时间无矛盾；
- 替代关系无循环；
- 解析质量达到阈值；
- 敏感数据处理方式获批；
- 关键规则已决定是否进入 Policy；
- 关键流程已决定是否进入 Skill；
- 发布操作留有审计记录。

发布后：

```text
ACTIVE Asset
  ↓ Knowledge Eligibility
  ↓ Retrieval / MCP / Memory / Capability Metadata
  ↓ Eligible Context Pack
```

### 7.6 阶段 5：任务验证

资产发布不等于岗位可用。必须执行对应岗位的标杆任务矩阵：

- 正常任务；
- 知识版本治理；
- 权限拒绝；
- 业务规则拒绝；
- 人工确认；
- 业务执行；
- 依赖异常和恢复。

验证通过后，相关资产才可标记为 Role Pack Ready。

---

## 8. 生命周期与版本管理

### 8.1 文档生命周期

```text
DRAFT
  -> REVIEWED
  -> ACTIVE
  -> SUPERSEDED / EXPIRED
  -> ARCHIVED
```

当前运行模型使用：

```text
draft | active | expired | archived
```

目标接入工作流中的 `REVIEWED` 和 `SUPERSEDED` 可以先作为审批状态和版本关系表达，不要求立即扩大检索生命周期枚举。

### 8.2 新版本发布

新版本发布必须是原子过程：

1. 新版本处于草稿或待审核；
2. 完成元数据、权限和解析验证；
3. 设置 `documentSeriesId` 和 `supersedes`；
4. 设置新版本 `effectiveAt`；
5. 设置旧版本 `expiresAt` 或标记失效；
6. 同一制度系列在同一适用范围内不得出现无法解释的重叠有效版本；
7. 重建索引并运行知识治理任务；
8. 通过后切换生效；
9. 保留旧版本用于审计，不提供给当前任务。

### 8.3 来源同步

同步连接器发现来源变更时不得直接覆盖当前有效资产：

```text
Source Changed
  -> New Draft Revision
  -> Diff + Impact Analysis
  -> Human Review
  -> Publish
```

删除来源文件时，平台应根据企业保留策略决定失效、归档或阻止删除，不能静默移除审计依据。

---

## 9. Knowledge、Policy 与 Skill 的关联

### 9.1 单一权威来源

```text
原始制度条款
  ├── Knowledge：用于检索、引用和解释
  ├── Policy：用于确定性裁决
  └── Skill：用于执行稳定岗位流程
```

三者不能复制出互不关联的规则文本。Policy 和 Skill 必须保存来源资产 ID、版本和条款位置。

### 9.2 变更影响分析

制度新版本发布时，系统至少应提示：

- 哪些 Policy 引用了旧版本；
- 哪些 Skill 依赖旧流程；
- 哪些 Golden Task Eval 需要重跑；
- 哪些岗位包受影响；
- 是否需要暂停相关高风险能力。

如果关键 Policy 尚未完成新版本适配，高风险能力应保持旧 Policy 到批准的切换时间，或按企业决定 fail-close，不能由模型自行解释新旧差异后继续执行。

---

## 10. 动态数据与 MCP 接入

### 10.1 数据不进入知识库

以下示例必须通过 MCP：

```text
客户画像
客户归属
AUM 与持仓
风险评级和测评有效期
当前在售产品
产品风险等级和销售期限
CRM 跟进任务
审批和业务状态
```

演示环境可在 MCP 后端使用脱敏 Fixture，但 Agent 仍必须通过 MCP 查询，禁止直接读取 `张先生.json` 或 `产品池.json`。

### 10.2 企业 MCP 最低要求

- HTTPS Streamable HTTP 或受控内网等价方案；
- EA 短期可信身份；
- tenant/user/role/tool/scope 绑定；
- 服务端行级授权；
- 数据时间戳；
- 平台和服务端双侧审计；
- 写操作审批、幂等和业务回执；
- 健康检查、超时和可观测性；
- 原始源站网络收口。

详细要求见《企业 MCP 接入与治理规范 v1》。

---

## 11. Context Eligibility 与降级行为

### 11.1 资格判定顺序

知识进入当前任务前必须依次检查：

```text
scope / role / organization
  ↓
lifecycle
  ↓
effectiveAt / expiresAt
  ↓
classification / clearance
  ↓
authority ordering
  ↓
retrieval
```

业务数据进入当前任务前必须检查：

```text
tenant
  ↓
user / role / agent identity
  ↓
business ownership
  ↓
scope
  ↓
field minimization
  ↓
freshness
```

### 11.2 缺失和过滤说明

用户可见说明必须安全、准确且可恢复：

| 场景 | 用户说明 |
|---|---|
| 现行知识缺失 | 当前没有可用于本次判断的现行企业依据，请联系知识管理员 |
| 文档全部过期 | 当前候选知识中没有现行有效版本，本次不据此形成正式结论 |
| 文档尚未生效 | 相关制度尚未生效，本次未作为依据 |
| 权限或密级不足 | 当前没有可授权使用的企业依据 |
| MCP 数据不可用 | 业务数据服务暂时不可用，未使用缓存数据替代当前事实 |
| Policy 不可用 | 安全策略暂时不可用，为保护业务已暂停该操作 |

不得向无权限用户显示受限文档名称、内容或可推断其存在的精确数量。

### 11.3 Readiness Gate

每项岗位任务发布前声明必要条件：

```text
KnowledgeReady
DataReady
SkillReady
PolicyReady
CapabilityReady
EvalPassed
```

示例：财富经理正式产品推荐至少要求：

- 当前有效的适当性制度；
- 当前客户风险评级及有效期；
- 当前产品风险等级和在售状态；
- 产品推荐 Skill；
- 适当性 Policy；
- 对应 Eval 已通过。

任何必要条件不满足时，不得假装完成正式业务判断。

---

## 12. Evidence 与审计

### 12.1 必须能够回答的问题

企业部署后必须能够回答：

- 谁以什么岗位身份发起任务；
- 当时使用了哪些企业资产；
- 哪些文档因有效期、权限或密级被排除；
- 使用了哪一版 Policy；
- 查询了哪些 MCP 和业务数据时间点；
- Agent 当时有哪些 Capability；
- 为什么允许、拒绝或要求确认；
- 最终执行了什么业务动作；
- 下游业务系统返回了什么回执。

### 12.2 最小 Evidence

```text
principalFingerprint
contextEligibilityFingerprint
selectedKnowledgeIds
selectedKnowledgeVersions
businessDataAsOf
capabilitySetFingerprint
policyDecisionId
ruleVersion
approvalId
executionReceipt
correlationId
```

默认不保存完整 Prompt、完整客户数据和原始敏感 Tool Input。审计保存标识、版本、指纹、决策和必要业务回执。

---

## 13. Reference Role Pack 与企业映射

### 13.1 Reference Role Pack 的定位

灵感提供的财富经理、保险顾问、风控经理等岗位包均为参考岗位包，提供：

- 推荐岗位结构；
- 参考 SOP 和知识分类；
- 参考 Skill；
- MCP Capability Contract；
- Policy 类型；
- 岗位标杆任务矩阵；
- Eval 方法和验收阈值。

它不替企业定义正式制度、产品、客户范围和审批权限。

### 13.2 企业映射示例

```text
Reference：财富产品销售管理细则 V2.2（演示）
  ↓ Enterprise Binding
银行：个人财富类产品销售管理办法 2026 修订版

Reference：wealth_customer_data MCP
  ↓ Enterprise Binding
银行：CRM + AUM 查询服务

Reference：suitability-policy
  ↓ Enterprise Binding
银行：适当性制度条款 + 产品中心风险评级规则

Reference：create_followup
  ↓ Enterprise Binding
银行：CRM 客户跟进任务接口
```

绑定完成后，Golden Task、Skill 流程和 Eval Contract 原则上保持稳定，替换的是企业资产映射。

---

## 14. 与岗位标杆任务矩阵的关系

[《灵感银行·财富经理岗位标杆任务矩阵 V1.0》](./linggan-bank-wealth-manager-benchmark-task-matrix-v1.md)必须引用本规范，不能把演示资产写成不可替换的运行依赖。

每项任务至少包含：

| 字段 | 说明 |
|---|---|
| Task | 岗位任务名称和目标 |
| Reference Asset | 灵感演示环境提供的参考资产 |
| Enterprise Binding | 企业部署时必须映射的真实资产 |
| Required Metadata | 资产必须具备的治理字段 |
| Data Contract | MCP 输入、输出和数据时效 |
| Skill | 稳定任务流程 |
| Policy Binding | 确定性规则 |
| Capability | 查询或业务动作 |
| Readiness Gate | 运行必要条件 |
| Expected Outcome | 业务结果 |
| Evidence | 需要展示或审计的依据 |
| Eval Assertions | 成功、拒绝和异常恢复断言 |

财富经理首版标杆任务矩阵作为 Reference Implementation，后续使用同一 Schema 扩展：

- 通用助手；
- 风控经理；
- 审核专员；
- 保险顾问；
- 投顾分析。

---

## 15. 实施责任边界

| 事项 | 灵感平台 | 企业 IT | 业务 / 合规 |
|---|---|---|---|
| 文档格式解析和索引 | 主责 | 提供样本与环境 | 抽查解析质量 |
| 原始资产和版本真相 | 不替代 | 接入来源系统 | 确认权威版本 |
| 元数据建议 | 提供工具 | 批量映射和同步 | 最终确认 |
| 岗位和组织映射 | 提供模型与配置 | 对接 IAM / SSO | 确认职责边界 |
| MCP 网关与治理 | 主责 | 网络和业务系统适配 | 确认数据范围 |
| 行级数据授权 | 传递可信身份 | MCP 和业务系统主责 | 定义归属规则 |
| Policy 技术实现 | 主责 | 配置和部署配合 | 确认规则与例外 |
| Skill 流程实现 | 提供框架 | 系统集成配合 | 岗位专家确认 |
| Golden Task Eval | 提供框架和基线 | 提供测试环境 | 确认预期结果 |
| 发布和变更审批 | 提供流程和审计 | 平台运营 | 业务 / 合规批准 |

---

## 16. 当前实现状态与差距

### 16.1 已实现

- 个人、岗位、企业三类知识作用域；
- 岗位知识 `roleTemplate` 映射；
- 文档生命周期、生效期、失效期、密级、权威等级和来源部门；
- Knowledge Eligibility 硬过滤；
- LlamaIndex 混合检索、父子分块、元数据过滤和引用定位；
- PDF、DOCX、XLSX、PPTX、Markdown、TXT、CSV、JSON、YAML 文件解析入口；
- 企业 MCP 注册、可信身份、岗位授权、工具策略、审计、审批和幂等基础；
- Role、Skill 和 MCP 基线组合；
- Context Evidence 的部分指纹和知识 ID 记录。

### 16.2 当前主要差距

- 企业和岗位知识库的管理员自助创建、批量上传和治理 UI；
- 文档治理元数据的完整可视化编辑；
- 企业来源连接器和增量同步；
- 来源 ACL 到岗位和组织权限的自动映射；
- `documentSeriesId`、`supersedes` 和版本冲突检测；
- AI 元数据建议与人工审核工作流；
- 规则候选到 Policy Adapter 的审批和发布工作流；
- SOP 到 Skill / Workflow 的映射工作台；
- 变更影响分析；
- 企业岗位资产 Readiness Dashboard；
- 统一的岗位标杆任务 Eval Runner。

不得把本节目标能力对客户描述为已经完成。

---

## 17. 首个银行 PoC 的最小交付

财富经理 PoC 不要求先接入全部制度库。建议最小范围：

### 17.1 企业资产

- 5 至 7 份财富经理岗位制度、SOP 和检查表；
- 1 个现行制度和 1 个过期版本，用于知识治理验证；
- 5 个脱敏合成客户，通过客户 MCP 提供；
- 6 至 10 个演示产品，通过产品 MCP 提供；
- 1 个客户跟进创建能力；
- 适当性、测评有效期、产品状态、渠道和岗位权限 Policy。

### 17.2 标杆任务

- 客户访前准备；
- 资产配置建议；
- 最新销售政策判断；
- 风险错配拦截；
- 客户回访创建；
- 产品到期提醒。

### 17.3 验收结果

- Agent 不使用过期制度；
- Agent 不越权读取客户；
- 风险错配和测评过期被确定性阻断；
- 当前可售产品来自 MCP，而不是静态知识；
- CRM Demo 写操作需要确认且不会重复执行；
- 每项结果能展示来源、版本、决策和执行回执；
- 依赖不可用时不给出伪造的正式结论。

---

## 18. 后续实施顺序

```text
Phase 0
冻结本规范和岗位标杆任务矩阵 Schema

Phase 1
完成财富经理企业资产盘点与参考资产

Phase 2
产品化企业 / 岗位知识管理和治理元数据 UI

Phase 3
接入财富客户、产品和 CRM MCP

Phase 4
实现适当性等关键 Policy Adapter

Phase 5
完成财富经理标杆任务 Eval

Phase 6
形成财富经理 Reference Role Pack V1

Phase 7
按同一规范扩展风控经理、审核专员、保险顾问和投顾分析

Phase 8
建设来源系统连接器、批量同步和变更影响分析
```

---

## 19. 验收清单

### 19.1 资产真实性

- [ ] 原始文件和来源系统可验证
- [ ] 原始内容有校验值且未被平台覆盖
- [ ] 权威部门和版本已确认
- [ ] 演示数据明确标注，不与生产数据混淆

### 19.2 Context 治理

- [ ] 岗位、组织、密级和有效期参与确定性资格判定
- [ ] 过期、未生效和无权限资产不会进入模型 Context
- [ ] 动态业务数据来自 MCP 并包含数据时间
- [ ] Context Evidence 可还原本次实际使用的资产

### 19.3 Policy 与 Skill

- [ ] 关键确定性规则已经人工确认并由 PEP 执行
- [ ] Policy 可追溯到权威条款和版本
- [ ] 稳定岗位流程由 Skill / Workflow 承载
- [ ] Skill 不保存业务凭证和真实客户数据

### 19.4 Capability

- [ ] 企业 MCP 使用可信身份和最小 scope
- [ ] 服务端执行租户和用户行级授权
- [ ] 写操作具备审批、幂等、审计和业务回执
- [ ] Capability 不可用时任务按设计降级或阻断

### 19.5 上线验证

- [ ] 正常、拒绝、确认和异常恢复任务均通过
- [ ] 未授权执行率为 0
- [ ] 过期知识使用率为 0
- [ ] 无依据企业事实输出率达到企业验收阈值
- [ ] 资产变更后受影响 Eval 已重新执行
- [ ] Role Pack Readiness Gate 全部通过

---

## 20. 最终产品表达

面向企业时，灵感不应表达为：

> 把 PDF 上传后即可得到一个财富经理 Agent。

应表达为：

> 灵感通过企业岗位资产接入，将企业既有的制度、业务数据、岗位流程、业务规则和系统能力转化为当前岗位可使用、可执行、可审计的 Context，并由 GRACE 运行时在身份、权限和治理边界内完成真实岗位任务。

企业不需要重建自己的知识体系。灵感提供 Reference Role Pack、接入规范、治理能力和 Eval，企业继续拥有并维护自己的制度、系统和业务规则。

---

## 21. V1 实现状态

管理端“岗位资产接入”已实现最小发布闭环：

```text
来源登记
-> linggan.enterprise-asset/v1 Manifest 导入
-> 元数据人工确认
-> 独立审核
-> 绑定现有 Runtime 资产
-> 发布与影响分析
-> 相关 Role Pack 验收状态标记 stale
```

发布目标只允许现有的 Knowledge Document、Enterprise MCP、已审核 Skill 或启用岗位。Policy 候选不能通过配置直接变成可执行策略，必须先实现并测试 Policy Adapter，再登记绑定。该限制用于防止接入控制面成为第二套 Runtime 配置源。

V1 不包含来源系统定时同步、AI 自动发布规则、AI 自动发布 Skill 或自动修改企业正文。上述能力后续仍须遵循“机器建议、人工确认、显式发布”的原则。
