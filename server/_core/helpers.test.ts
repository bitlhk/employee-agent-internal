import { describe, it, expect } from "vitest";
import {
  buildRuntimeSessionKey,
  buildSessionRegistryScope,
  generateFileToken,
  isPrivateUrl,
  sanitizeFileName,
  sanitizeRelPath,
} from "./helpers";
import { createHmac } from "crypto";

// ── sanitizeRelPath ──

describe("sanitizeRelPath", () => {
  it("returns cleaned path for normal input", () => {
    expect(sanitizeRelPath("foo/bar.txt")).toBe("foo/bar.txt");
  });

  it("strips .. traversal", () => {
    expect(sanitizeRelPath("../../etc/passwd")).toBe("etc/passwd");
    expect(sanitizeRelPath("foo/../bar")).toBe("foo/bar");
    expect(sanitizeRelPath("..")).toBeNull();
  });

  it("strips leading slashes", () => {
    expect(sanitizeRelPath("/etc/passwd")).toBe("etc/passwd");
    expect(sanitizeRelPath("///foo")).toBe("foo");
  });

  it("strips null bytes", () => {
    expect(sanitizeRelPath("foo\0bar.txt")).toBe("foobar.txt");
  });

  it("returns null for empty/undefined input", () => {
    expect(sanitizeRelPath("")).toBeNull();
    expect(sanitizeRelPath(null as any)).toBeNull();
    expect(sanitizeRelPath(undefined as any)).toBeNull();
  });

  it("handles combined attack patterns", () => {
    const result = sanitizeRelPath("/../../\0../etc/passwd");
    expect(result).not.toContain("..");
    expect(result).not.toMatch(/^\//);
    expect(result).not.toContain("\0");
  });
});

// ── sanitizeFileName ──

describe("sanitizeFileName", () => {
  it("allows normal filenames", () => {
    expect(sanitizeFileName("report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("数据报告.xlsx")).toBe("数据报告.xlsx");
  });

  it("rejects path traversal", () => {
    expect(sanitizeFileName("../etc/passwd")).toBeNull();
    expect(sanitizeFileName("..")).toBeNull();
  });

  it("rejects path separators", () => {
    expect(sanitizeFileName("foo/bar")).toBeNull();
    expect(sanitizeFileName("foo\\bar")).toBeNull();
  });

  it("rejects null bytes", () => {
    expect(sanitizeFileName("foo\0.txt")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(sanitizeFileName("")).toBeNull();
    expect(sanitizeFileName("  ")).toBeNull();
  });
});

// ── isPrivateUrl ──

describe("isPrivateUrl", () => {
  it("detects localhost", () => {
    expect(isPrivateUrl("http://localhost:3000")).toBe(true);
    expect(isPrivateUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isPrivateUrl("http://[::1]:5180")).toBe(true);
    expect(isPrivateUrl("http://[::ffff:7f00:1]:5180")).toBe(true);
  });

  it("detects private IP ranges", () => {
    expect(isPrivateUrl("http://10.0.0.1")).toBe(true);
    expect(isPrivateUrl("http://172.16.0.1")).toBe(true);
    expect(isPrivateUrl("http://192.168.1.1")).toBe(true);
    expect(isPrivateUrl("http://[fc00::1]")).toBe(true);
    expect(isPrivateUrl("http://[fe80::1]")).toBe(true);
  });

  it("detects cloud metadata", () => {
    expect(isPrivateUrl("http://169.254.169.254/latest/meta-data")).toBe(true);
    expect(isPrivateUrl("http://100.100.100.200")).toBe(true);
  });

  it("allows public URLs", () => {
    expect(isPrivateUrl("https://api.example.com")).toBe(false);
    expect(isPrivateUrl("https://github.com")).toBe(false);
    expect(isPrivateUrl("https://[2606:4700:4700::1111]")).toBe(false);
    expect(isPrivateUrl("https://[::ffff:808:808]")).toBe(false);
  });

  it("handles invalid URLs gracefully", () => {
    expect(isPrivateUrl("not-a-url")).toBe(false);
    expect(isPrivateUrl("")).toBe(false);
  });
});

// ── runtime session key ──

describe("buildRuntimeSessionKey", () => {
  it("keeps the legacy main session key when channel conversation is absent", () => {
    expect(buildRuntimeSessionKey({ runtimeAgentId: "trial_lgc-abc" })).toBe("agent:trial_lgc-abc:main");
    expect(buildRuntimeSessionKey({ runtimeAgentId: "trial_lgc-abc", epoch: 2 })).toBe("agent:trial_lgc-abc:main:e2");
  });

  it("uses channel and conversation id for isolated web conversations", () => {
    expect(buildRuntimeSessionKey({
      runtimeAgentId: "trial_lgc-abc",
      channel: "web",
      conversationId: "conv_123",
    })).toBe("agent:trial_lgc-abc:web:conv_123");
  });

  it("normalizes unsafe channel and conversation id characters", () => {
    expect(buildRuntimeSessionKey({
      runtimeAgentId: "trial_lgc-abc",
      channel: "Web UI",
      conversationId: "../../conv 123",
    })).toBe("agent:trial_lgc-abc:web_ui:conv_123");
  });

  it("builds a scoped registry key only when channel conversation is explicit", () => {
    expect(buildSessionRegistryScope("web", "conv_123")).toBe("web:conv_123");
    expect(buildSessionRegistryScope("web", "")).toBe("main");
    expect(buildSessionRegistryScope("", "conv_123")).toBe("main");
  });
});

// ── generateFileToken ──

describe("generateFileToken", () => {
  const originalEnv = process.env.JWT_SECRET;
  const TEST_SECRET = "test-secret-key-for-unit-tests";

  it("generates a valid token that can be verified", () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const token = generateFileToken("lgc-abc", "agent-1", "report.pdf", 3600);

    // token 格式: payload.signature
    const parts = token.split(".");
    expect(parts).toHaveLength(2);

    // 验证签名
    const [payload, sig] = parts;
    const expectedSig = createHmac("sha256", TEST_SECRET).update(payload).digest("base64url");
    expect(sig).toBe(expectedSig);

    // 解析 payload
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    expect(parsed.adoptId).toBe("lgc-abc");
    expect(parsed.runtimeAgentId).toBe("agent-1");
    expect(parsed.path).toBe("report.pdf");
    expect(parsed.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    process.env.JWT_SECRET = originalEnv;
  });

  it("produces different tokens for different paths", () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const t1 = generateFileToken("a", "b", "file1.txt", 60);
    const t2 = generateFileToken("a", "b", "file2.txt", 60);
    expect(t1).not.toBe(t2);
    process.env.JWT_SECRET = originalEnv;
  });

  it("token with tampered signature fails verification", () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const token = generateFileToken("a", "b", "c.txt", 60);
    const tampered = token.slice(0, -5) + "XXXXX";

    const dotIdx = tampered.lastIndexOf(".");
    const payload = tampered.slice(0, dotIdx);
    const sig = tampered.slice(dotIdx + 1);
    const expectedSig = createHmac("sha256", TEST_SECRET).update(payload).digest("base64url");
    expect(sig).not.toBe(expectedSig);

    process.env.JWT_SECRET = originalEnv;
  });

  it("expired token has exp in the past", () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const token = generateFileToken("a", "b", "c.txt", -1); // negative TTL = already expired
    const payload = token.split(".")[0];
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    expect(parsed.exp).toBeLessThan(Math.floor(Date.now() / 1000));
    process.env.JWT_SECRET = originalEnv;
  });
});
