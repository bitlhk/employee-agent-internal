import hashlib
import os
from pathlib import Path
import tempfile
import unittest

import service


class KnowledgeServiceTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.original_data_root = service.DATA_ROOT
        self.original_index_root = service.INDEX_ROOT
        self.original_embedding = {
            key: os.environ.get(key)
            for key in ("KNOWLEDGE_EMBED_API_KEY", "KNOWLEDGE_EMBED_API_BASE", "KNOWLEDGE_EMBED_MODEL")
        }
        service.DATA_ROOT = Path(self.directory.name) / "knowledge"
        service.INDEX_ROOT = service.DATA_ROOT / "indexes"
        for key in self.original_embedding:
            os.environ[key] = ""
        service._embedding_model.cache_clear()
        service._runtime_index.cache_clear()
        service._query_cache.clear()

    def tearDown(self):
        service.DATA_ROOT = self.original_data_root
        service.INDEX_ROOT = self.original_index_root
        for key, value in self.original_embedding.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        service._embedding_model.cache_clear()
        service._runtime_index.cache_clear()
        service._query_cache.clear()
        self.directory.cleanup()

    def document(self) -> service.SourceDocument:
        source = service.DATA_ROOT / "documents" / "kb_testbase1" / "doc_policy001" / "policy.md"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(
            "# 差旅制度\n\n## 住宿标准\n\n北京住宿标准为每晚 800 元，超过标准须提前审批。\n\n"
            "## 交通标准\n\n员工优先乘坐高铁二等座。",
            "utf-8",
        )
        return service.SourceDocument(
            id="doc_policy001",
            name="差旅制度.md",
            path=str(source),
            sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
            version_label="2026.1",
            authority="official",
        )

    def test_index_status_reports_missing_and_current_indexes(self):
        missing = "kb_missing001"
        existing = "kb_existing01"
        target = service.INDEX_ROOT / existing / "versions" / "version-1"
        target.mkdir(parents=True)
        (target / "manifest.json").write_text('{"index_version":"version-1"}', "utf-8")
        pointer = service.INDEX_ROOT / existing / "current.json"
        pointer.write_text('{"version":"version-1"}', "utf-8")

        result = service._index_status([missing, existing, existing])

        self.assertEqual(result["items"], [
            {"knowledge_base_id": missing, "exists": False, "index_version": ""},
            {"knowledge_base_id": existing, "exists": True, "index_version": "version-1"},
        ])

    def test_parent_child_index_returns_structured_citation(self):
        document = self.document()
        built = service._build_index(service.IndexRequest(knowledge_base_id="kb_testbase1", documents=[document]))
        result = service._search_indexes(service.MultiSearchRequest(
            knowledge_base_ids=["kb_testbase1"],
            query="北京住宿标准是多少",
            top_k=3,
            mode="forced",
        ))
        hit = result["results"][0]
        self.assertEqual(built["index_schema_version"], 2)
        self.assertEqual(hit["heading_path"], ["差旅制度", "住宿标准"])
        self.assertEqual(hit["document_version"], "2026.1")
        self.assertEqual(hit["authority"], "official")
        self.assertIn("800", hit["text"])

        locator = service._citation_locator(service.CitationRequest(
            knowledge_base_id="kb_testbase1",
            document_id=hit["document_id"],
            chunk_id=hit["chunk_id"],
            parent_id=hit["parent_id"],
        ))
        self.assertEqual(locator["heading_path"], ["差旅制度", "住宿标准"])
        self.assertIn("800", locator["matched_text"])

    def test_version_switch_keeps_two_rollback_indexes(self):
        document = self.document()
        first = service._build_index(service.IndexRequest(knowledge_base_id="kb_testbase1", documents=[document]))
        second = service._build_index(service.IndexRequest(knowledge_base_id="kb_testbase1", documents=[document]))
        versions = [item for item in (service.INDEX_ROOT / "kb_testbase1" / "versions").iterdir() if item.is_dir()]
        self.assertNotEqual(first["index_version"], second["index_version"])
        self.assertEqual(len(versions), 2)
        self.assertEqual(service._current_index_version("kb_testbase1"), second["index_version"])
        self.assertEqual(
            service._runtime_index("kb_testbase1", first["index_version"]).target.name,
            first["index_version"],
        )

    def test_governance_metadata_changes_document_cache_fingerprint(self):
        document = self.document()
        baseline = service._document_fingerprint(document)
        changed = document.model_copy(update={
            "source_department": "风险管理部",
            "effective_at": "2026-07-01T00:00:00Z",
        })
        self.assertNotEqual(baseline, service._document_fingerprint(changed))

    def test_document_id_cannot_escape_cache_root(self):
        with self.assertRaises(ValueError):
            service.SourceDocument(
                id="../outside",
                name="unsafe.md",
                path=self.document().path,
            )

    def test_reranker_fails_closed_for_restricted_candidates(self):
        node = service.TextNode(
            id_="doc_policy001:c1",
            text="敏感资料",
            metadata={"external_processing_allowed": False},
        )
        original_url = service._rerank_url
        service._rerank_url = lambda: "https://rerank.example/v1/rerank"
        os.environ["KNOWLEDGE_RERANK_API_KEY"] = "test"
        os.environ["KNOWLEDGE_RERANK_MODEL"] = "test"
        try:
            _, status = service._rerank_candidates("测试", [(node, 0.1), (node, 0.05)])
            self.assertEqual(status, "skipped_policy")
        finally:
            service._rerank_url = original_url
            os.environ.pop("KNOWLEDGE_RERANK_API_KEY", None)
            os.environ.pop("KNOWLEDGE_RERANK_MODEL", None)

    def test_navigation_only_text_does_not_hide_substantive_paragraphs(self):
        self.assertTrue(service._navigation_only_text(
            "详见本招股说明书第二节概览之重大事项提示。"
        ))
        self.assertTrue(service._navigation_only_text(
            "公司提醒投资者特别关注下列风险，并认真阅读第三节风险因素中的全部内容。"
        ))
        self.assertTrue(service._navigation_only_text(
            "投资者在评价公司股票价值时，应该特别关注下述各项风险因素。"
        ))
        self.assertFalse(service._navigation_only_text(
            "报告期毛利率分别为 5% 和 12%，价格波动可能影响盈利能力，具体参见财务章节。"
        ))

    def test_query_heading_anchor_prefers_the_requested_section(self):
        self.assertFalse(service._heading_anchor_mismatch(
            "某公司 风险因素 主要经营风险",
            {"heading_path": ["第三节 风险因素", "人才流失风险"], "position": "第 32 页"},
        ))
        self.assertTrue(service._heading_anchor_mismatch(
            "某公司 风险因素 主要经营风险",
            {"heading_path": ["第一节 释义"], "position": "一般释义"},
        ))
        self.assertFalse(service._heading_anchor_mismatch(
            "某制度 风险因素",
            {"heading_path": [], "position": "正文"},
        ))

    def test_auto_lexical_gate_rejects_a_single_generic_word_match(self):
        candidate = service.NodeWithScore(
            node=service.TextNode(
                id_="doc_policy001:c1",
                text="官网已发布产品介绍和公开研究观点。",
                metadata={
                    "document_name": "客户信息保护规范.md",
                    "heading_path": ["数据分级"],
                    "position": "正文",
                },
            ),
            score=2.1,
        )

        terms, match_count, coverage, relevant = service._auto_lexical_evidence(
            "《人工智能实施行动计划》已经发布了吗",
            [candidate],
        )

        self.assertIn("人工智能", terms)
        self.assertIn("行动计划", terms)
        self.assertEqual(match_count, 0)
        self.assertEqual(coverage, 0)
        self.assertEqual(relevant, [])

    def test_auto_lexical_gate_keeps_substantive_knowledge_matches(self):
        candidate = service.NodeWithScore(
            node=service.TextNode(
                id_="doc_policy001:c1",
                text="客户信息按照公开、内部、敏感和严格机密四个等级分级管理。",
                metadata={
                    "document_name": "客户信息保护规范.md",
                    "heading_path": ["数据分级"],
                    "position": "正文",
                },
            ),
            score=2.1,
        )

        terms, match_count, coverage, relevant = service._auto_lexical_evidence(
            "客户信息怎么分级",
            [candidate],
        )

        self.assertGreaterEqual(len(terms), 2)
        self.assertGreaterEqual(match_count, 2)
        self.assertGreater(coverage, 0.5)
        self.assertEqual(relevant, [candidate])

    def test_auto_lexical_gate_rejects_low_topic_coverage(self):
        candidates = [
            service.NodeWithScore(
                node=service.TextNode(
                    id_="doc_policy001:c1",
                    text="L1 公开信息包括官网内容和公开研究观点。L4 严格机密信息不得外发。",
                    metadata={
                        "document_name": "客户信息保护规范.md",
                        "heading_path": ["数据分级"],
                        "position": "正文",
                    },
                ),
                score=3.25,
            ),
            service.NodeWithScore(
                node=service.TextNode(
                    id_="doc_research001:c1",
                    text="研究报告应区分事实与判断，模型生成内容必须由研究人员复核。",
                    metadata={
                        "document_name": "投资研究合规规范.md",
                        "heading_path": ["研究输出"],
                        "position": "正文",
                    },
                ),
                score=2.8,
            ),
        ]

        terms, match_count, coverage, relevant = service._auto_lexical_evidence(
            "你怎么看最近的人工智能趋势 我感觉奔着L4也就是研究去了 模型开始转向持续学习",
            candidates,
            0.4,
        )

        self.assertGreaterEqual(len(terms), 8)
        self.assertEqual(match_count, 2)
        self.assertLess(coverage, 0.4)
        self.assertEqual(relevant, [])

    def test_auto_lexical_gate_keeps_high_coverage_enterprise_question(self):
        candidate = service.NodeWithScore(
            node=service.TextNode(
                id_="doc_policy001:c1",
                text="客户信息按照公开、内部、敏感和严格机密四级管理，L4 数据禁止通过个人微信外发。",
                metadata={
                    "document_name": "客户信息保护规范.md",
                    "heading_path": ["数据分级", "外发要求"],
                    "position": "正文",
                },
            ),
            score=3.1,
        )

        terms, match_count, coverage, relevant = service._auto_lexical_evidence(
            "客户L4数据可以通过个人微信外发吗",
            [candidate],
            0.4,
        )

        self.assertGreaterEqual(match_count, 2)
        self.assertGreaterEqual(coverage, 0.4)
        self.assertEqual(relevant, [candidate])

    def test_auto_retrieval_ignores_reference_only_documents(self):
        source_index = service.TextNode(
            id_="doc_sources:c1",
            text="财政部差旅费管理办法公开链接。",
            metadata={"document_name": "SOURCES.md"},
        )
        policy = service.TextNode(
            id_="doc_policy001:c1",
            text="住宿标准为每人每晚 800 元。",
            metadata={"document_name": "差旅制度.md"},
        )

        self.assertFalse(service._auto_source_candidate(source_index))
        self.assertTrue(service._auto_source_candidate(policy))


if __name__ == "__main__":
    unittest.main()
