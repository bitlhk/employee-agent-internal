import { sql } from "drizzle-orm";
import { getDb } from "./connection";

export type KnowledgeScope = "personal" | "role" | "enterprise";
export type KnowledgeStatus = "empty" | "indexing" | "ready" | "failed";
export type KnowledgeDocumentStatus = "uploaded" | "indexing" | "ready" | "failed";

export type KnowledgeBaseRecord = {
  id: number;
  publicId: string;
  ownerUserId: number;
  ownerGroupId: number;
  scope: KnowledgeScope;
  isGlobal: boolean;
  roleTemplate: string | null;
  name: string;
  description: string;
  status: KnowledgeStatus;
  documentCount: number;
  chunkCount: number;
  lastError: string | null;
  indexedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeDocumentRecord = {
  id: number;
  publicId: string;
  knowledgeBaseId: number;
  name: string;
  extension: string;
  mimeType: string;
  storagePath: string;
  sizeBytes: number;
  sha256: string;
  status: KnowledgeDocumentStatus;
  chunkCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowsFromResult(result: unknown): any[] {
  return Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : [];
}

function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapBase(row: any): KnowledgeBaseRecord {
  return {
    id: Number(row.id),
    publicId: String(row.public_id || ""),
    ownerUserId: Number(row.owner_user_id || 0),
    ownerGroupId: Number(row.owner_group_id || 0),
    scope: String(row.scope || "personal") as KnowledgeScope,
    isGlobal: Boolean(row.is_global),
    roleTemplate: row.role_template ? String(row.role_template) : null,
    name: String(row.name || ""),
    description: String(row.description || ""),
    status: String(row.status || "empty") as KnowledgeStatus,
    documentCount: Number(row.document_count || 0),
    chunkCount: Number(row.chunk_count || 0),
    lastError: row.last_error ? String(row.last_error) : null,
    indexedAt: isoDate(row.indexed_at),
    createdAt: isoDate(row.created_at) || new Date(0).toISOString(),
    updatedAt: isoDate(row.updated_at) || new Date(0).toISOString(),
  };
}

function mapDocument(row: any): KnowledgeDocumentRecord {
  return {
    id: Number(row.id),
    publicId: String(row.public_id || ""),
    knowledgeBaseId: Number(row.knowledge_base_id || 0),
    name: String(row.name || ""),
    extension: String(row.extension || ""),
    mimeType: String(row.mime_type || "application/octet-stream"),
    storagePath: String(row.storage_path || ""),
    sizeBytes: Number(row.size_bytes || 0),
    sha256: String(row.sha256 || ""),
    status: String(row.status || "uploaded") as KnowledgeDocumentStatus,
    chunkCount: Number(row.chunk_count || 0),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: isoDate(row.created_at) || new Date(0).toISOString(),
    updatedAt: isoDate(row.updated_at) || new Date(0).toISOString(),
  };
}

const BASE_SELECT = sql.raw(`
  id, public_id, owner_user_id, owner_group_id, scope, is_global, role_template, name,
  description, status, document_count, chunk_count, last_error, indexed_at,
  created_at, updated_at
`);

const DOCUMENT_SELECT = sql.raw(`
  id, public_id, knowledge_base_id, name, extension, mime_type, storage_path,
  size_bytes, sha256, status, chunk_count, last_error, created_at, updated_at
`);

export async function listAccessibleKnowledgeBases(input: {
  userId: number;
  groupId: number;
  roleTemplate?: string | null;
}): Promise<KnowledgeBaseRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const result: any = await db.execute(sql`
    SELECT ${BASE_SELECT}
    FROM knowledge_bases
    WHERE (scope = 'personal' AND owner_user_id = ${input.userId})
       OR (
         scope = 'enterprise'
         AND (is_global = TRUE OR (owner_group_id > 0 AND owner_group_id = ${input.groupId}))
       )
       OR (
         scope = 'role'
         AND (is_global = TRUE OR (owner_group_id > 0 AND owner_group_id = ${input.groupId}))
         AND role_template IS NOT NULL
         AND role_template = ${input.roleTemplate || ""}
       )
    ORDER BY updated_at DESC, id DESC
    LIMIT 300
  `);
  return rowsFromResult(result).map(mapBase);
}

export async function listKnowledgeBasesOwnedByUser(ownerUserId: number): Promise<KnowledgeBaseRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const result: any = await db.execute(sql`
    SELECT ${BASE_SELECT}
    FROM knowledge_bases
    WHERE owner_user_id = ${ownerUserId}
    ORDER BY updated_at DESC, id DESC
    LIMIT 1000
  `);
  return rowsFromResult(result).map(mapBase);
}

