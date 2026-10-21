
export function decodePythonSingleQuoted(raw: string): string {
  const normalized = raw.replace(/\\'/g, "'");
  try {
    return JSON.parse(`"${normalized.replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`);
  } catch {
    return normalized.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
  }
}

export function formatStructuredToolContent(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function stripArtifactInventory(text: string): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*(?:#{1,4}\s*)?(?:已创建文件|生成文件|本轮产物|created files|artifacts)\s*[：:]?\s*$/i.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (!line.trim()) continue;
      if (/^\s*[-*]\s+(?:\[[^\]]+\]\([^)]+\)|`?[^`\s]+\.[A-Za-z0-9]{1,8}`?|(?:projects|artifacts|outputs?)\/\S+)/i.test(line)) {
        continue;
      }
      skipping = false;
    }
    if (/^\s*下载链接[^。\n]*[。.]?\s*$/.test(line)) continue;
    output.push(line);
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractA2AFinalText(text: string): string | null {
  const source = String(text || "");
  const openingTag = "<ea_final>";
  const closingTagRegex = /<\/ea_final>/gi;
  let closingTag: RegExpExecArray | null;
  let finalText: string | null = null;
  while ((closingTag = closingTagRegex.exec(source))) {
    // Tool traces can contain an unmatched instructional opening tag before the
    // actual response. Pair each close with its nearest opening tag so traces
    // cannot become part of the governed final envelope.
    const openingIndex = source.toLowerCase().lastIndexOf(openingTag, closingTag.index);
    if (openingIndex < 0) continue;
    const candidate = source.slice(openingIndex + openingTag.length, closingTag.index).trim();
    if (candidate) finalText = candidate;
  }
  return finalText;
}

export function cleanA2AText(text: string, options: { hasStructuredArtifacts?: boolean } = {}): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) return trimmed;
  const finish = (value: string) => options.hasStructuredArtifacts ? stripArtifactInventory(value) : value;

  // Dedicated A2A executors can delimit their user-facing result explicitly.
  // Prefer the last complete envelope so streamed retries cannot expose traces.
  const finalText = extractA2AFinalText(trimmed);
  if (finalText) return finish(finalText);

  // JiuwenSwarm A2A may include tool traces inside the final response artifact.
  // Prefer the last structured tool result without interpreting business fields.
  const contentRegex = /data=\{'content': '([\s\S]*?)'\}\s+error=None/g;
  let match: RegExpExecArray | null;
  let best: string | null = null;
  while ((match = contentRegex.exec(trimmed))) {
    const decoded = decodePythonSingleQuoted(match[1] || "").trim();
    if (!decoded.startsWith("{") && !decoded.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(decoded);
      best = formatStructuredToolContent(parsed);
    } catch {}
  }
  if (best) return finish(best);

  const lastToolResult = Math.max(trimmed.lastIndexOf("[tool_result"), trimmed.lastIndexOf("[tool_call]"));
  if (lastToolResult > 0) {
    const tail = trimmed.slice(lastToolResult);
    const firstHeading = tail.search(/(^|\n)#{1,3}\s+/);
    if (firstHeading >= 0) return finish(tail.slice(firstHeading).trim());
  }
  return finish(trimmed);
}
