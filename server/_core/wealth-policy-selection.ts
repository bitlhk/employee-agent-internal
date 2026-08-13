import type { KnowledgeDocumentRecord } from "../db/knowledge";

function policySeriesKey(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[（(][^）)]*(?:现行|历史|失效|废止)[^）)]*[）)]/g, "")
    .replace(/(?:版本)?\s*[Vv]?\d+(?:\.\d+)*/g, "")
    .replace(/[\s_\-—]+/g, "")
    .trim();
}

export function selectWealthPolicyDocument(input: {
  documents: KnowledgeDocumentRecord[];
  eligibleDocumentIds: Iterable<string>;
  configuredName: string;
}): { selected?: KnowledgeDocumentRecord; seriesDocuments: KnowledgeDocumentRecord[] } {
  const configuredName = String(input.configuredName).trim();
  const configuredSeries = policySeriesKey(configuredName);
  const eligibleIds = new Set(input.eligibleDocumentIds);
  const seriesDocuments = input.documents.filter((document) => policySeriesKey(document.name) === configuredSeries);
  const selected = seriesDocuments
    .filter((document) => eligibleIds.has(document.publicId) && document.name === configuredName)
    .sort((left, right) => {
      const authorityRank = { official: 4, approved: 3, reference: 2, personal: 1 } as const;
      const authority = (authorityRank[right.authority] || 0) - (authorityRank[left.authority] || 0);
      return authority || new Date(right.effectiveAt || right.createdAt).getTime() - new Date(left.effectiveAt || left.createdAt).getTime();
    })[0];
  return { selected, seriesDocuments };
}
