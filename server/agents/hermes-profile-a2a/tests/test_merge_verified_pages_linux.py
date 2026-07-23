from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from merge_verified_pages_linux import (  # noqa: E402
    merge_presentations,
    validate_internal_relationships,
    verify_render_regression,
    read_package,
)


class LinuxPptxMergeTests(unittest.TestCase):
    def test_preserves_layout_media_and_chart_dependencies(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ea-pptx-merge-test-") as raw_temp:
            temporary = Path(raw_temp)
            first = temporary / "page-01.pptx"
            second = temporary / "page-02.pptx"
            output = temporary / "merged.pptx"
            environment = os.environ.copy()
            environment["NODE_PATH"] = str(
                Path.home() / ".hermes/profiles/ppt-expert/workspace/node_modules"
            )
            subprocess.run(
                [
                    "node",
                    str(ROOT / "tests/generate_merge_fixtures.js"),
                    str(first),
                    str(second),
                ],
                env=environment,
                check=True,
                timeout=60,
            )

            result = merge_presentations([first, second], output)
            self.assertEqual(result["slideCount"], 2)
            entries = read_package(output)
            validate_internal_relationships(entries)
            self.assertTrue(any(name.startswith("ppt/charts/chart") for name in entries))
            self.assertTrue(any(name.startswith("ppt/embeddings/") for name in entries))
            self.assertTrue(any(name.startswith("ppt/media/") for name in entries))
            self.assertTrue(
                any(
                    b"PAGE 2" in payload
                    for name, payload in entries.items()
                    if name.startswith("ppt/slideLayouts/") and name.endswith(".xml")
                )
            )

            rendered = verify_render_regression(
                pages=[first, second],
                merged=output,
                qa_dir=temporary / "qa",
                pdf_output=temporary / "merged.pdf",
                threshold=0.25,
                changed_pixel_threshold=0.01,
                dpi=96,
            )
            self.assertTrue(rendered["passed"], rendered)
            self.assertTrue((temporary / "merged.pdf").is_file())


if __name__ == "__main__":
    unittest.main()
