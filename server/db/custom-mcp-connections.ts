import { createHash } from "crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  customMcpConnections,
  type CustomMcpConnection,
  type InsertCustomMcpConnection,
} from "../../drizzle/schema";
import { decryptSecret, encryptSecret } from "../_core/secret-protection";
import { getDb } from "./connection";

export type CustomMcpAuthType = "none" | "bearer" | "api_key";

export type CustomMcpToolSnapshot = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type PublicCustomMcpConnection = Omit<CustomMcpConnection, "credentialEncrypted" | "toolsJson"> & {
  credentialConfigured: boolean;
  tools: CustomMcpToolSnapshot[];
};

export function customMcpEndpointDigest(endpointUrl: string): string {
  return createHash("sha256").update(endpointUrl).digest("hex");
}

export function revealCustomMcpCredential(row: CustomMcpConnection): string {
  return row.credentialEncrypted ? decryptSecret(row.credentialEncrypted) : "";
}

export function toPublicCustomMcpConnection(row: CustomMcpConnection): PublicCustomMcpConnection {
  const { credentialEncrypted, toolsJson, ...safe } = row;
  return {
    ...safe,
    credentialConfigured: Boolean(credentialEncrypted),
    tools: Array.isArray(toolsJson) ? toolsJson as CustomMcpToolSnapshot[] : [],
  };
}

export async function listCustomMcpConnections(input: {
  userId?: number;
  adoptId: string;
  enabledOnly?: boolean;
}): Promise<CustomMcpConnection[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conditions = [eq(customMcpConnections.adoptId, input.adoptId)];
  if (input.userId) conditions.push(eq(customMcpConnections.userId, input.userId));
  if (input.enabledOnly) conditions.push(eq(customMcpConnections.enabled, true));
  return await db
    .select()
    .from(customMcpConnections)
    .where(and(...conditions))
    .orderBy(asc(customMcpConnections.id));
}

export async function getCustomMcpConnection(input: {
  id: number;
  adoptId: string;
  userId?: number;
}): Promise<CustomMcpConnection | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conditions = [
    eq(customMcpConnections.id, input.id),
    eq(customMcpConnections.adoptId, input.adoptId),
  ];
  if (input.userId) conditions.push(eq(customMcpConnections.userId, input.userId));
  const rows = await db.select().from(customMcpConnections).where(and(...conditions)).limit(1);
  return rows[0] || null;
}

export async function createCustomMcpConnection(
  input: Omit<InsertCustomMcpConnection, "id" | "credentialEncrypted" | "endpointDigest"> & { credential?: string },
): Promise<CustomMcpConnection> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const { credential, ...stored } = input;
  const result = await db.insert(customMcpConnections).values({
    ...stored,
    endpointDigest: customMcpEndpointDigest(input.endpointUrl),
    credentialEncrypted: credential
      ? encryptSecret(credential, { maxStoredLength: null })
      : null,
  });
  const id = Number((result as any)[0]?.insertId || 0);
  const created = id > 0
    ? await getCustomMcpConnection({ id, adoptId: input.adoptId, userId: input.userId })
    : null;
  if (!created) throw new Error("Custom MCP connection was not created");
  return created;
}

export async function updateCustomMcpConnection(
  input: { id: number; adoptId: string; userId: number },
  patch: Partial<Omit<InsertCustomMcpConnection, "id" | "userId" | "adoptId" | "credentialEncrypted">> & {
    credential?: string | null;
  },
): Promise<CustomMcpConnection | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const values: Record<string, unknown> = { ...patch };
  delete values.credential;
  if (typeof patch.endpointUrl === "string") {
    values.endpointDigest = customMcpEndpointDigest(patch.endpointUrl);
  }
  if (patch.credential !== undefined) {
    values.credentialEncrypted = patch.credential
      ? encryptSecret(patch.credential, { maxStoredLength: null })
      : null;
  }
  await db
    .update(customMcpConnections)
    .set(values)
    .where(and(
      eq(customMcpConnections.id, input.id),
      eq(customMcpConnections.adoptId, input.adoptId),
      eq(customMcpConnections.userId, input.userId),
    ));
  return await getCustomMcpConnection(input);
}

export async function deleteCustomMcpConnection(input: {
  id: number;
  adoptId: string;
  userId: number;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db
    .delete(customMcpConnections)
    .where(and(
      eq(customMcpConnections.id, input.id),
      eq(customMcpConnections.adoptId, input.adoptId),
      eq(customMcpConnections.userId, input.userId),
    ));
  return Number((result as any)[0]?.affectedRows || 0) > 0;
}
