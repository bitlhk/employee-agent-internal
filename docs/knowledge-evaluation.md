# 知识检索评测

知识服务自带可重复执行的检索评测脚本，用于在解析器、分块、Embedding 或 Reranker 变更后检查召回质量和延迟。评测只调用本机知识服务，不向外部平台上传文档或查询。

## 数据集

- `examples/knowledge-evaluation-baseline.json`：制度、表格、跨文档和金融岗位场景。
- `examples/knowledge-evaluation-prospectus.json`：长篇招股书的章节与页码定位场景。运行前需将数据集中的文档名调整为知识库内的实际名称。

每条用例可声明：

- `expectedDocuments`：应召回的文档名。
- `expectedPages`：应召回的原文页码。
- `expectedPositions`：应命中的章节路径片段。
- `expectedVersions`：应命中的文档版本。
- `forbiddenDocuments`：不得进入结果的历史、失效或非权威文档。
- `evaluationLayers`：Context Golden Set 使用；包含 `retrieval` 时由本评测器执行。
- `matchMode`：`any` 表示命中任一预期项，`all` 表示全部命中。
- `tags`：岗位、文档类型或能力维度，用于分组查看退化。

## 运行

```bash
pnpm knowledge:evaluate -- \
  --dataset examples/knowledge-evaluation-baseline.json \
  --knowledge-base-id kb_xxx \
  --min-hit-rate 0.85 \
  --min-page-hit-rate 0.80 \
  --min-version-accuracy 1.0 \
  --max-forbidden-source-rate 0 \
  --max-p95-ms 1500 \
  --output /tmp/knowledge-evaluation.json \
  --markdown-output /tmp/knowledge-evaluation.md
```

跨多个知识库评测时可重复传入 `--knowledge-base-id`。任一门槛未达到时命令返回非零退出码，可直接接入发布前检查。

受治理的 Provider 评测可以把 Eligibility 文档集合下推到检索，并采集重复请求的运行指标：

```bash
pnpm knowledge:evaluate -- \
  --knowledge-base-id kb_xxx \
  --dataset examples/wealth-manager-reference-role-pack/eval/context-golden-set.v1.json \
  --eligible-document-id doc_allowed_1 \
  --eligible-document-id doc_allowed_2 \
  --strategy hybrid \
  --rerank configured \
  --warmup 1 \
  --repeat 3
```

`--strategy` 支持 `hybrid`、`bm25` 和 `vector`；`--rerank disabled` 用于评估关闭重排后的路径。这些参数只是评测控制，不授予权限，也不替代 Eligibility。

针对失败用例定位候选生成、融合和最终截断时，可启用受限诊断：

```bash
pnpm knowledge:evaluate -- \
  --knowledge-base-id kb_xxx \
  --dataset examples/wealth-manager-reference-role-pack/eval/context-golden-set.v1.json \
  --case-id WM-CG-015 \
  --case-id WM-CG-016 \
  --diagnostics \
  --eligible-document-id doc_allowed_1
```

诊断只返回 BM25、Vector、RRF、Rerank 和 Final 阶段的排名、资产标识、版本与位置，不返回候选正文；每个阶段最多 50 项，并且所有候选都已经过 Eligibility 过滤。报告中的 `stageCoverage` 显示每个阶段的预期文档、版本和位置覆盖率及其排名。

Provider Certification runner 会为每条用例生成确定性 `retrievalQueries`，并绑定 Query Plan fingerprint。多证据查询按生产链相同的覆盖合并语义评测；Query Plan 变化会使既有 Provider Certification 失效，而不会改变 Expert Confirmed Golden Set。

## 指标

- 命中率：文档、页码和章节约束同时满足的用例比例。
- 文档召回率：预期文档在结果中的平均覆盖率。
- 页码命中率：配置了页码基准的用例中，至少命中一个预期页的比例。
- 版本准确率：配置了版本基准的用例中，命中预期版本的比例。
- 禁止来源率：配置了禁止来源的用例中，实际召回禁止文档的比例；生产准入应为 `0`。
- MRR：首个预期文档的平均倒数排名。
- P50/P95/P99：检索服务延迟，不含主模型生成耗时。
- 错误率、空结果率：重复采样中的 Provider 失败和无结果比例。
- Eligibility 违规：返回结果中不属于显式 `eligible_document_ids` 的文档数量；认证门禁必须为 `0`。

评测结果用于发现回归，不应替代人工回答质量检查。正式发布前还应抽查引用是否支持原文结论、数值口径是否一致，以及回答是否越过资料证据进行推断。

财富经理 `Context Golden Set V1` 位于 `examples/wealth-manager-reference-role-pack/eval/context-golden-set.v1.json`。其中检索层用例可由本脚本执行；Context Resolution 与任务运行时断言由 `pnpm context:contracts:verify` 和岗位运行时验证链消费。当前 V1 已由业务专家确认并通过 fingerprint 冻结；任何业务语义变化都必须形成新的质量基线版本，不能静默覆盖。

完整 GRACE Provider 契约使用 `pnpm context:provider:llamaindex:certify`。单独的检索指标不等于 Provider Certification。
