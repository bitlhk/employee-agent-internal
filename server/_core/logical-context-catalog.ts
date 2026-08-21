import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LOGICAL_CONTEXT_CATALOG_SCHEMA,
  type LogicalContextCatalogEntryV1,
  type LogicalContextCatalogV1,
} from "../../shared/context-governance";
import type { ContextNeedPlanV1 } from "../../shared/context-resolution";

export const LOGICAL_CONTEXT_CATALOG_PATH =
  "examples/logical-context-catalog.v1.json";

const CONTEXT_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

export function loadLogicalContextCatalog(
  root = process.cwd()
): LogicalContextCatalogV1 {
  return JSON.parse(
    readFileSync(path.join(root, LOGICAL_CONTEXT_CATALOG_PATH), "utf8")
  ) as LogicalContextCatalogV1;
}

export function validateLogicalContextCatalog(
  catalog: LogicalContextCatalogV1
): string[] {
  const errors: string[] = [];
  if (catalog.schemaVersion !== LOGICAL_CONTEXT_CATALOG_SCHEMA)
    errors.push("Logical Context Catalog schema is unsupported");
  if (!catalog.catalogVersion?.trim())
    errors.push("Logical Context Catalog has no version");
  if (!catalog.entries?.length)
    errors.push("Logical Context Catalog has no entries");

  const identifiers = new Map<string, string>();
  for (const entry of catalog.entries || []) {
    if (!CONTEXT_ID_PATTERN.test(entry.canonicalId))
      errors.push(`Invalid canonical Context ID: ${entry.canonicalId}`);
    if (!entry.displayName?.trim() || !entry.description?.trim())
      errors.push(
        `${entry.canonicalId}: displayName and description are required`
      );
    for (const identifier of [entry.canonicalId, ...(entry.aliases || [])]) {
      const owner = identifiers.get(identifier);
      if (owner)
        errors.push(
          `Logical Context identifier ${identifier} is shared by ${owner} and ${entry.canonicalId}`
        );
      else identifiers.set(identifier, entry.canonicalId);
    }
  }
  return errors;
}

export function logicalContextIndex(
  catalog: LogicalContextCatalogV1
): Map<string, LogicalContextCatalogEntryV1> {
  const index = new Map<string, LogicalContextCatalogEntryV1>();
  for (const entry of catalog.entries) {
    index.set(entry.canonicalId, entry);
    for (const alias of entry.aliases || []) index.set(alias, entry);
  }
  return index;
}

export function validateContextNeedPlansAgainstCatalog(
  plans: ContextNeedPlanV1[],
  catalog: LogicalContextCatalogV1
): string[] {
  const errors: string[] = [];
  const index = logicalContextIndex(catalog);
  for (const plan of plans) {
    for (const need of plan.needs || []) {
      const entry = index.get(need.logicalAssetId);
      if (!entry) {
        errors.push(
          `${plan.taskId}: Logical Context ${need.logicalAssetId} is not registered`
        );
      } else if (entry.contextType !== need.contextType) {
        errors.push(
          `${plan.taskId}: Logical Context ${need.logicalAssetId} must use type ${entry.contextType}`
        );
      } else if (entry.status !== "active") {
        errors.push(
          `${plan.taskId}: Logical Context ${need.logicalAssetId} is not active`
        );
      }
    }
  }
  return errors;
}
