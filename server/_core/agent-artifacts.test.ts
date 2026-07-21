import { mkdtempSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { materializeA2AArtifacts } from "./agent-artifacts";
import { parseAgentTaskArtifacts } from "@shared/agent-artifact";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("A2A artifact materialization", () => {
  it("normalizes persisted artifacts and rejects unsafe workspace paths", () => {
    const artifacts = parseAgentTaskArtifacts(JSON.stringify([
      {
        id: "preview-one",
        name: "report.png",
        mimeType: "image/png",
        size: 1024,
        role: "preview",
        path: "agent-artifacts/agt_12345678/report.png",
      },
      { id: "unsafe", name: "secret.txt", path: "../secret.txt" },
    ]));

    expect(artifacts).toEqual([expect.objectContaining({
      id: "preview-one",
      name: "report.png",
      role: "preview",
      size: 1024,
    })]);
  });

  it("stores embedded artifacts inside the Agent workspace and ignores internal files", async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "ea-agent-artifacts-"));
    roots.push(workspaceDir);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64");

    const artifacts = await materializeA2AArtifacts({
      taskId: "agt_12345678",
      workspaceDir,
      connection: { apiUrl: "https://agent.example.com/a2a", endpointConfig: {} },
      artifacts: [
        {
          id: "preview-one",
          name: "preview.png",
          mimeType: "image/png",
          role: "preview",
          bytesBase64: png.toString("base64"),
        },
        {
          id: "internal-one",
          name: "qa.json",
          mimeType: "application/json",
          role: "internal",
          bytesBase64: Buffer.from("{}").toString("base64"),
        },
      ],
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: "preview-one",
      name: "preview.png",
      role: "preview",
      path: "agent-artifacts/agt_12345678/preview.png",
    });
    expect(readFileSync(path.join(workspaceDir, artifacts[0].path))).toEqual(png);
  });
});
