export type KnowledgeCitationValidation = {
  text: string;
  normalizedCount: number;
  removedCount: number;
  markdownNormalizedCount: number;
};

const KNOWLEDGE_CITATION_RE = /\[\s*知识\s*(\d+)([^\]]{0,32})\]/g;
const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

export function validateKnowledgeCitations(
  value: unknown,
  allowedIndexes: Iterable<number>,
): KnowledgeCitationValidation {
  const text = String(value || "");
  const allowed = new Set(Array.from(allowedIndexes).filter((index) => Number.isInteger(index) && index > 0));
  if (!text || !allowed.size) return { text, normalizedCount: 0, removedCount: 0, markdownNormalizedCount: 0 };

  let normalizedCount = 0;
  let removedCount = 0;
  let markdownNormalizedCount = 0;
  const segments = text.split(CODE_SEGMENT_RE);
  const validated = segments.map((segment) => {
    if (segment.startsWith("`")) return segment;
    const markdownNormalized = segment.replace(/^(#{1,6})(?=[^\s#])/gm, (_match, markers: string) => {
      markdownNormalizedCount += 1;
      return `${markers} `;
    });
    return markdownNormalized.replace(KNOWLEDGE_CITATION_RE, (match, rawIndex: string) => {
      const index = Number(rawIndex);
      if (!allowed.has(index)) {
        removedCount += 1;
        return "";
      }
      const normalized = `[知识${index}]`;
      if (match !== normalized) normalizedCount += 1;
      return normalized;
    });
  }).join("");

  return { text: validated, normalizedCount, removedCount, markdownNormalizedCount };
}

export function formatKnowledgeCitations(
  value: unknown,
  labels: Readonly<Record<number, string>>,
): string {
  const text = String(value || "");
  if (!text) return text;
  return text.split(CODE_SEGMENT_RE).map((segment) => {
    if (segment.startsWith("`")) return segment;
    return segment.replace(/\[知识(\d+)\]/g, (match, rawIndex: string) => {
      const index = Number(rawIndex);
      const label = String(labels[index] || "").trim();
      return label ? `[${index} · ${label}]` : match;
    });
  }).join("");
}