export async function getAccessibleKnowledgeBase(input: {
  publicId: string;
  userId: number;
  groupId: number;
  roleTemplate?: string | null;
}): Promise<KnowledgeBaseRecord | null> {
  const db = await getDb();
  if (!db) return null;
  const result: any = await db.execute(sql`
    SELECT ${BASE_SELECT}
    FROM knowledge_bases
    WHERE public_id = ${input.publicId}
      AND (
        (scope = 'personal' AND owner_user_id = ${input.userId})
        OR (
          scope = 'enterprise'
          AND (is_global = TRUE OR (owner_group_id > 0 AND owner_group_id = ${input.groupId}))
        )
        OR (
          scope = 'role'
          AND (is_global = TRUE OR (owner_group_id > 0 AND owner_group_id = ${input.groupId}))
          AND role_template IS NOT NULL
          AND role_template = ${input.roleTemplate || ""}
        )
      )
    LIMIT 1
  `);
  const row = rowsFromResult(result)[0];
  return row ? mapBase(row) : null;
}

export async function createKnowledgeBaseRecord(input: {
  publicId: string;
  ownerUserId: number;
  ownerGroupId: number;
  scope: KnowledgeScope;
  isGlobal?: boolean;
  roleTemplate?: string | null;
  name: string;
  description?: string;
}): Promise<KnowledgeBaseRecord> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const isGlobal = input.scope === "personal" ? false : Boolean(input.isGlobal);
  const roleTemplate = input.scope === "role" ? String(input.roleTemplate || "").trim() : null;
  if (input.scope === "role" && !roleTemplate) throw new Error("role knowledge requires roleTemplate");
  await db.execute(sql`
    INSERT INTO knowledge_bases (
      public_id, owner_user_id, owner_group_id, scope, is_global, role_template, name, description
    ) VALUES (
      ${input.publicId}, ${input.ownerUserId}, ${input.ownerGroupId}, ${input.scope},
      ${isGlobal}, ${roleTemplate}, ${input.name}, ${input.description || ""}
    )
  `);
  const created = await getAccessibleKnowledgeBase({
    publicId: input.publicId,
    userId: input.ownerUserId,
    groupId: input.ownerGroupId,
    roleTemplate,
  });
  if (!created) throw new Error("knowledge base create failed");
  return created;
}

export async function updateKnowledgeBaseRecord(input: {
  id: number;
  ownerUserId: number;
  name: string;
  description: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE knowledge_bases
    SET name = ${input.name}, description = ${input.description}
    WHERE id = ${input.id} AND owner_user_id = ${input.ownerUserId}
  `);
}

export async function setKnowledgeBaseIndexState(input: {
  id: number;
  status: KnowledgeStatus;
  chunkCount?: number;
  error?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE knowledge_bases
    SET status = ${input.status},
        chunk_count = COALESCE(${input.chunkCount ?? null}, chunk_count),
        last_error = ${input.error || null},
        indexed_at = CASE WHEN ${input.status} = 'ready' THEN CURRENT_TIMESTAMP ELSE indexed_at END
    WHERE id = ${input.id}
  `);
}

