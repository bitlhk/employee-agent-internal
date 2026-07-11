export const MAX_SKILL_ZIP_ENTRIES = 500;
export const MAX_SKILL_ZIP_COMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_ZIP_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
export const MAX_SKILL_ZIP_TRAILING_BYTES = 64 * 1024;
export const MAX_SKILL_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_ZIP_COMPRESSION_RATIO = 200;
export const MAX_SKILL_ZIP_PATH_DEPTH = 12;
export const MAX_SKILL_ZIP_PATH_BYTES = 512;

export type SkillZipEntryMetadata = {
  name: string;
  isDirectory: boolean;
  uncompressedSize: number;
  compressedSize: number;
  encrypted?: boolean;
  symbolicLink?: boolean;
  method?: number;
};

export function validateSkillZipEnvelope(buffer: Buffer): void {
  if (!buffer.length || buffer.length > MAX_SKILL_ZIP_COMPRESSED_BYTES) throw new Error("技能包压缩文件超过 50MB 限制");
  const minimumEocdSize = 22;
  const searchStart = Math.max(0, buffer.length - minimumEocdSize - 0xffff);
  let eocd = -1;
  for (let offset = buffer.length - minimumEocdSize; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    const zipEnd = offset + minimumEocdSize + commentLength;
    if (zipEnd <= buffer.length && buffer.length - zipEnd <= MAX_SKILL_ZIP_TRAILING_BYTES) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("技能包不是完整的 ZIP 文件");
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) throw new Error("技能包不支持分卷 ZIP");
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("技能包不支持 ZIP64");
  if (totalEntries === 0 || totalEntries > MAX_SKILL_ZIP_ENTRIES) throw new Error(`技能文件数量超过 ${MAX_SKILL_ZIP_ENTRIES} 个`);
  if (centralSize > MAX_SKILL_ZIP_CENTRAL_DIRECTORY_BYTES || centralOffset + centralSize > eocd) {
    throw new Error("技能包中央目录大小或位置非法");
  }
}

export function normalizeSkillZipEntryName(rawName: string): string {
  const name = String(rawName || "").replace(/\\/g, "/");
  if (!name || name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:\//.test(name)) {
    throw new Error(`技能包包含非法路径: ${rawName}`);
  }
  const parts = name.split("/").filter((part) => Boolean(part) && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error(`技能包包含越界路径: ${rawName}`);
  if (parts.length > MAX_SKILL_ZIP_PATH_DEPTH) throw new Error(`技能包路径层级超过 ${MAX_SKILL_ZIP_PATH_DEPTH}: ${rawName}`);
  if (Buffer.byteLength(name, "utf8") > MAX_SKILL_ZIP_PATH_BYTES) throw new Error(`技能包路径过长: ${rawName}`);
  return parts.join("/");
}

export function validateSkillZipMetadata(entries: SkillZipEntryMetadata[]): void {
  if (!entries.length) throw new Error("技能文件为空");
  if (entries.length > MAX_SKILL_ZIP_ENTRIES) throw new Error(`技能文件数量超过 ${MAX_SKILL_ZIP_ENTRIES} 个`);

  const names = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const name = normalizeSkillZipEntryName(entry.name);
    if (!name) continue;
    if (names.has(name)) throw new Error(`技能包包含重复路径: ${name}`);
    names.add(name);
    if (entry.encrypted) throw new Error(`技能包不支持加密条目: ${name}`);
    if (entry.symbolicLink) throw new Error(`技能包不允许符号链接: ${name}`);
    if (entry.method !== undefined && entry.method !== 0 && entry.method !== 8) {
      throw new Error(`技能包使用不支持的压缩算法: ${name}`);
    }
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
      || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) {
      throw new Error(`技能包条目大小非法: ${name}`);
    }
    if (entry.isDirectory) continue;
    if (entry.uncompressedSize > MAX_SKILL_ZIP_ENTRY_BYTES) throw new Error(`技能包单文件超过 50MB: ${name}`);
    total += entry.uncompressedSize;
    if (total > MAX_SKILL_ZIP_UNCOMPRESSED_BYTES) throw new Error("技能包解压后超过 50MB 限制");
    if (entry.uncompressedSize >= 1024 * 1024) {
      const ratio = entry.uncompressedSize / Math.max(entry.compressedSize, 1);
      if (ratio > MAX_SKILL_ZIP_COMPRESSION_RATIO) throw new Error(`技能包压缩比异常: ${name}`);
    }
  }
}
