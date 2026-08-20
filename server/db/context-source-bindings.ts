import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  contextSourceBindingPromotions,
  contextSourceBindings,
  rolePackReleases,
  type ContextSourceBinding,
  type InsertContextSourceBinding,
} from "../../drizzle/schema";
import type { ContextSourceBindingV1 } from "../../shared/context-resolution";
import { getDb } from "./connection";

async function database() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db;
}

export function contextSourceBindingContract(row: ContextSourceBinding): ContextSourceBindingV1 {
  return {
    schema: "ea.context-source-binding.v1",
    bindingId: row.bindingId,
    organizationId: row.organizationId,
    rolePackId: row.rolePackId,
    logicalAssetId: row.logicalAssetId,
    contextType: row.contextType,
    providerType: row.providerType,
    resourceRef: row.resourceRef,
    capabilities: Array.isArray(row.capabilitiesJson) ? row.capabilitiesJson.map(String).filter(Boolean) : [],
    bindingVersion: row.bindingVersion,
    stage: row.stage,
    status: row.status,
    ...(row.verifiedReleaseId ? { verifiedReleaseId: row.verifiedReleaseId } : {}),
  };
}

export async function listContextSourceBindingContracts(input: {
  organizationId: string;
  rolePackId: string;
  stage?: "production" | "shadow";
}): Promise<ContextSourceBindingV1[]> {
  const db = await database();
  const rows = await db.select().from(contextSourceBindings).where(and(
    inArray(contextSourceBindings.organizationId, [input.organizationId, "*"]),
    eq(contextSourceBindings.rolePackId, input.rolePackId),
    input.stage ? eq(contextSourceBindings.stage, input.stage) : undefined,
  ));
  return rows.map(contextSourceBindingContract);
}

export async function upsertContextSourceBinding(input: InsertContextSourceBinding): Promise<ContextSourceBinding> {
  const db = await database();
  await db.insert(contextSourceBindings).values(input).onDuplicateKeyUpdate({
    set: {
      providerType: input.providerType,
      resourceRef: input.resourceRef,
      capabilitiesJson: input.capabilitiesJson,
      bindingVersion: input.bindingVersion || "1",
      status: input.status || "active",
      verifiedReleaseId: input.verifiedReleaseId || null,
      updatedBy: input.updatedBy,
    },
  });
  const [row] = await db.select().from(contextSourceBindings).where(and(
    eq(contextSourceBindings.organizationId, input.organizationId),
    eq(contextSourceBindings.rolePackId, input.rolePackId),
    eq(contextSourceBindings.logicalAssetId, input.logicalAssetId),
    eq(contextSourceBindings.contextType, input.contextType),
    eq(contextSourceBindings.stage, input.stage || "production"),
  )).limit(1);
  if (!row) throw new Error("Context source binding persistence failed");
  return row;
}

export async function promoteShadowContextSourceBinding(input: {
  shadowBindingId: string;
  productionBindingId: string;
  verifiedReleaseId: string;
  actor: string;
}): Promise<ContextSourceBinding> {
  const [row] = await promoteShadowContextSourceBindings({
    bindings: [{
      shadowBindingId: input.shadowBindingId,
      productionBindingId: input.productionBindingId,
    }],
    verifiedReleaseId: input.verifiedReleaseId,
    actor: input.actor,
  });
  if (!row) throw new Error("Context binding promotion failed");
  return row;
}

