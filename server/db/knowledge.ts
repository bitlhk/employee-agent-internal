import { sql } from "drizzle-orm";
import { getDb } from "./connection";

export type KnowledgeScope = "personal" | "role" | "enterprise";
export type KnowledgeStatus = "empty" | "indexing" | "ready" | "failed";
export type KnowledgeDocumentStatus = "uploaded" | "indexing" | "ready" | "failed";
export type KnowledgeClassification = "public" | "internal" | "sensitive" | "restricted";
export type KnowledgeDocumentLifecycle = "draft" | "active" | "expired" | "archived";
export type KnowledgeAuthority = "official" | "approved" | "reference" | "personal";
export type KnowledgeIndexJobStatus = "queued" | "running" | "succeeded" | "failed";

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
  classification: KnowledgeClassification;
  externalProcessingAllowed: boolean;
  status: KnowledgeStatus;
  documentCount: number;
  chunkCount: number;
  lastError: string | null;
  indexVersion: string | null;
  indexSchemaVersion: number;
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
  sourceAssetId?: string | null;
  documentSeriesId?: string | null;
  supersedesDocumentId?: string | null;
  versionLabel: string;
  lifecycle: KnowledgeDocumentLifecycle;
  sourceDepartment: string;
  classification: KnowledgeClassification;
  authority: KnowledgeAuthority;
  externalProcessingAllowed: boolean;
  effectiveAt: string | null;
  expiresAt: string | null;
  status: KnowledgeDocumentStatus;
  chunkCount: number;
  lastError: string | null;
  parserVersion: string | null;
  indexVersion: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeIndexJobRecord = {
  id: number;
  knowledgeBaseId: number;
  reason: string;
  status: KnowledgeIndexJobStatus;
  attempts: number;
  lastError: string | null;
  lockedAt: string | null;
  finishedAt: string | null;
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
    classification: String(row.classification || "restricted") as KnowledgeClassification,
    externalProcessingAllowed: Boolean(row.external_processing_allowed),
    status: String(row.status || "empty") as KnowledgeStatus,
    documentCount: Number(row.document_count || 0),
    chunkCount: Number(row.chunk_count || 0),
    lastError: row.last_error ? String(row.last_error) : null,
    indexVersion: row.index_version ? String(row.index_version) : null,
    indexSchemaVersion: Number(row.index_schema_version || 1),
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
    sourceAssetId: row.source_asset_id ? String(row.source_asset_id) : null,
    documentSeriesId: row.document_series_id ? String(row.document_series_id) : null,
    supersedesDocumentId: row.supersedes_document_id ? String(row.supersedes_document_id) : null,
    versionLabel: String(row.version_label || "1.0"),
    lifecycle: String(row.lifecycle || "draft") as KnowledgeDocumentLifecycle,
    sourceDepartment: String(row.source_department || ""),
    classification: String(row.classification || "restricted") as KnowledgeClassification,
    authority: String(row.authority || "reference") as KnowledgeAuthority,
    externalProcessingAllowed: Boolean(row.external_processing_allowed),
    effectiveAt: isoDate(row.effective_at),
    expiresAt: isoDate(row.expires_at),
    status: String(row.status || "uploaded") as KnowledgeDocumentStatus,
    chunkCount: Number(row.chunk_count || 0),
    lastError: row.last_error ? String(row.last_error) : null,
    parserVersion: row.parser_version ? String(row.parser_version) : null,
    indexVersion: row.index_version ? String(row.index_version) : null,
    createdAt: isoDate(row.created_at) || new Date(0).toISOString(),
    updatedAt: isoDate(row.updated_at) || new Date(0).toISOString(),
  };
}

const BASE_SELECT = sql.raw(`
  id, public_id, owner_user_id, owner_group_id, scope, is_global, role_template, name,
  description, classification, external_processing_allowed, status, document_count, chunk_count,
  last_error, index_version, index_schema_version, indexed_at,
  created_at, updated_at
`);

const DOCUMENT_SELECT = sql.raw(`
  id, public_id, knowledge_base_id, name, extension, mime_type, storage_path,
  size_bytes, sha256, source_asset_id, document_series_id, supersedes_document_id,
  version_label, lifecycle, source_department, classification, authority,
  external_processing_allowed, effective_at, expires_at, status, chunk_count, last_error,
  parser_version, index_version, created_at, updated_at
`);

