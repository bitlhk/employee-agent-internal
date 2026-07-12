import { spawnSync } from "child_process";

export type UploadValidation = { ok: true } | { ok: false; error: string };

const TEXT_EXTENSIONS = new Set(["md", "txt", "csv", "yaml", "yml", "xml", "toml", "ini", "conf", "log", "css"]);
const ZIP_EXTENSIONS = new Set(["zip", "docx", "xlsx", "pptx"]);

export function decodeBase64Strict(value: string): Buffer | null {
  const compact = value.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) return null;
  const decoded = Buffer.from(compact, "base64");
  const normalizedInput = compact.replace(/=+$/, "");
  return decoded.toString("base64").replace(/=+$/, "") === normalizedInput ? decoded : null;
}

function startsWith(buffer: Buffer, signature: number[]): boolean {
  return signature.every((value, index) => buffer[index] === value);
}

function safeMarkup(text: string, svg: boolean): UploadValidation {
  const active = /<\s*(script|iframe|object|embed|meta\b[^>]*http-equiv\s*=\s*["']?refresh)|\bon\w+\s*=|javascript\s*:/i;
  if (active.test(text)) return { ok: false, error: "active scriptable markup is not allowed" };
  if (svg && (/<\s*foreignObject\b/i.test(text) || /(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/)/i.test(text))) {
    return { ok: false, error: "SVG external content is not allowed" };
  }
  return { ok: true };
}

export function validateUploadContent(ext: string, buffer: Buffer): UploadValidation {
  if (buffer.length === 0) return { ok: false, error: "empty files are not allowed" };
  const lower = ext.toLowerCase();
  if (TEXT_EXTENSIONS.has(lower)) {
    if (buffer.includes(0)) return { ok: false, error: "text file contains binary data" };
    return { ok: true };
  }
  if (lower === "json") {
    try { JSON.parse(buffer.toString("utf8")); return { ok: true }; }
    catch { return { ok: false, error: "invalid JSON content" }; }
  }
  if (lower === "html" || lower === "htm") return safeMarkup(buffer.toString("utf8"), false);
  if (lower === "svg") {
    const text = buffer.toString("utf8");
    if (!/<svg\b/i.test(text)) return { ok: false, error: "invalid SVG content" };
    return safeMarkup(text, true);
  }
  if (lower === "png") return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? { ok: true } : { ok: false, error: "invalid PNG signature" };
  if (lower === "jpg" || lower === "jpeg") return startsWith(buffer, [0xff, 0xd8, 0xff]) ? { ok: true } : { ok: false, error: "invalid JPEG signature" };
  if (lower === "gif") return /^GIF8[79]a/.test(buffer.subarray(0, 6).toString("ascii")) ? { ok: true } : { ok: false, error: "invalid GIF signature" };
  if (lower === "webp") return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP" ? { ok: true } : { ok: false, error: "invalid WebP signature" };
  if (lower === "pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-" ? { ok: true } : { ok: false, error: "invalid PDF signature" };
  if (ZIP_EXTENSIONS.has(lower)) return startsWith(buffer, [0x50, 0x4b]) ? { ok: true } : { ok: false, error: "invalid ZIP/Office signature" };
  if (lower === "xls") return startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) ? { ok: true } : { ok: false, error: "invalid XLS signature" };
  if (lower === "gz") return startsWith(buffer, [0x1f, 0x8b]) ? { ok: true } : { ok: false, error: "invalid gzip signature" };
  if (lower === "tar") return buffer.length > 262 && buffer.subarray(257, 262).toString("ascii") === "ustar" ? { ok: true } : { ok: false, error: "invalid tar signature" };
  if (lower === "mp3") {
    const id3 = buffer.subarray(0, 3).toString("ascii") === "ID3";
    const frame = buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
    return id3 || frame ? { ok: true } : { ok: false, error: "invalid MP3 signature" };
  }
  if (lower === "wav") return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE" ? { ok: true } : { ok: false, error: "invalid WAV signature" };
  if (lower === "m4a" || lower === "mp4") return buffer.subarray(4, 8).toString("ascii") === "ftyp" ? { ok: true } : { ok: false, error: `invalid ${lower.toUpperCase()} signature` };
  if (lower === "aac") return buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0 ? { ok: true } : { ok: false, error: "invalid AAC signature" };
  if (lower === "webm") return startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3]) ? { ok: true } : { ok: false, error: "invalid WebM signature" };
  if (lower === "ogg") return buffer.subarray(0, 4).toString("ascii") === "OggS" ? { ok: true } : { ok: false, error: "invalid Ogg signature" };
  return { ok: false, error: `content validation is not configured for .${lower}` };
}

export function scanUploadForMalware(buffer: Buffer): UploadValidation {
  const mode = String(process.env.UPLOAD_ANTIVIRUS_MODE || "disabled").toLowerCase();
  if (mode === "disabled") return { ok: true };
  const command = String(process.env.CLAMAV_COMMAND || "clamscan").trim();
  const result = spawnSync(command, ["--no-summary", "-"], {
    input: buffer,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  if (result.status === 0) return { ok: true };
  if (result.status === 1) return { ok: false, error: "malware detected" };
  if (mode === "required") return { ok: false, error: "antivirus scan unavailable" };
  console.warn("[UPLOAD] antivirus scan unavailable", result.error?.message || result.stderr || `status=${result.status}`);
  return { ok: true };
}
