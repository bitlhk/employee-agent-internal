import remend from "remend";

function isCompleteTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!isCompleteTableRow(trimmed)) return false;
  const cells = trimmed.slice(1, -1).split("|");
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function looksLikePartialTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  const body = trimmed.slice(1).replace(/\|$/, "");
  if (!body.includes("-")) return false;
  return body.split("|").every((cell) => /^[\s:-]*$/.test(cell));
}

function closeOpenCodeFence(content: string): string {
  const fenceCount = (content.match(/```/g) || []).length;
  return fenceCount % 2 === 1 ? `${content}\n\`\`\`` : content;
}

function completeStreamingSyntax(content: string): string {
  return closeOpenCodeFence(remend(content, { inlineKatex: false }));
}

/**
 * Keeps an unfinished GFM table out of the parsed Markdown tree. Completed
 * rows appear atomically, avoiding repeated paragraph/table DOM replacement.
 */
export function stabilizeStreamingMarkdown(content: string): string {
  const text = String(content || "");
  if (!text) return text;
  if ((text.match(/```/g) || []).length % 2 === 1) return completeStreamingSyntax(text);

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return completeStreamingSyntax(text);

  const lastIndex = lines.length - 1;
  const lastLine = lines[lastIndex];
  if (!lastLine.trim().startsWith("|")) return completeStreamingSyntax(text);

  let blockStart = lastIndex;
  while (blockStart > 0 && lines[blockStart - 1].trim().startsWith("|")) {
    blockStart -= 1;
  }
  const tableBlock = lines.slice(blockStart);
  const separatorIndex = tableBlock.findIndex(isTableSeparator);

  if (separatorIndex < 0) {
    const firstLine = tableBlock[0] || "";
    const secondLine = tableBlock[1] || "";
    const isPendingTable =
      tableBlock.length === 1 ||
      (isCompleteTableRow(firstLine) && looksLikePartialTableSeparator(secondLine));
    if (!isPendingTable) return completeStreamingSyntax(text);
    return completeStreamingSyntax(lines.slice(0, blockStart).join("\n") + (blockStart > 0 ? "\n" : ""));
  }

  if (!isCompleteTableRow(lastLine)) {
    return completeStreamingSyntax(lines.slice(0, lastIndex).join("\n") + (lastIndex > 0 ? "\n" : ""));
  }

  return completeStreamingSyntax(text);
}

export function streamingMarkdownRenderDelay(content: string): number {
  const text = String(content || "");
  const chars = text.length;
  const hasTable = /(?:^|\n)\s*\|[^\n]+\|\s*(?:\n|$)/.test(text);
  if (hasTable) {
    if (chars > 12_000) return 140;
    if (chars > 8_000) return 120;
    return 90;
  }
  if (chars > 12_000) return 90;
  if (chars > 8_000) return 70;
  return 48;
}