export async function listAccessibleKnowledgeBases(input: {
  userId: number;
  groupId: number;
  roleTemplate?: string | null;
}): Promise<KnowledgeBaseRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const result = await db.execute(sql`
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

export async function listGlobalRoleKnowledgeBases(roleTemplate: string): Promise<KnowledgeBaseRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const normalizedRole = String(roleTemplate || "").trim();
  if (!normalizedRole) return [];
  const result: any = await db.execute(sql`
    SELECT ${BASE_SELECT}
    FROM knowledge_bases
    WHERE scope = 'role'
      AND is_global = TRUE
      AND role_template = ${normalizedRole}
    ORDER BY id ASC
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

export async function getKnowledgeBaseById(id: number): Promise<KnowledgeBaseRecord | null> {
  const db = await getDb();
  if (!db) return null;
  const result: any = await db.execute(sql`
    SELECT ${BASE_SELECT}
    FROM knowledge_bases
    WHERE id = ${id}
    LIMIT 1
  `);
  const row = rowsFromResult(result)[0];
  return row ? mapBase(row) : null;
}

export async function listKnowledgeBasesForIndexRecovery(limit = 1000): Promise<KnowledgeBaseRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const result = await db.execute(sql`
    SELECT ${BASE_SELECT}
    FROM knowledge_bases
    WHERE EXISTS (
      SELECT 1
      FROM knowledge_documents
      WHERE knowledge_documents.knowledge_base_id = knowledge_bases.id
    )
    ORDER BY id ASC
    LIMIT ${Math.max(1, Math.min(limit, 5000))}
  `);
  return rowsFromResult(result).map(mapBase);
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
  classification?: KnowledgeClassification;
  externalProcessingAllowed?: boolean;
}): Promise<KnowledgeBaseRecord> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const isGlobal = input.scope === "personal" ? false : Boolean(input.isGlobal);
  const roleTemplate = input.scope === "role" ? String(input.roleTemplate || "").trim() : null;
  if (input.scope === "role" && !roleTemplate) throw new Error("role knowledge requires roleTemplate");
  await db.execute(sql`
    INSERT INTO knowledge_bases (
      public_id, owner_user_id, owner_group_id, scope, is_global, role_template, name, description,
      classification, external_processing_allowed
    ) VALUES (
      ${input.publicId}, ${input.ownerUserId}, ${input.ownerGroupId}, ${input.scope},
      ${isGlobal}, ${roleTemplate}, ${input.name}, ${input.description || ""},
      ${input.classification || "internal"}, ${input.externalProcessingAllowed ?? true}
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

export async function prepareManagedKnowledgeBaseReplacement(input: {
  id: number;
  ownerUserId: number;
  name: string;
  description: string;
  classification: KnowledgeClassification;
  externalProcessingAllowed: boolean;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE knowledge_bases
    SET name = ${input.name},
        description = ${input.description},
        classification = ${input.classification},
        external_processing_allowed = ${input.externalProcessingAllowed},
        status = 'indexing',
        document_count = 0,
        chunk_count = 0,
        last_error = NULL
    WHERE id = ${input.id} AND owner_user_id = ${input.ownerUserId}
  `);
}

