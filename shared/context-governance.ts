import type {
  ContextResolutionReasonCodeV1,
  ContextTypeV1,
} from "./context-resolution";

export const LOGICAL_CONTEXT_CATALOG_SCHEMA =
  "ea.logical-context-catalog.v1" as const;
export const CONTEXT_GOLDEN_SET_SCHEMA = "ea.context-golden-set.v1" as const;

export type LogicalContextCatalogEntryV1 = {
  canonicalId: string;
  contextType: ContextTypeV1;
  displayName: string;
  description: string;
  aliases: string[];
  status: "active" | "deprecated";
};

export type LogicalContextCatalogV1 = {
  schemaVersion: typeof LOGICAL_CONTEXT_CATALOG_SCHEMA;
  catalogVersion: string;
  entries: LogicalContextCatalogEntryV1[];
};

export type ContextGoldenCaseCategoryV1 =
  | "version_correctness"
  | "eligibility"
  | "context_need"
  | "retrieval_location";

export type ContextGoldenCaseV1 = {
  caseId: string;
  category: ContextGoldenCaseCategoryV1;
  taskId: string;
  query: string;
  evaluationLayers: Array<"retrieval" | "context_resolution" | "task_runtime">;
  expectedLogicalAssets: string[];
  expectedDocuments?: string[];
  expectedVersions?: string[];
  forbiddenDocuments?: string[];
  expectedPages?: number[];
  expectedPositions?: string[];
  matchMode?: "any" | "all";
  requiredContext?: string[];
  expectedStatus?: "READY" | "DEGRADED" | "BLOCKED";
  expectedReasonCodes?: ContextResolutionReasonCodeV1[];
  expectedEligibility?: "ALLOW" | "DENY";
  tags?: string[];
  review: {
    status:
      | "proposed"
      | "expert_reviewing"
      | "needs_resolution"
      | "expert_confirmed";
    reviewerId?: string;
    reviewerRole?: string;
    reviewedAt?: string;
    reviewComment?: string;
    groundTruthVersion?: string;
  };
};

export type ContextGoldenSetV1 = {
  schemaVersion: typeof CONTEXT_GOLDEN_SET_SCHEMA;
  setVersion: string;
  name: string;
  rolePackId: string;
  roleTemplate: string;
  cases: ContextGoldenCaseV1[];
};
