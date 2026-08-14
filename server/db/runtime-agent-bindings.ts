import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { runtimeAgentBindings, type RuntimeAgentBinding } from "../../drizzle/schema";
import { getDb } from "./connection";

export type RuntimeBindingProfile = "standalone" | "enterprise_canary" | "enterprise";

export type EnterpriseRuntimeBindingDraft = {
  bindingId: string;
  adoptionId: string;
  runtimeProfile: Exclude<RuntimeBindingProfile, "standalone">;
  fallbackProfile: "standalone";
  gatewayTarget: string;
  runtimeGroupId: string;
  runtimeBotId: string;
  runtimeUserId: string;
  serviceId: string;
  runtimeAgentId: string;
  workspaceKey: string;
  assetSetFingerprint: string | null;
};

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function safePart(value: string, fallback: string, maxLength: number): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return (normalized || fallback).slice(0, maxLength);
}

function configuredShardCount(): number {
  const value = Number(process.env.EA_ENTERPRISE_RUNTIME_SHARDS || 16);
  if (!Number.isInteger(value) || value < 1 || value > 256) {
    throw new Error("EA_ENTERPRISE_RUNTIME_SHARDS must be an integer between 1 and 256");
  }
  return value;
}

export function buildEnterpriseRuntimeBinding(input: {
  adoptionId: string;
  agentId: string;
  roleTemplate: string;
  runtimeProfile?: "enterprise_canary" | "enterprise";
  gatewayTarget?: string;
  assetSetFingerprint?: string | null;
}): EnterpriseRuntimeBindingDraft {
  const adoptionId = safePart(input.adoptionId, "adoption", 64);
  const sourceAgentId = safePart(input.agentId, `agent_${digest(adoptionId, 12)}`, 128);
  const role = safePart(input.roleTemplate, "general_assistant", 48);
  const shardCount = configuredShardCount();
  const shard = Number.parseInt(digest(input.adoptionId, 8), 16) % shardCount;
  const runtimeGroupId = `ea_s${shard}`;
  const runtimeBotId = role;
  const runtimeUserId = `ea_user_${digest(adoptionId, 24)}`;
  const workspaceIdentity = `${runtimeGroupId}::${runtimeBotId}::${runtimeUserId}`;
  const gatewayTarget = safePart(
    input.gatewayTarget || process.env.EA_ENTERPRISE_RUNTIME_GATEWAY_TARGET || "shanghai_enterprise",
    "shanghai_enterprise",
    64,
  );
  return {
    bindingId: `rtb_${digest(`${adoptionId}:${sourceAgentId}`, 32)}`,
    adoptionId,
    runtimeProfile: input.runtimeProfile || "enterprise_canary",
    fallbackProfile: "standalone",
    gatewayTarget,
    runtimeGroupId,
    runtimeBotId,
    runtimeUserId,
    serviceId: `${runtimeGroupId}::${runtimeBotId}`,
    runtimeAgentId: runtimeUserId,
    workspaceKey: `workspace_${md5(workspaceIdentity)}`,
    assetSetFingerprint: input.assetSetFingerprint || null,
  };
}

export async function getRuntimeAgentBinding(adoptionId: string): Promise<RuntimeAgentBinding | null> {
  const database = await getDb();
  if (!database) return null;
  const [binding] = await database
    .select()
    .from(runtimeAgentBindings)
    .where(eq(runtimeAgentBindings.adoptionId, adoptionId))
    .limit(1);
  return binding || null;
}

export async function upsertRuntimeAgentBinding(
  draft: EnterpriseRuntimeBindingDraft,
): Promise<RuntimeAgentBinding> {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  await database.insert(runtimeAgentBindings).values({
    ...draft,
    status: "pending",
  }).onDuplicateKeyUpdate({
    set: {
      runtimeProfile: draft.runtimeProfile,
      fallbackProfile: draft.fallbackProfile,
      gatewayTarget: draft.gatewayTarget,
      runtimeGroupId: draft.runtimeGroupId,
      runtimeBotId: draft.runtimeBotId,
      runtimeUserId: draft.runtimeUserId,
      serviceId: draft.serviceId,
      runtimeAgentId: draft.runtimeAgentId,
      workspaceKey: draft.workspaceKey,
      assetSetFingerprint: draft.assetSetFingerprint,
      status: "pending",
      validatedAt: null,
      lastError: null,
    },
  });
  const binding = await getRuntimeAgentBinding(draft.adoptionId);
  if (!binding) throw new Error("Runtime binding was not persisted");
  return binding;
}

export async function updateRuntimeAgentBindingStatus(input: {
  adoptionId: string;
  status: "pending" | "ready" | "degraded" | "disabled";
  lastError?: string | null;
  validatedAt?: Date | null;
}): Promise<void> {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  await database.update(runtimeAgentBindings).set({
    status: input.status,
    lastError: input.lastError ?? null,
    validatedAt: input.validatedAt ?? (input.status === "ready" ? new Date() : null),
  }).where(eq(runtimeAgentBindings.adoptionId, input.adoptionId));
}
