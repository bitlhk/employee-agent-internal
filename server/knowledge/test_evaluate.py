import unittest

from evaluate import _evidence_coverage, _fuse_planned_results, build_summary, markdown_report


class KnowledgeEvaluationTest(unittest.TestCase):
    def test_multi_query_fusion_reserves_evidence_from_each_planned_query(self):
        def item(parent_id: str, position: str) -> dict:
            return {
                "knowledge_base_id": "kb_testbase1",
                "chunk_id": f"{parent_id}:child",
                "parent_id": parent_id,
                "position": position,
                "score": 0.1,
            }

        fused = _fuse_planned_results([
            [item("original", "原始")],
            [item("source", "候选产品来源")],
            [item("precondition", "前置条件")],
            [item("risk", "风险等级匹配")],
            [item("channel", "产品状态与渠道")],
        ], 6)

        self.assertEqual(
            [value["parent_id"] for value in fused[:4]],
            ["source", "precondition", "risk", "channel"],
        )

    def test_evidence_coverage_reports_stage_ranks(self):
        coverage = _evidence_coverage(
            {
                "expectedDocuments": ["制度.md", "规程.md"],
                "expectedVersions": ["V2"],
                "expectedPositions": ["3.3 创建任务", "3.4 核对回执"],
            },
            [
                {"rank": 2, "documentName": "制度.md", "documentVersion": "V2", "position": "3.3 创建任务"},
                {"rank": 7, "documentName": "规程.md", "documentVersion": "V1", "position": "3.4 核对回执"},
            ],
        )

        self.assertEqual(coverage["documents"]["coverage"], 1.0)
        self.assertEqual(coverage["documents"]["ranks"]["规程.md"], 7)
        self.assertEqual(coverage["versions"]["coverage"], 1.0)
        self.assertEqual(coverage["positions"]["coverage"], 1.0)

    def test_summary_measures_document_page_and_tag_hits(self):
        dataset = {"name": "测试集"}
        case = {
            "id": "case-1",
            "query": "风险在哪里",
            "expectedDocuments": ["招股书.pdf"],
            "expectedPages": [32],
            "tags": ["long_document", "risk"],
        }
        results = [{"document_name": "招股书.pdf", "page": 32, "position": "第三节 风险因素"}]

        summary = build_summary(dataset, ["kb_testbase1"], [(case, results, 125.0)])

        self.assertEqual(summary["hitRate"], 1.0)
        self.assertEqual(summary["pageHitRate"], 1.0)
        self.assertEqual(summary["tags"]["risk"]["hitRate"], 1.0)
        self.assertIn("P32", markdown_report(summary))

    def test_all_match_mode_requires_every_expected_document(self):
        case = {
            "id": "case-2",
            "query": "审批要求",
            "expectedDocuments": ["制度.md", "目录.md"],
            "matchMode": "all",
        }
        summary = build_summary(
            {"name": "测试集"},
            ["kb_testbase1"],
            [(case, [{"document_name": "制度.md", "position": "正文"}], 50.0)],
        )
        self.assertEqual(summary["hitRate"], 0.0)
        self.assertEqual(summary["documentRecall"], 0.5)

    def test_version_and_forbidden_sources_are_part_of_the_case_result(self):
        case = {
            "id": "case-version",
            "query": "当前制度",
            "expectedDocuments": ["制度V2.md"],
            "expectedVersions": ["V2"],
            "forbiddenDocuments": ["制度V1.md"],
        }
        passing = build_summary(
            {"name": "版本测试"},
            ["kb_testbase1"],
            [(case, [{"document_name": "制度V2.md", "document_version": "V2"}], 20.0)],
        )
        failing = build_summary(
            {"name": "版本测试"},
            ["kb_testbase1"],
            [(case, [
                {"document_name": "制度V2.md", "document_version": "V2"},
                {"document_name": "制度V1.md", "document_version": "V1"},
            ], 20.0)],
        )

        self.assertEqual(passing["hitRate"], 1.0)
        self.assertEqual(passing["versionAccuracy"], 1.0)
        self.assertEqual(passing["forbiddenSourceRate"], 0.0)
        self.assertEqual(failing["hitRate"], 0.0)
        self.assertEqual(failing["forbiddenSourceRate"], 1.0)

    def test_governed_summary_records_pushdown_violations_and_operational_percentiles(self):
        case = {
            "id": "case-governed",
            "query": "当前制度",
            "expectedDocuments": ["制度V2.md"],
            "expectedPositions": ["第二章"],
        }
        summary = build_summary(
            {"name": "治理测试"},
            ["kb_testbase1"],
            [(case, [{
                "document_id": "doc_denied",
                "document_name": "制度V2.md",
                "document_version": "V2",
                "position": "第二章",
            }], 20.0, {"retrieval": "hybrid", "metrics": {"reranker": "disabled", "cache_hit": False}})],
            [
                {"latencyMs": 20.0, "empty": False, "errorCode": None, "operation": {"retrieval": "hybrid", "metrics": {"reranker": "disabled", "cache_hit": False}}},
                {"latencyMs": 40.0, "empty": True, "errorCode": "HTTP_500", "operation": {}},
            ],
            ["doc_allowed"],
        )

        self.assertEqual(summary["positionHitRate"], 1.0)
        self.assertEqual(summary["latencyP99Ms"], 40.0)
        self.assertEqual(summary["errorRate"], 0.5)
        self.assertEqual(summary["eligibility"]["violations"], ["doc_denied"])


if __name__ == "__main__":
    unittest.main()