export async function promoteShadowContextSourceBindings(input: {
  bindings: Array<{ shadowBindingId: string; productionBindingId: string }>;
  verifiedReleaseId: string;
  actor: string;
  promotionId?: string;
}): Promise<ContextSourceBinding[]> {
  if (!input.bindings.length) return [];
  const db = await database();
  return db.transaction(async tx => {
    const shadowIds = input.bindings.map((item) => item.shadowBindingId);
    const shadows = await tx.select().from(contextSourceBindings).where(and(
      inArray(contextSourceBindings.bindingId, shadowIds),
      eq(contextSourceBindings.stage, "shadow"),
      eq(contextSourceBindings.status, "active"),
    ));
    if (shadows.length !== shadowIds.length) throw new Error("Active shadow Context binding set is incomplete");
    const rolePackIds = new Set(shadows.map((row) => row.rolePackId));
    const organizationIds = new Set(shadows.map((row) => row.organizationId));
    if (rolePackIds.size !== 1 || organizationIds.size !== 1) {
      throw new Error("Atomic Context binding promotion requires one organization and Role Pack");
    }
    const rolePackId = shadows[0].rolePackId;
    const organizationId = shadows[0].organizationId;
    const [release] = await tx.select().from(rolePackReleases).where(and(
      eq(rolePackReleases.releaseId, input.verifiedReleaseId),
      eq(rolePackReleases.rolePackId, rolePackId),
      eq(rolePackReleases.status, "verified"),
    )).limit(1);
    if (!release || release.verificationLevel === "contract") {
      throw new Error("Shadow Context binding requires a Golden Task verified Role Pack release");
    }
    const promotedLogicalAssets = shadows.map((row) => row.logicalAssetId);
    const previousProduction = await tx.select().from(contextSourceBindings).where(and(
      eq(contextSourceBindings.organizationId, organizationId),
      eq(contextSourceBindings.rolePackId, rolePackId),
      eq(contextSourceBindings.stage, "production"),
      inArray(contextSourceBindings.logicalAssetId, promotedLogicalAssets),
    ));
    const productionIdByShadow = new Map(input.bindings.map((item) => [item.shadowBindingId, item.productionBindingId]));
    for (const shadow of shadows) {
      const productionBindingId = productionIdByShadow.get(shadow.bindingId);
      if (!productionBindingId) throw new Error("Production Context binding ID is missing");
      await tx.insert(contextSourceBindings).values({
        bindingId: productionBindingId,
        organizationId: shadow.organizationId,
        rolePackId: shadow.rolePackId,
        logicalAssetId: shadow.logicalAssetId,
        contextType: shadow.contextType,
        providerType: shadow.providerType,
        resourceRef: shadow.resourceRef,
        capabilitiesJson: shadow.capabilitiesJson,
        bindingVersion: shadow.bindingVersion,
        stage: "production",
        status: "active",
        verifiedReleaseId: release.releaseId,
        createdBy: input.actor,
        updatedBy: input.actor,
      }).onDuplicateKeyUpdate({
        set: {
          providerType: shadow.providerType,
          resourceRef: shadow.resourceRef,
          capabilitiesJson: shadow.capabilitiesJson,
          bindingVersion: shadow.bindingVersion,
          status: "active",
          verifiedReleaseId: release.releaseId,
          updatedBy: input.actor,
        },
      });
    }
    await tx.update(contextSourceBindings).set({
      status: "disabled",
      verifiedReleaseId: release.releaseId,
      updatedBy: input.actor,
    }).where(inArray(contextSourceBindings.bindingId, shadowIds));
    const productionIds = input.bindings.map((item) => item.productionBindingId);
    const production = await tx.select().from(contextSourceBindings).where(and(
      inArray(contextSourceBindings.bindingId, productionIds),
      eq(contextSourceBindings.stage, "production"),
      eq(contextSourceBindings.status, "active"),
    ));
    if (production.length !== productionIds.length || production.some((row) => row.verifiedReleaseId !== release.releaseId)) {
      throw new Error("Context binding promotion failed");
    }
    await tx.insert(contextSourceBindingPromotions).values({
      promotionId: input.promotionId || `ctxp_${randomUUID().replace(/-/g, "")}`,
      organizationId,
      rolePackId,
      verifiedReleaseId: release.releaseId,
      previousSnapshotJson: previousProduction.map(contextSourceBindingContract),
      promotedSnapshotJson: production.map(contextSourceBindingContract),
      status: "active",
      createdBy: input.actor,
    });
    return production;
  });
}