export async function setKnowledgeBaseIndexState(input: {
  id: number;
  status: KnowledgeStatus;
  chunkCount?: number;
  error?: string | null;
  indexVersion?: string | null;
  indexSchemaVersion?: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE knowledge_bases
    SET status = ${input.status},
        chunk_count = COALESCE(${input.chunkCount ?? null}, chunk_count),
        last_error = ${input.error || null},
        index_version = COALESCE(${input.indexVersion ?? null}, index_version),
        index_schema_version = COALESCE(${input.indexSchemaVersion ?? null}, index_schema_version),
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

export async function listKnowledgeDocumentsForBases(knowledgeBaseIds: number[]): Promise<KnowledgeDocumentRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const normalized = Array.from(new Set(
    knowledgeBaseIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
  )).slice(0, 8);
  if (!normalized.length) return [];
  const result = await db.execute(sql`
    SELECT ${DOCUMENT_SELECT}
    FROM knowledge_documents
    WHERE knowledge_base_id IN (${sql.join(normalized.map((id) => sql`${id}`), sql`, `)})
    ORDER BY knowledge_base_id ASC, updated_at DESC, id DESC
    LIMIT 16000
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
  sourceAssetId?: string | null;
  documentSeriesId?: string | null;
  supersedesDocumentId?: string | null;
  versionLabel?: string;
  lifecycle?: KnowledgeDocumentLifecycle;
  sourceDepartment?: string;
  classification?: KnowledgeClassification;
  authority?: KnowledgeAuthority;
  externalProcessingAllowed?: boolean;
  effectiveAt?: Date | null;
  expiresAt?: Date | null;
}): Promise<KnowledgeDocumentRecord> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    INSERT INTO knowledge_documents (
      public_id, knowledge_base_id, name, extension, mime_type, storage_path, size_bytes, sha256,
      source_asset_id, document_series_id, supersedes_document_id,
      version_label, lifecycle, source_department, classification, authority,
      external_processing_allowed, effective_at, expires_at
    ) VALUES (
      ${input.publicId}, ${input.knowledgeBaseId}, ${input.name}, ${input.extension},
      ${input.mimeType}, ${input.storagePath}, ${input.sizeBytes}, ${input.sha256},
      ${input.sourceAssetId || null}, ${input.documentSeriesId || null}, ${input.supersedesDocumentId || null},
      ${input.versionLabel || "1.0"}, ${input.lifecycle || "active"}, ${input.sourceDepartment || ""},
      ${input.classification || "internal"}, ${input.authority || "reference"},
      ${input.externalProcessingAllowed ?? true}, ${input.effectiveAt || null}, ${input.expiresAt || null}
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
  parserVersion?: string | null;
  indexVersion?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE knowledge_documents
    SET status = ${input.status},
        chunk_count = COALESCE(${input.chunkCount ?? null}, chunk_count),
        last_error = ${input.error || null},
        parser_version = COALESCE(${input.parserVersion ?? null}, parser_version),
        index_version = COALESCE(${input.indexVersion ?? null}, index_version)
    WHERE id = ${input.id}
  `);
}

export function isKnowledgeDocumentCurrentlyActive(document: KnowledgeDocumentRecord, now = new Date()): boolean {
  if (document.lifecycle !== "active") return false;
  const effectiveAt = document.effectiveAt ? new Date(document.effectiveAt) : null;
  const expiresAt = document.expiresAt ? new Date(document.expiresAt) : null;
  if (effectiveAt && !Number.isNaN(effectiveAt.getTime()) && effectiveAt.getTime() > now.getTime()) return false;
  if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

export async function updateKnowledgeDocumentGovernance(input: {
  id: number;
  knowledgeBaseId: number;
  versionLabel: string;
  sourceAssetId?: string | null;
  documentSeriesId?: string | null;
  supersedesDocumentId?: string | null;
  lifecycle: KnowledgeDocumentLifecycle;
  sourceDepartment: string;
  classification: KnowledgeClassification;
  authority: KnowledgeAuthority;
  externalProcessingAllowed: boolean;
  effectiveAt?: Date | null;
  expiresAt?: Date | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE knowledge_documents
    SET source_asset_id = COALESCE(${input.sourceAssetId ?? null}, source_asset_id),
        document_series_id = COALESCE(${input.documentSeriesId ?? null}, document_series_id),
        supersedes_document_id = COALESCE(${input.supersedesDocumentId ?? null}, supersedes_document_id),
        version_label = ${input.versionLabel},
        lifecycle = ${input.lifecycle},
        source_department = ${input.sourceDepartment},
        classification = ${input.classification},
        authority = ${input.authority},
        external_processing_allowed = ${input.externalProcessingAllowed},
        effective_at = ${input.effectiveAt || null},
        expires_at = ${input.expiresAt || null}
    WHERE id = ${input.id} AND knowledge_base_id = ${input.knowledgeBaseId}
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

function mapIndexJob(row: any): KnowledgeIndexJobRecord {
  return {
    id: Number(row.id),
    knowledgeBaseId: Number(row.knowledge_base_id),
    reason: String(row.reason || "content_changed"),
    status: String(row.status || "queued") as KnowledgeIndexJobStatus,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error ? String(row.last_error) : null,
    lockedAt: isoDate(row.locked_at),
    finishedAt: isoDate(row.finished_at),
    createdAt: isoDate(row.created_at) || new Date(0).toISOString(),
    updatedAt: isoDate(row.updated_at) || new Date(0).toISOString(),
  };
}

export async function createKnowledgeIndexJob(knowledgeBaseId: number, reason = "content_changed"): Promise<KnowledgeIndexJobRecord> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result: any = await db.execute(sql`
    INSERT INTO knowledge_index_jobs (knowledge_base_id, reason)
    VALUES (${knowledgeBaseId}, ${reason})
  `);
  const id = Number((result as any)?.[0]?.insertId || 0);
  const rows: any = await db.execute(sql`
    SELECT id, knowledge_base_id, reason, status, attempts, last_error, locked_at,
           finished_at, created_at, updated_at
    FROM knowledge_index_jobs WHERE id = ${id} LIMIT 1
  `);
  const row = rowsFromResult(rows)[0];
  if (!row) throw new Error("knowledge index job create failed");
  return mapIndexJob(row);
}

export async function setKnowledgeIndexJobState(input: {
  id: number;
  status: KnowledgeIndexJobStatus;
  error?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE knowledge_index_jobs
    SET status = ${input.status},
        attempts = attempts + CASE WHEN ${input.status} = 'running' THEN 1 ELSE 0 END,
        last_error = ${input.error || null},
        locked_at = CASE WHEN ${input.status} = 'running' THEN CURRENT_TIMESTAMP ELSE locked_at END,
        finished_at = CASE WHEN ${input.status} IN ('succeeded', 'failed') THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE id = ${input.id}
  `);
}

export async function listRecoverableKnowledgeIndexJobs(limit = 100): Promise<KnowledgeIndexJobRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const result: any = await db.execute(sql`
    SELECT id, knowledge_base_id, reason, status, attempts, last_error, locked_at,
           finished_at, created_at, updated_at
    FROM knowledge_index_jobs
    WHERE status = 'queued'
       OR (status = 'running' AND locked_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE))
    ORDER BY created_at ASC, id ASC
    LIMIT ${Math.max(1, Math.min(limit, 500))}
  `);
  return rowsFromResult(result).map(mapIndexJob);
}

export async function pruneKnowledgeIndexJobs(retentionDays = 30): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const days = Math.max(1, Math.min(retentionDays, 365));
  await db.execute(sql.raw(`
    DELETE FROM knowledge_index_jobs
    WHERE status IN ('succeeded', 'failed')
      AND finished_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${days} DAY)
  `));
}
