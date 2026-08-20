# GRACE Demo Bank Enterprise Asset Pack V1

这是一套完全虚构的企业资产样本，用于演示 GRACE 如何把企业存量文档转化为受治理的岗位 Context。内容不对应任何真实机构、客户、产品、制度或投资意见。

## 包含内容

- 60 份企业资产，覆盖财富管理、风险管理、保险业务和运营审核四个部门。
- 文件格式覆盖 Markdown、PDF、DOCX、XLSX 和 PPTX。
- 三条明确版本链，分别对应财富销售制度、贷后风险预警制度和保险销售制度。
- 故意包含缺版本、缺生效时间、岗位无法识别、历史文件和重复内容等整改场景。
- `ground-truth-manifest.json` 保存每份资产的业务预期、校验和、版本关系和预期诊断。

## 生成与验收

生成 Office 文件需要现有 Knowledge Python 环境中的 `python-docx`、`openpyxl` 和 `python-pptx`。默认使用 `$HOME/.venvs/employee-agent-knowledge/bin/python`，也可通过 `KNOWLEDGE_PYTHON` 指定。

```bash
pnpm demo:assets:e2e
```

生成物位于：

```text
examples/demo-bank-enterprise-assets-v1/generated/
├── assets/
├── demo-bank-enterprise-assets-v1.zip
└── ground-truth-manifest.json
```

验收会真实复用现有资产 Discovery、Metadata 建议和知识解析器，检查：

- ZIP 能安全发现 60 份受支持文件；
- 文件数和总体积符合当前单批 `100` 份、`50MB` 的限制；
- 版本、岗位、业务域、逻辑资产候选和整改诊断符合 Ground Truth；
- 重复文件具有完全相同的内容指纹；
- 三条版本链得到稳定的 `documentSeriesId`；
- 所有文件均能被当前 Knowledge Parser 提取出可索引文本。

## 本地演示流程

1. 在管理后台的企业资产页面创建来源：

```text
来源 ID：demo-bank-assets-v1
名称：演示银行企业资产包 V1
类型：文档库
责任部门：演示银行企业资产管理部
同步模式：手工
```

2. 选择 ZIP 导入，上传 `generated/demo-bank-enterprise-assets-v1.zip`。
3. 先按整改问题查看缺版本、缺生效时间、重复内容、疑似旧版和岗位未识别的候选资产。
4. 打开 `财富管理部/制度/私人银行产品销售适当性管理办法V3.3.pdf`，确认以下企业事实：

```text
适用岗位：wealth-manager
权威级别：official
逻辑资产：current_wealth_policy
关联任务：WM-GT-02、WM-GT-03
生效时间：本地演示计划的真实未来时间
```

5. 按现有流程审核、暂存、运行 Golden Task 验证并激活。生效前后分别执行财富经理任务，核对 Context Receipt 中采用和排除的版本。

## 当前边界

- 这是本地演示资产，不应导入上海生产空间。
- ZIP/文件上传会暂存正文；对象清单模式目前只登记资产，不拉取对象正文。
- Metadata 初判对 Markdown 等文本可启用模型摘要；PDF、DOCX、XLSX、PPTX 当前主要依赖目录和文件名，发布前仍需管理员确认企业事实。
- Ground Truth 是回归和演示基线，不是可直接发布的企业事实 Manifest。
- `Context Snapshot` 支持依据追溯，不代表可以完整重放历史决策。
