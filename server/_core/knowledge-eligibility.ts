import { createHash } from "node:crypto";
import type {
  KnowledgeBaseRecord,
  KnowledgeClassification,
  KnowledgeDocumentRecord,
} from "../db";

const CLASSIFICATION_RANK: Record<KnowledgeClassification, number> = {
  public: 0,
  internal: 1,
  sensitive: 2,
  restricted: 3,
};

// These are security semantics, not display defaults. Ambiguous governance data fails closed.
export const KNOWLEDGE_NULL_SEMANTICS = Object.freeze({
  expiresAt: "indefinite",
  effectiveAt: "createdAt",
  lifecycle: "deny",
  classification: "restricted",
  authority: "reference",
  scope: "personal",
} as const);

export type KnowledgeEligibilityResult = {
  documentIds: string[];
  fingerprint: string;
  excludedByReason: Record<string, number>;
};

function supersededDocumentIds(documents: KnowledgeDocumentRecord[]): Set<string> {
  const eligibleIds = new Set(documents.map((document) => document.publicId));
  const superseded = new Set<string>();
  for (const document of documents) {
    const previousId = String(document.supersedesDocumentId || "").trim();
    if (previousId && eligibleIds.has(previousId)) superseded.add(previousId);
  }
  return superseded;
}

function configuredRoleTemplates(name: string): Set<string> {
  return new Set(String(process.env[name] || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

function actorClearance(input: {
  actorRole: string;
  roleTemplate: string;
  ownsPersonalBase: boolean;
}): KnowledgeClassification {
  if (input.actorRole.trim().toLowerCase() === "admin" || input.ownsPersonalBase) return "restricted";
  const roleTemplate = input.roleTemplate.trim().toLowerCase();
  if (configuredRoleTemplates("EA_KNOWLEDGE_RESTRICTED_ROLE_TEMPLATES").has(roleTemplate)) return "restricted";
  if (configuredRoleTemplates("EA_KNOWLEDGE_SENSITIVE_ROLE_TEMPLATES").has(roleTemplate)) return "sensitive";
  return "internal";
}

function classificationRank(value: unknown): number {
  const normalized = String(value || "").trim().toLowerCase() as KnowledgeClassification;
  return CLASSIFICATION_RANK[normalized] ?? CLASSIFICATION_RANK.restricted;
}

function validDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildKnowledgeEligibility(input: {
  bases: KnowledgeBaseRecord[];
  documents: KnowledgeDocumentRecord[];
  userId: number;
  actorRole?: string;
  roleTemplate?: string;
  now?: Date;
}): KnowledgeEligibilityResult {
  const now = input.now || new Date();
  const baseById = new Map(input.bases.map((base) => [base.id, base]));
  const excludedByReason: Record<string, number> = {};
  const eligibleDocuments: KnowledgeDocumentRecord[] = [];
  const exclude = (reason: string) => {
    excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
  };

  for (const document of input.documents) {
    const base = baseById.get(document.knowledgeBaseId);
    if (!base || base.status !== "ready") {
      exclude("base_not_ready");
      continue;
    }
    if (base.scope === "role" && (!base.roleTemplate || base.roleTemplate !== input.roleTemplate)) {
      exclude("role_mismatch");
      continue;
    }
    if (document.status !== "ready") {
      exclude("document_not_ready");
      continue;
    }
    if (document.lifecycle !== "active") {
      exclude("lifecycle_inactive");
      continue;
    }
    const effectiveAt = validDate(document.effectiveAt || document.createdAt);
    if (!effectiveAt || effectiveAt.getTime() > now.getTime()) {
      exclude("not_effective");
      continue;
    }
    // A null expiry is explicitly indefinite. Invalid non-null timestamps fail closed.
    const expiresAt = validDate(document.expiresAt);
    if (document.expiresAt && (!expiresAt || expiresAt.getTime() <= now.getTime())) {
      exclude("expired");
      continue;
    }
    const clearance = actorClearance({
      actorRole: input.actorRole || "user",
      roleTemplate: input.roleTemplate || "",
      ownsPersonalBase: base.scope === "personal" && base.ownerUserId === input.userId,
    });
    if (Math.max(classificationRank(base.classification), classificationRank(document.classification)) > classificationRank(clearance)) {
      exclude("classification_denied");
      continue;
    }
    if (!/^doc_[A-Za-z0-9_-]{3,60}$/.test(document.publicId)) {
      exclude("invalid_document_id");
      continue;
    }
    eligibleDocuments.push(document);
  }

  // A future replacement must not hide the current version. Only a replacement
  // that passed every eligibility check can supersede its predecessor.
  const superseded = supersededDocumentIds(eligibleDocuments);
  const included = new Set<string>();
  for (const document of eligibleDocuments) {
    if (superseded.has(document.publicId)) {
      exclude("superseded");
      continue;
    }
    included.add(document.publicId);
  }

  const documentIds = Array.from(included).sort();
  const fingerprint = createHash("sha256").update(JSON.stringify({
    bases: Array.from(baseById.keys()).sort((a, b) => a - b),
    documents: documentIds,
  })).digest("hex");
  return { documentIds, fingerprint, excludedByReason };
}
