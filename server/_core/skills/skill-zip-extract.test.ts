import AdmZip from "adm-zip";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { safeExtractZip } from "./skill-zip-extract";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(name = "skill/SKILL.md", content = "hello") {
  const root = mkdtempSync(path.join(tmpdir(), "ea-zip-test-"));
  roots.push(root);
  const zip = new AdmZip();
  zip.addFile(name, Buffer.from(content));
  const file = path.join(root, "test.zip");
  writeFileSync(file, zip.toBuffer());
  return { root, file, target: path.join(root, "staging") };
}
it("extracts a normal package and refuses to overwrite an existing file", async () => {
  const f = fixture();
  await safeExtractZip(f.file, f.target);
  expect(readFileSync(path.join(f.target, "skill/SKILL.md"), "utf8")).toBe(
    "hello"
  );
  await expect(safeExtractZip(f.file, f.target)).rejects.toThrow();
});
it("rejects NTFS alternate streams on every host", async () => {
  const f = fixture("skill/file:stream");
  await expect(safeExtractZip(f.file, f.target)).rejects.toThrow(
    "非可移植路径"
  );
});
it("bounds inflation even when the declared uncompressed size is forged", async () => {
  const f = fixture("skill/SKILL.md", "a".repeat(100_000));
  const buffer = readFileSync(f.file);
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buffer.writeUInt32LE(1, central + 24);
  writeFileSync(f.file, buffer);
  await expect(safeExtractZip(f.file, f.target)).rejects.toThrow();
});
