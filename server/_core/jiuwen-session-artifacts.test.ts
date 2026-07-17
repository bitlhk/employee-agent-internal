import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { readJiuwenSessionArtifacts, writeJiuwenSessionArtifacts } from "./jiuwen-session-artifacts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("Jiuwen session artifacts", () => {
  it("persists deduplicated workspace-relative files next to session history", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-artifacts-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const historyFile = path.join(root, "history.jsonl");
    writeJiuwenSessionArtifacts({
      sessionDir: root,
      adoptId: "lgj-test",
      requestId: "request-1",
      files: [
        { name: "report.html", size: 12, path: "output/report.html" },
        { name: "report.html", size: 12, path: "output/report.html" },
        { name: "unsafe", size: 1, path: "../unsafe" },
      ],
    });

    expect(readJiuwenSessionArtifacts(historyFile).get("request-1")).toMatchObject({
      adoptId: "lgj-test",
      files: [{ name: "report.html", size: 12, path: "output/report.html" }],
    });
  });

  it("rejects internal context files from persisted artifact manifests", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-artifacts-context-"));
    roots.push(root);
    const historyFile = path.join(root, "history.jsonl");
    writeJiuwenSessionArtifacts({
      sessionDir: root,
      adoptId: "lgj-test",
      requestId: "request-context",
      files: [
        { name: "MessageSummaryOffloader.json", size: 2, path: "context/session/offload/MessageSummaryOffloader.json" },
        { name: "report.md", size: 6, path: "report.md" },
      ],
    });

    expect(readJiuwenSessionArtifacts(historyFile).get("request-context")?.files).toEqual([
      { name: "report.md", size: 6, path: "report.md" },
    ]);
  });

  it("hides internal context files from manifests written by older versions", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-artifacts-legacy-"));
    roots.push(root);
    const historyFile = path.join(root, "history.jsonl");
    writeFileSync(path.join(root, ".ea-generated-files.json"), JSON.stringify({
      version: 1,
      runs: {
        legacy: {
          adoptId: "lgj-test",
          requestId: "legacy",
          updatedAt: "2026-07-17T00:00:00.000Z",
          files: [
            { name: "MessageSummaryOffloader.json", size: 2, path: "context/session/offload/MessageSummaryOffloader.json" },
            { name: "report.md", size: 6, path: "report.md" },
          ],
        },
      },
    }), "utf8");

    expect(readJiuwenSessionArtifacts(historyFile).get("legacy")?.files).toEqual([
      { name: "report.md", size: 6, path: "report.md" },
    ]);
  });
});
