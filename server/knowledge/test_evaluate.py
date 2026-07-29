import unittest

from evaluate import build_summary, markdown_report


class KnowledgeEvaluationTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
