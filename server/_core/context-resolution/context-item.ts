import type { ContextItemV1, ContextNeedV1, ContextSourceBindingV1 } from "../../../shared/context-resolution";

export function buildContextItemV1(input: {
  need: ContextNeedV1;
  binding: ContextSourceBindingV1;
  assetId: string;
  assetVersion: string;
  contentHash: string;
  asOf: string;
  provenance?: ContextItemV1["provenance"];
  citation?: ContextItemV1["citation"];
  retrievedAt?: string;
  score?: number;
}): ContextItemV1 {
  return {
    schema: "ea.context-item.v1",
    needId: input.need.needId,
    logicalAssetId: input.need.logicalAssetId,
    contextType: input.need.contextType,
    bindingId: input.binding.bindingId,
    providerType: input.binding.providerType,
    assetId: input.assetId,
    assetVersion: input.assetVersion,
    contentHash: input.contentHash,
    asOf: input.asOf,
    provenance: input.provenance || {},
    ...(input.citation ? { citation: input.citation } : {}),
    retrieval: {
      retrievedAt: input.retrievedAt || new Date().toISOString(),
      ...(input.score === undefined ? {} : { score: input.score }),
    },
  };
}
