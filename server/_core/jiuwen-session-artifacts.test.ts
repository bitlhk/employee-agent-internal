import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readJiuwenSessionArtifacts,
  readJiuwenSessionArtifactsFromSessionDir,
  isUserVisibleJiuwenArtifactPath,
  writeJiuwenSessionArtifacts,
} from "./jiuwen-session-artifacts";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach(root => rmSync(root, { recursive: true, force: true }))
);

describe("Jiuwen session artifacts", () => {
  it("excludes reserved runtime roots without hiding exports named like configuration files", () => {
    for (const internal of [
      "SOUL.md",
      "AGENT.md",
      "HEARTBEAT.md",
      "IDENTITY.md",
      "USER.md",
      "MEMORY.md",
      ".linggan-role-scope.json",
      "coding_memory/MEMORY.md",
      "todo/session/todo.json",
      "messages/session.json",
      "agents/worker/AGENT.md",
      "Coding_Memory\\MEMORY.md",
      "soul.MD",
    ]) {
      expect(isUserVisibleJiuwenArtifactPath(internal), internal).toBe(false);
    }
    for (const exported of [
      "report.md",
      "README.md",
      "output/AGENT.md",
      "exports/SOUL.md",
      "exports/report.pdf",
      "output/table.xlsx",
      "sandbox-files/chart.png",
      "output/script.py",
      "reports/memory-summary.md",
    ]) {
      expect(isUserVisibleJiuwenArtifactPath(exported), exported).toBe(true);
    }
  });
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

    expect(
      readJiuwenSessionArtifacts(historyFile).get("request-1")
    ).toMatchObject({
      adoptId: "lgj-test",
      files: [{ name: "report.html", size: 12, path: "output/report.html" }],
    });
    expect(
      readJiuwenSessionArtifactsFromSessionDir(root).get("request-1")
    ).toMatchObject({
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
        { name: "SOUL.md", size: 4, path: "SOUL.md" },
        { name: "AGENT.md", size: 4, path: "AGENT.md" },
        { name: "HEARTBEAT.md", size: 4, path: "HEARTBEAT.md" },
        { name: "MEMORY.md", size: 1, path: "coding_memory/MEMORY.md" },
        {
          name: "MessageSummaryOffloader.json",
          size: 2,
          path: "context/session/offload/MessageSummaryOffloader.json",
        },
        { name: "report.md", size: 6, path: "report.md" },
      ],
    });

    expect(
      readJiuwenSessionArtifacts(historyFile).get("request-context")?.files
    ).toEqual([{ name: "report.md", size: 6, path: "report.md" }]);
  });

  it("rejects shell redirection files created by unquoted dependency versions", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "ea-artifacts-shell-redirection-")
    );
    roots.push(root);
    const historyFile = path.join(root, "history.jsonl");
    writeJiuwenSessionArtifacts({
      sessionDir: root,
      adoptId: "lgj-test",
      requestId: "request-shell-redirection",
      files: [
        { name: "=3.0.0", size: 0, path: "=3.0.0" },
        { name: "fund-report.txt", size: 12, path: "output/fund-report.txt" },
      ],
    });

    expect(
      readJiuwenSessionArtifacts(historyFile).get("request-shell-redirection")
        ?.files
    ).toEqual([
      { name: "fund-report.txt", size: 12, path: "output/fund-report.txt" },
    ]);
  });

  it("hides internal context files from manifests written by older versions", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-artifacts-legacy-"));
    roots.push(root);
    const historyFile = path.join(root, "history.jsonl");
    writeFileSync(
      path.join(root, ".ea-generated-files.json"),
      JSON.stringify({
        version: 1,
        runs: {
          legacy: {
            adoptId: "lgj-test",
            requestId: "legacy",
            updatedAt: "2026-07-17T00:00:00.000Z",
            files: [
              { name: "SOUL.md", size: 4, path: "SOUL.md" },
              { name: "AGENT.md", size: 4, path: "AGENT.md" },
              { name: "HEARTBEAT.md", size: 4, path: "HEARTBEAT.md" },
              { name: "MEMORY.md", size: 1, path: "coding_memory/MEMORY.md" },
              {
                name: "MessageSummaryOffloader.json",
                size: 2,
                path: "context/session/offload/MessageSummaryOffloader.json",
              },
              { name: "=0.24.0", size: 0, path: "=0.24.0" },
              { name: "report.md", size: 6, path: "report.md" },
            ],
          },
        },
      }),
      "utf8"
    );

    expect(
      readJiuwenSessionArtifacts(historyFile).get("legacy")?.files
    ).toEqual([{ name: "report.md", size: 6, path: "report.md" }]);
  });
});
