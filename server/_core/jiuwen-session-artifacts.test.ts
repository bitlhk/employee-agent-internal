import { mkdirSync, mkdtempSync, rmSync } from "fs";
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
});
