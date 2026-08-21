import { afterEach, describe, expect, it, vi } from "vitest";
import { scanSkillPackageSecurity } from "./skill-security-scanner";

const fingerprint = "a".repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EA_SKILL_SECURITY_SCANNER_TOKEN;
});

describe("skill security scanner adapter", () => {
  it("normalizes SARIF findings and keeps the subject fingerprint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "completed",
      subjectFingerprint: fingerprint,
      scanner: { version: "0.2.1" },
      sarif: {
        runs: [{
          results: [{
            ruleId: "T04",
            level: "error",
            message: { text: "危险命令执行" },
            locations: [{
              physicalLocation: {
                artifactLocation: { uri: "scripts/setup.sh" },
                region: { startLine: 12 },
              },
            }],
            partialFingerprints: { primaryLocationLineHash: "finding-1" },
            fixes: [{ description: { text: "移除不必要的命令执行" } }],
          }],
        }],
      },
    }), { status: 200 })));

    const result = await scanSkillPackageSecurity({
      file: Buffer.from("skill"),
      filename: "demo.zip",
      subjectFingerprint: fingerprint,
    });

    expect(result).toMatchObject({
      status: "completed",
      scannerVersion: "0.2.1",
      subjectFingerprint: fingerprint,
      summary: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      findings: [{
        ruleId: "T04",
        severity: "high",
        file: "scripts/setup.sh",
        startLine: 12,
        fingerprint: "finding-1",
      }],
    });
  });

  it("fails closed at the assessment level when the service fingerprint mismatches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "completed",
      subjectFingerprint: "b".repeat(64),
      scanner: { version: "0.2.1" },
      sarif: { runs: [] },
    }), { status: 200 })));

    const result = await scanSkillPackageSecurity({
      file: Buffer.from("skill"),
      filename: "demo.zip",
      subjectFingerprint: fingerprint,
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "SCANNER_UNAVAILABLE",
      subjectFingerprint: fingerprint,
    });
  });

  it("does not throw into the upload path when the scanner is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }));

    const result = await scanSkillPackageSecurity({
      file: Buffer.from("skill"),
      filename: "demo.zip",
      subjectFingerprint: fingerprint,
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SCANNER_UNAVAILABLE");
  });
});
