import { describe, expect, it } from "vitest";
import { buildWorkspaceTreeRows, workspacePreviewKind, type FileNode } from "./WorkspacePage";

const files: FileNode[] = [
  { name: "readme.md", path: "docs/readme.md", type: "file" },
  { name: "config.json", path: "docs/examples/config.json", type: "file" },
  { name: "docs", path: "docs", type: "directory" },
  { name: "examples", path: "docs/examples", type: "directory" },
  { name: "bundle.zip", path: "bundle.zip", type: "file" },
];

describe("buildWorkspaceTreeRows", () => {
  it("shows only root items while folders are collapsed", () => {
    const rows = buildWorkspaceTreeRows(files, new Set(), "");

    expect(rows.map(({ path, depth }) => [path, depth])).toEqual([
      ["docs", 0],
      ["bundle.zip", 0],
    ]);
  });

  it("expands only the selected folder levels", () => {
    const rows = buildWorkspaceTreeRows(files, new Set(["docs"]), "");

    expect(rows.map(({ path, depth }) => [path, depth])).toEqual([
      ["docs", 0],
      ["docs/examples", 1],
      ["docs/readme.md", 1],
      ["bundle.zip", 0],
    ]);
  });

  it("reveals ancestors when a nested file matches the filter", () => {
    const rows = buildWorkspaceTreeRows(files, new Set(), "CONFIG");

    expect(rows.map(({ path, depth }) => [path, depth])).toEqual([
      ["docs", 0],
      ["docs/examples", 1],
      ["docs/examples/config.json", 2],
    ]);
  });

  it("shows a matching folder and all of its descendants", () => {
    const rows = buildWorkspaceTreeRows(files, new Set(), "docs");

    expect(rows.map((row) => row.path)).toEqual([
      "docs",
      "docs/examples",
      "docs/examples/config.json",
      "docs/readme.md",
    ]);
  });
});

describe("workspacePreviewKind", () => {
  it("supports browser-safe workspace previews", () => {
    expect(workspacePreviewKind("report.md")).toBe("text");
    expect(workspacePreviewKind("report.PDF")).toBe("pdf");
    expect(workspacePreviewKind("chart.png")).toBe("image");
    expect(workspacePreviewKind("report.html")).toBe("html");
  });

  it("keeps office and archive files download-only", () => {
    expect(workspacePreviewKind("report.docx")).toBe("none");
    expect(workspacePreviewKind("report.xlsx")).toBe("none");
    expect(workspacePreviewKind("bundle.zip")).toBe("none");
  });
});
