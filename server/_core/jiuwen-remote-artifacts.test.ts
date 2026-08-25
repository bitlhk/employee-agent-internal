import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { materializeRemoteJiuwenFiles } from "./jiuwen-remote-artifacts";

describe("enterprise Jiuwen remote artifacts", () => {
  it("downloads a same-gateway file into the managed EA workspace", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-remote-artifact-"));
    try {
      mkdirSync(path.join(root, "workspace"));
      const fetchImpl = vi.fn(async () => new Response("visit brief", {
        status: 200,
        headers: { "content-length": "11" },
      })) as unknown as typeof fetch;
      const files = await materializeRemoteJiuwenFiles({
        delta: {
          files: [{
            path: "/home/app/private/brief.md",
            name: "陈明访前简报.md",
            size: 11,
            download_url: "/file-api/download?token=dl-test",
          }],
        },
        wsUrl: "ws://127.0.0.1:19002/ws",
        workspaceDir: path.join(root, "workspace"),
        requestId: "request-1",
        fetchImpl,
      });

      expect(fetchImpl).toHaveBeenCalledWith(
        "http://127.0.0.1:19002/file-api/download?token=dl-test",
        expect.objectContaining({ method: "GET", redirect: "error" }),
      );
      expect(files).toEqual([{
        name: "陈明访前简报.md",
        size: 11,
        path: "enterprise-artifacts/request-1/陈明访前简报.md",
      }]);
      expect(readFileSync(path.join(root, "workspace", files[0].path), "utf8")).toBe("visit brief");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects cross-origin, non-download and traversal-shaped file events", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-remote-artifact-deny-"));
    try {
      mkdirSync(path.join(root, "workspace"));
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const files = await materializeRemoteJiuwenFiles({
        delta: {
          files: [
            { name: "cross.md", download_url: "https://attacker.example/file-api/download?token=x" },
            { name: "wrong.md", download_url: "/other/download?token=x" },
            { name: "missing-token.md", download_url: "/file-api/download" },
          ],
        },
        wsUrl: "wss://enterprise.example/ws",
        workspaceDir: path.join(root, "workspace"),
        requestId: "../unsafe",
        fetchImpl,
      });
      expect(files).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
