import { describe, expect, it } from "vitest";
import { validateSkillZipEnvelope, validateSkillZipMetadata } from "./skill-zip-security";

describe("skill ZIP metadata validation", () => {
  it("rejects excessive central-directory entry counts before opening the ZIP", async () => {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from("ok"));
    const buffer = zip.toBuffer();
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    buffer.writeUInt16LE(501, eocd + 8);
    buffer.writeUInt16LE(501, eocd + 10);
    expect(() => validateSkillZipEnvelope(buffer)).toThrow("数量超过 500");
  });

  it("allows a bounded platform metadata trailer after the ZIP", async () => {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from("ok"));
    const withTrailer = Buffer.concat([zip.toBuffer(), Buffer.from('{"Success":true}')]);
    expect(() => validateSkillZipEnvelope(withTrailer)).not.toThrow();
  });

  it("rejects traversal, symlink, and encrypted entries", () => {
    expect(() => validateSkillZipMetadata([{ name: "../escape", isDirectory: false, uncompressedSize: 1, compressedSize: 1 }])).toThrow("越界路径");
    expect(() => validateSkillZipMetadata([{ name: "link", isDirectory: false, uncompressedSize: 1, compressedSize: 1, symbolicLink: true }])).toThrow("符号链接");
    expect(() => validateSkillZipMetadata([{ name: "secret", isDirectory: false, uncompressedSize: 1, compressedSize: 1, encrypted: true }])).toThrow("加密条目");
  });

  it("rejects suspicious compression ratios and declared expansion", () => {
    expect(() => validateSkillZipMetadata([{ name: "huge.txt", isDirectory: false, uncompressedSize: 2 * 1024 * 1024, compressedSize: 100 }])).toThrow("压缩比异常");
    expect(() => validateSkillZipMetadata([
      { name: "a.bin", isDirectory: false, uncompressedSize: 30 * 1024 * 1024, compressedSize: 20 * 1024 * 1024 },
      { name: "b.bin", isDirectory: false, uncompressedSize: 30 * 1024 * 1024, compressedSize: 20 * 1024 * 1024 },
    ])).toThrow("解压后超过 50MB");
  });

  it("accepts a bounded normal package", () => {
    expect(() => validateSkillZipMetadata([
      { name: "skill/SKILL.md", isDirectory: false, uncompressedSize: 1000, compressedSize: 400, method: 8 },
      { name: "skill/scripts/run.py", isDirectory: false, uncompressedSize: 2000, compressedSize: 900, method: 8 },
    ])).not.toThrow();
  });
});