export async function deleteKnowledgeBaseRecord(id: number, ownerUserId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result: any = await db.execute(sql`
    DELETE FROM knowledge_bases WHERE id = ${id} AND owner_user_id = ${ownerUserId}
  `);
  return Number((result as any)?.[0]?.affectedRows || 0) > 0;
}

export async function listKnowledgeDocuments(knowledgeBaseId: number): Promise<KnowledgeDocumentRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const result: any = await db.execute(sql`
    SELECT ${DOCUMENT_SELECT}
    FROM knowledge_documents
    WHERE knowledge_base_id = ${knowledgeBaseId}
    ORDER BY updated_at DESC, id DESC
    LIMIT 2000
  `);
  return rowsFromResult(result).map(mapDocument);
}

export async function getKnowledgeDocumentByPublicId(publicId: string): Promise<KnowledgeDocumentRecord | null> {
  const db = await getDb();
  if (!db) return null;
  const result: any = await db.execute(sql`
    SELECT ${DOCUMENT_SELECT}
    FROM knowledge_documents
    WHERE public_id = ${publicId}
    LIMIT 1
  `);
  const row = rowsFromResult(result)[0];
  return row ? mapDocument(row) : null;
}

export async function findKnowledgeDocumentByHash(knowledgeBaseId: number, sha256: string): Promise<KnowledgeDocumentRecord | null> {
  const db = await getDb();
  if (!db) return null;
  const result: any = await db.execute(sql`
    SELECT ${DOCUMENT_SELECT}
    FROM knowledge_documents
    WHERE knowledge_base_id = ${knowledgeBaseId} AND sha256 = ${sha256}
    LIMIT 1
  `);
  const row = rowsFromResult(result)[0];
  return row ? mapDocument(row) : null;
}

export async function createKnowledgeDocumentRecord(input: {
  publicId: string;
  knowledgeBaseId: number;
  name: string;
  extension: string;
  mimeType: string;
  storagePath: string;
  sizeBytes: number;
  sha256: string;
}): Promise<KnowledgeDocumentRecord> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    INSERT INTO knowledge_documents (
      public_id, knowledge_base_id, name, extension, mime_type, storage_path, size_bytes, sha256
    ) VALUES (
      ${input.publicId}, ${input.knowledgeBaseId}, ${input.name}, ${input.extension},
      ${input.mimeType}, ${input.storagePath}, ${input.sizeBytes}, ${input.sha256}
    )
  `);
  await refreshKnowledgeBaseDocumentCount(input.knowledgeBaseId);
  const created = await getKnowledgeDocumentByPublicId(input.publicId);
  if (!created) throw new Error("knowledge document create failed");
  return created;
}

export async function setKnowledgeDocumentState(input: {
  id: number;
  status: KnowledgeDocumentStatus;
  chunkCount?: number;
  error?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE knowledge_documents
    SET status = ${input.status},
        chunk_count = COALESCE(${input.chunkCount ?? null}, chunk_count),
        last_error = ${input.error || null}
    WHERE id = ${input.id}
  `);
}

export async function deleteKnowledgeDocumentRecord(id: number, knowledgeBaseId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result: any = await db.execute(sql`
    DELETE FROM knowledge_documents WHERE id = ${id} AND knowledge_base_id = ${knowledgeBaseId}
  `);
  await refreshKnowledgeBaseDocumentCount(knowledgeBaseId);
  return Number((result as any)?.[0]?.affectedRows || 0) > 0;
}

export async function deleteKnowledgeDocumentsByBase(knowledgeBaseId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`DELETE FROM knowledge_documents WHERE knowledge_base_id = ${knowledgeBaseId}`);
}

export async function refreshKnowledgeBaseDocumentCount(knowledgeBaseId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    UPDATE knowledge_bases base
    SET base.document_count = (
      SELECT COUNT(*) FROM knowledge_documents document WHERE document.knowledge_base_id = ${knowledgeBaseId}
    )
    WHERE base.id = ${knowledgeBaseId}
  `);
}
