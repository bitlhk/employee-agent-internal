from pathlib import Path
import tempfile
import unittest
import zipfile

from parsing import read_segments


class KnowledgeParsingTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
