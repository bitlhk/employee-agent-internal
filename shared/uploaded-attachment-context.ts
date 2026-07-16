export type UploadedAttachmentContextFile = {
  name: string;
  path: string;
  size: number;
};

const ATTACHMENT_HEADING = "[已上传附件]";
const ATTACHMENT_FOOTER = "需要读取附件内容时，请使用上面的 workspace path。";
const ATTACHMENT_LINE_RE = /^-\s+(.+)\s+\((\d+(?:\.\d+)?\s+(?:B|KB|MB)|unknown size)\)\s+->\s+workspace path:\s+(.+)$/i;

export function formatUploadedAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "unknown size";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function parseUploadedAttachmentSize(value: string): number {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB)$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = unit === "MB" ? 1024 * 1024 : unit === "KB" ? 1024 : 1;
  return Math.max(0, Math.round(amount * multiplier));
}

function isSafeWorkspaceRelativePath(value: string): boolean {
  const path = value.replace(/\\/g, "/").replace(/^workspace\//, "").trim();
  if (!path || path.startsWith("/") || path.includes("\0") || path.length > 1024) return false;
  return !path.split("/").some((segment) => segment === "..");
}

export function buildUploadedAttachmentRuntimeMessage(
  text: string,
  uploads: UploadedAttachmentContextFile[],
): string {
  if (uploads.length === 0) return text;
  const intro = text.trim() || "请查看我上传的附件。";
  const lines = uploads.map((file) => {
    const name = String(file.name || "").replace(/[\r\n]/g, " ").trim();
    const path = String(file.path || "").replace(/[\r\n]/g, "").trim();
    return `- ${name} (${formatUploadedAttachmentSize(file.size)}) -> workspace path: ${path}`;
  });
  return [intro, "", ATTACHMENT_HEADING, ...lines, "", ATTACHMENT_FOOTER].join("\n");
}

export function parseUploadedAttachmentRuntimeMessage(value: string): {
  text: string;
  attachments: UploadedAttachmentContextFile[];
} {
  const text = String(value || "");
  const headingIndex = text.lastIndexOf(`\n${ATTACHMENT_HEADING}\n`);
  if (headingIndex < 0) return { text: text.trim(), attachments: [] };

  const attachmentBlock = text.slice(headingIndex + 1);
  if (!attachmentBlock.trimEnd().endsWith(ATTACHMENT_FOOTER)) {
    return { text: text.trim(), attachments: [] };
  }

  const blockLines = attachmentBlock.split("\n");
  const footerIndex = blockLines.findIndex((line) => line.trim() === ATTACHMENT_FOOTER);
  if (blockLines[0]?.trim() !== ATTACHMENT_HEADING || footerIndex < 2) {
    return { text: text.trim(), attachments: [] };
  }

  const attachments: UploadedAttachmentContextFile[] = [];
  for (const line of blockLines.slice(1, footerIndex)) {
    if (!line.trim()) continue;
    const match = line.trim().match(ATTACHMENT_LINE_RE);
    if (!match) return { text: text.trim(), attachments: [] };
    const name = match[1].trim().slice(0, 255);
    const path = match[3].replace(/\\/g, "/").replace(/^workspace\//, "").trim();
    if (!name || !isSafeWorkspaceRelativePath(path)) {
      return { text: text.trim(), attachments: [] };
    }
    attachments.push({ name, path, size: parseUploadedAttachmentSize(match[2]) });
  }

  if (attachments.length === 0) return { text: text.trim(), attachments: [] };
  return { text: text.slice(0, headingIndex).trim(), attachments };
}
