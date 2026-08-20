import type { KnowledgeBaseRecord } from "../../db";
import type { ContextSourceBindingV1 } from "../../../shared/context-resolution";

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

