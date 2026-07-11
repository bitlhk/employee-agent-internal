import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { parseSkillPackageBuffer, parseSkillSourceDirectory, parseSkillSourceFiles } from "./skill-source";

describe("parseSkillSourceFiles", () => {
  it("rejects a highly compressed ZIP before expanding entry data", async () => {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.alloc(2 * 1024 * 1024, 0x41));
    await expect(parseSkillPackageBuffer(zip.toBuffer(), "bomb.zip")).rejects.toThrow("压缩比异常");
  });

  it("uses fallback name for root-level SKILL.md instead of skill-md", () => {
    const parsed = parseSkillSourceFiles([
      { path: "SKILL.md", content: "# Smoke Skill\n\nReturns SKILL_OK." },
    ], "smoke-skill-123");

    expect(parsed.skillId).toBe("smoke-skill-123");
    expect(parsed.displayName).toBe("Smoke Skill");
  });

  it("parses generated skill files with SKILL.md", () => {
    const parsed = parseSkillSourceFiles([
      { path: "SKILL.md", content: "# 财报摘要助手\n\n帮助用户整理财报重点。" },
      { path: "scripts/run.py", content: "print('ok')\n" },
    ], "财报摘要助手");

    expect(parsed.skillId).toBe("generated-skill");
    expect(parsed.displayName).toBe("财报摘要助手");
    expect(parsed.description).toContain("帮助用户整理财报重点");
    expect(parsed.warnings).toEqual([]);
  });

  it("surfaces dangerous patterns as warnings instead of blocking", () => {
    const parsed = parseSkillSourceFiles([
      { path: "SKILL.md", content: "# 数据处理助手\n\n处理上传数据。" },
      { path: "scripts/run.sh", content: "curl https://example.com\n" },
    ], "数据处理助手");

    expect(parsed.displayName).toBe("数据处理助手");
    expect(parsed.warnings.some((warning) => warning.includes("curl 外部地址"))).toBe(true);
  });

  it("parses marketplace directory sources", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lingxia-skill-source-"));
    try {
      const source = path.join(root, "market-skill");
      mkdirSync(path.join(source, "scripts"), { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "# 市场技能\n\n来自技能市场。", "utf-8");
      writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ name: "market-alpha", version: "1.2.0" }), "utf-8");

      const parsed = parseSkillSourceDirectory(source, "fallback");
      expect(parsed.skillId).toBe("market-alpha");
      expect(parsed.displayName).toBe("market-alpha");
      expect(parsed.description).toContain("来自技能市场");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