function snapshotKey(binding: ContextSourceBindingV1): string {
  return `${binding.logicalAssetId}|${binding.contextType}`;
}

function comparableSnapshot(bindings: ContextSourceBindingV1[]): string {
  return JSON.stringify(bindings
    .map((binding) => ({
      bindingId: binding.bindingId,
      organizationId: binding.organizationId,
      rolePackId: binding.rolePackId,
      logicalAssetId: binding.logicalAssetId,
      contextType: binding.contextType,
      providerType: binding.providerType,
      resourceRef: binding.resourceRef,
      capabilities: [...binding.capabilities].sort(),
      bindingVersion: binding.bindingVersion,
      stage: binding.stage,
      status: binding.status,
      verifiedReleaseId: binding.verifiedReleaseId || null,
    }))
    .sort((left, right) => snapshotKey(left as ContextSourceBindingV1).localeCompare(snapshotKey(right as ContextSourceBindingV1))));
}

export async function rollbackContextSourceBindingPromotion(input: {
  promotionId: string;
  actor: string;
}): Promise<ContextSourceBinding[]> {
  const db = await database();
  return db.transaction(async tx => {
    const [promotion] = await tx.select().from(contextSourceBindingPromotions).where(and(
      eq(contextSourceBindingPromotions.promotionId, input.promotionId),
      eq(contextSourceBindingPromotions.status, "active"),
    )).limit(1);
    if (!promotion) throw new Error("Active Context binding promotion not found");
    const previous = promotion.previousSnapshotJson as ContextSourceBindingV1[];
    const promoted = promotion.promotedSnapshotJson as ContextSourceBindingV1[];
    const logicalAssets = promoted.map((binding) => binding.logicalAssetId);
    const currentRows = await tx.select().from(contextSourceBindings).where(and(
      eq(contextSourceBindings.organizationId, promotion.organizationId),
      eq(contextSourceBindings.rolePackId, promotion.rolePackId),
      eq(contextSourceBindings.stage, "production"),
      inArray(contextSourceBindings.logicalAssetId, logicalAssets),
    ));
    if (comparableSnapshot(currentRows.map(contextSourceBindingContract)) !== comparableSnapshot(promoted)) {
      throw new Error("Production Context bindings changed after promotion; rollback refused");
    }
    await tx.delete(contextSourceBindings).where(and(
      eq(contextSourceBindings.organizationId, promotion.organizationId),
      eq(contextSourceBindings.rolePackId, promotion.rolePackId),
      eq(contextSourceBindings.stage, "production"),
      inArray(contextSourceBindings.logicalAssetId, logicalAssets),
    ));
    for (const binding of previous) {
      await tx.insert(contextSourceBindings).values({
        bindingId: binding.bindingId,
        organizationId: binding.organizationId,
        rolePackId: binding.rolePackId,
        logicalAssetId: binding.logicalAssetId,
        contextType: binding.contextType,
        providerType: binding.providerType,
        resourceRef: binding.resourceRef,
        capabilitiesJson: binding.capabilities,
        bindingVersion: binding.bindingVersion,
        stage: "production",
        status: binding.status,
        verifiedReleaseId: binding.verifiedReleaseId || null,
        createdBy: input.actor,
        updatedBy: input.actor,
      });
    }
    await tx.update(contextSourceBindingPromotions).set({
      status: "rolled_back",
      rolledBackBy: input.actor,
      rolledBackAt: new Date(),
    }).where(eq(contextSourceBindingPromotions.id, promotion.id));
    if (!previous.length) return [];
    return tx.select().from(contextSourceBindings).where(and(
      eq(contextSourceBindings.organizationId, promotion.organizationId),
      eq(contextSourceBindings.rolePackId, promotion.rolePackId),
      eq(contextSourceBindings.stage, "production"),
      inArray(contextSourceBindings.logicalAssetId, previous.map((binding) => binding.logicalAssetId)),
    ));
  });
}
