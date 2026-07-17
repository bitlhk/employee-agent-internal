import { describe, expect, it } from "vitest";
import { buildWorkspaceTreeRows, workspaceFileIconKind, workspacePreviewKind, type FileNode } from "./WorkspacePage";

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

describe("workspaceFileIconKind", () => {
  it("groups common workspace files into stable visual categories", () => {
    expect(workspaceFileIconKind({ name: "docs", path: "docs", type: "directory" })).toBe("directory");
    expect(workspaceFileIconKind({ name: "README.md", path: "README.md", type: "file" })).toBe("markdown");
    expect(workspaceFileIconKind({ name: "config.json", path: "config.json", type: "file" })).toBe("json");
    expect(workspaceFileIconKind({ name: "report.pdf", path: "report.pdf", type: "file" })).toBe("pdf");
    expect(workspaceFileIconKind({ name: "chart.png", path: "chart.png", type: "file" })).toBe("image");
    expect(workspaceFileIconKind({ name: "worker.ts", path: "worker.ts", type: "file" })).toBe("code");
    expect(workspaceFileIconKind({ name: "bundle.7z", path: "bundle.7z", type: "file" })).toBe("archive");
    expect(workspaceFileIconKind({ name: "notes.txt", path: "notes.txt", type: "file" })).toBe("file");
  });
});
