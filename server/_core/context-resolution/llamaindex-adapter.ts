import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from "../../db";
import type { ContextItemV1, ContextNeedV1, ContextSourceBindingV1 } from "../../../shared/context-resolution";
import { buildContextItemV1 } from "./context-item";

export type LlamaIndexBindingSelection = {
  binding: ContextSourceBindingV1;
  knowledgeBaseIds: string[];
  knowledgeBases: KnowledgeBaseRecord[];
};

export function llamaIndexKnowledgeBaseId(resourceRef: string): string | null {
  const match = String(resourceRef || "").trim().match(/^kb:\/\/(kb_[A-Za-z0-9_-]{8,56})$/);
  return match?.[1] || null;
}

export function selectLlamaIndexKnowledgeBases(input: {
  binding: ContextSourceBindingV1;
  accessibleBases: KnowledgeBaseRecord[];
}): LlamaIndexBindingSelection {
  if (input.binding.providerType !== "llamaindex") {
    throw new Error(`Knowledge binding ${input.binding.bindingId} is not backed by LlamaIndex`);
  }
  const knowledgeBaseId = llamaIndexKnowledgeBaseId(input.binding.resourceRef);
  if (!knowledgeBaseId) throw new Error(`Knowledge binding ${input.binding.bindingId} has an invalid resource reference`);
  const selected = input.accessibleBases.filter((base) => base.publicId === knowledgeBaseId && base.status === "ready");
  if (selected.length !== 1) {
    throw new Error(`Knowledge binding ${input.binding.bindingId} is not eligible for the current principal`);
  }
  return { binding: input.binding, knowledgeBaseIds: [knowledgeBaseId], knowledgeBases: selected };
}

export type LlamaIndexRetrievedItem = {
  documentId: string;
  documentVersion: string;
  position: string;
  page?: number | null;
  score?: number;
};

export function normalizeLlamaIndexContextItem(input: {
  need: ContextNeedV1;
  binding: ContextSourceBindingV1;
  document: KnowledgeDocumentRecord;
  retrieved: LlamaIndexRetrievedItem;
  asOf: string;
  retrievedAt?: string;
}): ContextItemV1 {
  if (input.binding.providerType !== "llamaindex") {
    throw new Error("LlamaIndex normalization requires a llamaindex binding");
  }
  if (input.document.publicId !== input.retrieved.documentId) {
    throw new Error("Retrieved document does not match the governed asset record");
  }
  if (input.document.versionLabel !== input.retrieved.documentVersion) {
    throw new Error("Retrieved version does not match the governed asset version");
  }
  return buildContextItemV1({
    need: input.need,
    binding: input.binding,
    assetId: input.document.sourceAssetId || input.document.publicId,
    assetVersion: input.document.versionLabel,
    contentHash: input.document.sha256,
    asOf: input.asOf,
    provenance: {
      sourceDepartment: input.document.sourceDepartment,
      authority: input.document.authority,
      effectiveAt: input.document.effectiveAt,
    },
    citation: {
      documentId: input.document.publicId,
      page: input.retrieved.page ?? null,
      position: input.retrieved.position,
    },
    retrievedAt: input.retrievedAt,
    score: input.retrieved.score,
  });
}
