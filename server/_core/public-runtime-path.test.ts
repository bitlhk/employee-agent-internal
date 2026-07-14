import { describe, expect, it } from "vitest";
import { sanitizePublicRuntimePaths } from "@shared/lib/public-runtime-path";

describe("sanitizePublicRuntimePaths", () => {
  it("replaces JiuwenSwarm workspace prefixes while preserving relative files", () => {
    const workspace = "/home/ubuntu/.jiuwenswarm/service_linggan/agent_jiuwen_lgj-test/agent/jiuwenclaw_workspace";
    expect(sanitizePublicRuntimePaths(`${workspace}/reports/周报.md`, workspace)).toBe("workspace/reports/周报.md");
  });

  it("sanitizes persisted runtime paths without needing the current workspace", () => {
    const value = "file_path='/root/.jiuwenswarm/agent/workspace/output/report.html'";
    expect(sanitizePublicRuntimePaths(value)).toBe("file_path='workspace/output/report.html'");
  });

  it("does not rewrite normal URLs or relative paths", () => {
    expect(sanitizePublicRuntimePaths("https://example.com/workspace/report.html workspace/report.html"))
      .toBe("https://example.com/workspace/report.html workspace/report.html");
  });

  it("redacts non-workspace runtime paths and incomplete streamed paths", () => {
    expect(sanitizePublicRuntimePaths("读取 /home/ubuntu/.jiuwenswarm/config/.env"))
      .toBe("读取 [运行时目录]");
    expect(sanitizePublicRuntimePaths("生成到 /home/ubuntu/.jiuwenswarm/service_linggan/agent_jiuwen"))
      .toBe("生成到 [运行时目录]");
  });
});
