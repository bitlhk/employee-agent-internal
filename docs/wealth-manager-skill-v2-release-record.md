# 财富经理主技能 V2 发布记录

> 状态：Production Released  
> 日期：2026-08-25  
> 技能：`wealth-manager-assistant@2.0.1`

## 1. 不可变基线

| 项目 | 值 |
|---|---|
| 稳定 Skill ID | `wealth-manager-assistant` |
| Skill Identity | `skill_6b1c408e1696ce6f059ba2f2764d8763` |
| 版本 | `2.0.1` |
| Artifact SHA-256 | `88f47211ef32735324688988d5557b69b5fa77c09aedf6812ee38308989fa09f` |
| 代码提交 | `5b9dce7b480cfac8538655bda1dcc9698e489823` |
| 代码发布 | `20260825T041006Z-5b9dce7b480c` |
| Role Pack Release | `linggan-bank.wealth-manager@ba0a15a271fdaf7c:wm-golden-task-v3` |
| Golden Task Run | `wm-golden-task-v3-controlled-14of14-20260825-v2.0.1` |

候选包保留九类财富工作场景，并继续执行 GRACE 的客户身份、字段投影、现行制度、确定性适当性、写操作确认与 Receipt 边界。

## 2. 提交与审批

- 维护人：李文华，`liwenhua@huawei.com`。
- 上海提交用户：`59`；独立审批用户：`1`。
- 本地提交用户：`13`；独立审批用户：`1`。
- 本地与上海审批后的 Artifact SHA-256 完全一致。
- 上海 `2.0.0` 因换行导致跨环境 SHA 不可复现而被拒绝，未进入 Runtime；由规范化的 `2.0.1` 替代。

## 3. 发布结果

### 本地验证环境

- 站点：`https://work.linggan.top`
- 代码发布：`20260825T041006Z-5b9dce7b480c`
- 财富经理实例：`2/2` 使用目标 Artifact。
- 发布操作：`b41ec05d-d185-4a4c-a0af-ea2c2381ce4b`。
- 最终回滚恢复操作：`5222c9aa-a2c7-48e1-9ca4-25a9b43a5af2`。

### 上海环境

- 站点：`https://ling-claw.demo.linggan.top`
- 代码发布：`20260825T041006Z-5b9dce7b480c`
- 发布前备份：`/root/backups/lingxia/20260825-121124`
- 财富经理实例：`20/20` 使用目标 Artifact。
- 发布操作：`123f7884-f664-4a4f-88cd-20ef42bd5e37`。
- `lgj-liwenhua` 真实流式调用返回 HTTP `200`，成功加载主技能并识别财富工作场景与合规能力。

## 4. 验证证据

- 财富经理受控场景：`14/14 PASS`，本地与上海结果及 fingerprint 一致。
- 定向单元测试：`35/35 PASS`。
- TypeScript、ESLint、生产构建：PASS。
- 本地显式回滚：`2.0.1 -> 1.4.0 -> 2.0.1`，两个实例均核对实际 Artifact SHA。
- 本地与上海健康检查：PASS。

## 5. 治理边界

- 同一技能以稳定 Skill Identity 判断升级，不创建第二个技能条目。
- 用户个人安装不能覆盖岗位默认技能；岗位默认升级由管理员通过 Role Pack 与 Golden Task 证据发布。
- 历史版本保留用于审计和显式回滚，不自动降级。
- Golden Task 的 Provided Artifact SHA 必须等于待发布 Artifact SHA；任务通过但未实际消费候选制品时不得发布。
