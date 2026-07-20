import { and, eq } from "drizzle-orm";
import { agentMcpPreferences, type AgentMcpPreference } from "../../drizzle/schema";
import {
  resolveAgentMcpSelection,
  type AgentMcpSelection,
} from "../_core/agent-mcp-selection";
import type { EffectiveRoleAssets } from "../_core/role-asset-grants";
import { getDb } from "./connection";

export async function listAgentMcpPreferences(adoptId: string): Promise<AgentMcpPreference[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    return await db
      .select()
      .from(agentMcpPreferences)
      .where(eq(agentMcpPreferences.adoptId, adoptId));
  } catch (error) {
    console.error("[AGENT-MCP] preference table unavailable", {
      adoptId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function getAgentMcpPreference(
  adoptId: string,
  serverId: string,
): Promise<AgentMcpPreference | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select()
    .from(agentMcpPreferences)
    .where(and(
      eq(agentMcpPreferences.adoptId, adoptId),
      eq(agentMcpPreferences.serverId, serverId),
    ))
    .limit(1);
  return rows[0] || null;
}

export async function setAgentMcpPreference(input: {
  adoptId: string;
  serverId: string;
  enabled: boolean;
  updatedBy?: number | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .insert(agentMcpPreferences)
    .values({
      adoptId: input.adoptId,
      serverId: input.serverId,
      enabled: input.enabled,
      updatedBy: input.updatedBy || null,
    })
    .onDuplicateKeyUpdate({
      set: {
        enabled: input.enabled,
        updatedBy: input.updatedBy || null,
      },
    });
}

export async function deleteAgentMcpPreference(adoptId: string, serverId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .delete(agentMcpPreferences)
    .where(and(
      eq(agentMcpPreferences.adoptId, adoptId),
      eq(agentMcpPreferences.serverId, serverId),
    ));
}

export async function resolvePersistedAgentMcpSelection(
  adoptId: string,
  effectiveAssets: EffectiveRoleAssets,
): Promise<AgentMcpSelection> {
  const preferences = await listAgentMcpPreferences(adoptId);
  return resolveAgentMcpSelection(effectiveAssets, preferences);
}
