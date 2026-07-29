# 知识检索评测

知识服务自带可重复执行的检索评测脚本，用于在解析器、分块、Embedding 或 Reranker 变更后检查召回质量和延迟。评测只调用本机知识服务，不向外部平台上传文档或查询。

## 数据集

- `examples/knowledge-evaluation-baseline.json`：制度、表格、跨文档和金融岗位场景。
- `examples/knowledge-evaluation-prospectus.json`：长篇招股书的章节与页码定位场景。运行前需将数据集中的文档名调整为知识库内的实际名称。

每条用例可声明：

- `expectedDocuments`：应召回的文档名。
- `expectedPages`：应召回的原文页码。
- `expectedPositions`：应命中的章节路径片段。
- `matchMode`：`any` 表示命中任一预期项，`all` 表示全部命中。
- `tags`：岗位、文档类型或能力维度，用于分组查看退化。

## 运行

```bash
pnpm knowledge:evaluate -- \
  --dataset examples/knowledge-evaluation-baseline.json \
  --knowledge-base-id kb_xxx \
  --min-hit-rate 0.85 \
  --min-page-hit-rate 0.80 \
  --max-p95-ms 1500 \
  --output /tmp/knowledge-evaluation.json \
  --markdown-output /tmp/knowledge-evaluation.md
```

跨多个知识库评测时可重复传入 `--knowledge-base-id`。任一门槛未达到时命令返回非零退出码，可直接接入发布前检查。

## 指标

- 命中率：文档、页码和章节约束同时满足的用例比例。
- 文档召回率：预期文档在结果中的平均覆盖率。
- 页码命中率：配置了页码基准的用例中，至少命中一个预期页的比例。
- MRR：首个预期文档的平均倒数排名。
- P50/P95：检索服务延迟，不含主模型生成耗时。

评测结果用于发现回归，不应替代人工回答质量检查。正式发布前还应抽查引用是否支持原文结论、数值口径是否一致，以及回答是否越过资料证据进行推断。
