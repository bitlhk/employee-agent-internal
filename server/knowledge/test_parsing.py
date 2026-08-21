from pathlib import Path
import tempfile
import unittest
import zipfile

from parsing import _pdf_segments_from_pages, build_standard_parse_result, read_segments


class KnowledgeParsingTest(unittest.TestCase):
    def test_standard_parse_result_normalizes_structure_and_metadata_hints(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "policy-v3.3.md"
            source.write_text(
                "# 私人银行销售管理办法 V3.3\n\n第一章 总则\n本办法自2026年9月1日起生效。\n\n## 检查表\n风险等级 | 产品等级",
                "utf-8",
            )
            result = build_standard_parse_result(source, parser_version="2.1")
            payload = result.to_dict()

            self.assertEqual(payload["schema"], "ea.standard-parse-result.v1")
            self.assertEqual(payload["contentHash"], result.content_hash)
            self.assertEqual(payload["structure"]["segmentCount"], len(payload["segments"]))
            self.assertIn("3.3", [item["value"] for item in payload["hints"]["versions"]])
            self.assertIn("2026-09-01", [item["value"] for item in payload["hints"]["effectiveDates"]])
            self.assertEqual(len(payload["parseResultFingerprint"]), 64)

    def test_markdown_preserves_heading_path(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "policy.md"
            source.write_text("# 差旅制度\n\n总则。\n\n## 住宿标准\n\n一线城市每晚 800 元。", "utf-8")
            segments = read_segments(source)
            self.assertEqual(segments[0].heading_path, ("差旅制度",))
            self.assertEqual(segments[1].heading_path, ("差旅制度", "住宿标准"))
            self.assertIn("800", segments[1].text)

    def test_plain_text_recognizes_numbered_sections(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "rules.txt"
            source.write_text("第一章 总则\n适用全部员工。\n第二章 审批\n超过标准需要审批。", "utf-8")
            segments = read_segments(source)
            self.assertEqual([item.position for item in segments], ["第一章 总则", "第二章 审批"])

    def test_csv_repeats_header_for_each_table_segment(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "limits.csv"
            rows = ["城市,标准", *[f"城市{i},{i}" for i in range(45)]]
            source.write_text("\n".join(rows), "utf-8")
            segments = read_segments(source)
            self.assertEqual(len(segments), 2)
            self.assertTrue(all(item.text.startswith("城市 | 标准") for item in segments))
            self.assertTrue(all(item.content_type == "table" for item in segments))

    def test_rejects_office_archive_path_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "unsafe.docx"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("../escape.xml", "unsafe")
            with self.assertRaisesRegex(ValueError, "unsafe path"):
                read_segments(source)

    def test_pdf_removes_repeated_boundaries_and_preserves_heading_and_table_structure(self):
        pages = [
            "公司名称  内部制度\n第一章 总则\n适用所有员工。\n城市    标准    币种\n上海    800     CNY\n1-1-1",
            "公司名称  内部制度\n第二章 审批\n超出标准需要审批。\n岗位    一级    二级\n员工    经理    财务\n1-1-2",
            "公司名称  内部制度\n第三章 附则\n本制度自发布日起实施。\n项目    时限    责任人\n报销    30天    员工\n1-1-3",
        ]

        segments = _pdf_segments_from_pages(pages)

        self.assertFalse(any("公司名称" in segment.text for segment in segments))
        self.assertFalse(any("1-1-" in segment.text for segment in segments))
        self.assertTrue(any(segment.heading_path == ("第一章 总则",) for segment in segments))
        self.assertTrue(any(segment.content_type == "table" and "城市 | 标准 | 币种" in segment.text for segment in segments))


if __name__ == "__main__":
    unittest.main()
