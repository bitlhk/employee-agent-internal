import AdmZip from "adm-zip";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  MAX_SKILL_ZIP_COMPRESSED_BYTES,
  MAX_SKILL_ZIP_UNCOMPRESSED_BYTES,
  normalizeSkillZipEntryName,
  validateSkillZipEnvelope,
  validateSkillZipMetadata,
} from "./skill-zip-security";

/** Extract only validated regular files into the installer's private staging directory. */
export async function safeExtractZip(
  zipPath: string,
  destPath: string
): Promise<void> {
  if ((await stat(zipPath)).size > MAX_SKILL_ZIP_COMPRESSED_BYTES)
    throw new Error("技能包压缩文件超过 50MB 限制");
  const buffer = await readFile(zipPath);
  validateSkillZipEnvelope(buffer);
  const entries = new AdmZip(buffer).getEntries() as Array<{
    rawEntryName: Buffer;
    isDirectory: boolean;
    attr: number;
    header: {
      size: number;
      compressedSize: number;
      flags: number;
      method: number;
    };
    getCompressedData(): Buffer;
    getData(): Buffer;
  }>;
  validateSkillZipMetadata(
    entries.map(entry => ({
      name: entry.rawEntryName.toString("utf8"),
      isDirectory: entry.isDirectory,
      uncompressedSize: entry.header.size,
      compressedSize: entry.header.compressedSize,
      encrypted: Boolean(entry.header.flags & 1),
      symbolicLink: ((entry.attr >>> 16) & 0xf000) === 0xa000,
      method: entry.header.method,
    }))
  );
  let total = 0;
  for (const entry of entries) {
    const name = normalizeSkillZipEntryName(
      entry.rawEntryName.toString("utf8")
    );
    // NTFS alternate streams and DOS devices cannot be portable package files.
    if (
      name
        .split("/")
        .some(
          part =>
            part.includes(":") ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
            /[. ]$/.test(part)
        )
    )
      throw new Error("技能包包含非可移植路径");
    const target = path.resolve(destPath, name);
    const relative = path.relative(path.resolve(destPath), target);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("技能包包含越界路径");
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    const compressed = entry.getCompressedData();
    const content =
      entry.header.method === 8
        ? inflateRawSync(compressed, {
            maxOutputLength: Math.max(
              1,
              Math.min(
                entry.header.size,
                MAX_SKILL_ZIP_UNCOMPRESSED_BYTES - total
              )
            ),
          })
        : compressed;
    total += content.length;
    if (
      content.length !== entry.header.size ||
      total > MAX_SKILL_ZIP_UNCOMPRESSED_BYTES
    )
      throw new Error("技能包实际解压大小不匹配");
    // The bounded inflate above prevents a forged size from allocating without a limit;
    // adm-zip then checks the archive's CRC before any bytes are written.
    if (!entry.getData().equals(content)) throw new Error("技能包内容校验失败");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "wx" });
  }
}
