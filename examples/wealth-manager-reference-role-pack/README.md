# 灵感银行财富经理 Reference Role Pack 工作区

本目录保存财富经理参考岗位包的可版本化资产。它用于发布、演示和 Eval，不是第二套 Runtime 配置源。

当前范围：

- `skills/privbank-previsit`：WM-GT-01 客户访前准备参考 Skill；
- `skills/wealth-manager-assistant`：复用并升级现有财富经理主 Skill，客户化正式推荐统一走治理后的候选集合；
- `eval/wm-gt-01-cases.json`：首个标杆任务的场景与硬断言。
- `eval/wm-gt-02-cases.json`：资产配置与产品适配的正常、拒绝和降级断言；
- `eval/wm-gt-03-cases.json`：现行制度选择、历史版本过滤和无现行依据降级断言；
- `eval/wm-gt-04-cases.json`：风险错配、测评过期和用户补救指引断言；
- `eval/wm-gt-05-cases.json`：方案草稿与跟进任务的确认、幂等和隔离 Demo 回执断言；
- `eval/wm-gt-06-cases.json`：到期客户范围、优先级、降级和后续写入边界断言；
- `knowledge/manifest.json`：财富经理岗位 Knowledge 的版本、生命周期、责任部门和标杆任务映射；正文保存在 `../financial-enterprise-knowledge-demo`。

首版岗位 Knowledge 包含 7 类员工材料：岗位边界、访前准备、资产配置、适当性细则、销售检查、CRM 留痕和产品到期经营。适当性细则同时保留 V2.2 现行版与 V2.1 历史版，用于验证 Knowledge Eligibility，不允许历史版进入当前任务 Context。

安装命令默认只输出计划；使用 `--apply` 后才会发布 Skill、授予财富经理默认资产，并把客户数据 MCP 写入现有岗位基线的就绪检查。产品 MCP 是 WM-GT-01 的可降级依赖，不作为访前简报的启动门槛；WM-GT-02 正式候选产品必须经过平台工具 `prepare_wealth_allocation_context` 的确定性适当性筛选；WM-GT-03 通过 `get_wealth_policy_basis` 独立核验现行制度；WM-GT-06 通过 `prepare_wealth_maturity_context` 在授权客户范围内生成有界到期经营清单。WM-GT-05 的写入由现有 Enterprise MCP 审批与幂等链控制，Reference Demo 仍需单独运行 `pnpm mcp:demo:configure`。

```bash
pnpm rolepack:wealth:install
pnpm rolepack:wealth:install -- --apply --adopt-id=lgj-example
```

运行时仍以现有系统为准：

- Role 和岗位授权：Role Template / Role Asset Grants；
- Knowledge：企业、岗位和个人知识库；
- Skill：Skill Store；
- MCP：Runtime 配置与 Enterprise MCP Gateway；
- Governance：Policy Adapter、PEP、Approval 和 Evidence。

演示客户和产品数据不得直接放入本目录，必须通过 MCP Fixture 提供。

Knowledge Manifest 只是发布与验收清单，不参与运行时授权裁决；生产部署仍由知识库元数据、Role Asset Grants 和 Governance Policy 决定实际可见范围。
