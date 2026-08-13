import { sql } from "drizzle-orm";
import { getDb } from "./connection";

export type AgentMemoryMode = "learn_and_use" | "use_only" | "off";
export type AgentMemoryKind = "preference" | "instruction" | "entity" | "procedure";
export type AgentMemoryStatus = "candidate" | "active" | "superseded" | "forgotten" | "rejected" | "expired";
export type AgentMemorySource = "explicit" | "automatic" | "feedback" | "legacy";
export type AgentMemorySynthesisSlot = "profile" | "recent" | "playbook";
export type AgentMemoryVersionChange = "created" | "observed" | "edited" | "restored";

export type AgentMemoryRecord = {
  id: number;
  userId: number;
  adoptId: string;
  roleTemplate: string;
  scope: "role" | "user";
  kind: AgentMemoryKind;
  status: AgentMemoryStatus;
  canonicalKey: string;
  content: string;
  source: AgentMemorySource;
  confidence: number;
  evidenceCount: number;
  version: number;
  lastObservedAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentMemoryVersionRecord = {
  id: number;
  memoryId: number;
  version: number;
  kind: AgentMemoryKind;
  content: string;
  source: AgentMemorySource;
  confidence: number;
  changeType: AgentMemoryVersionChange;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
};

export type AgentMemoryJobRecord = {
  id: number;
  idempotencyKey: string;
  userId: number;
  adoptId: string;
  roleTemplate: string;
  channel: string;
  sessionId: string;
  requestId: string;
  conversationId: string;
  payloadEncrypted: string;
  attempts: number;
};

export type AgentMemoryEvidenceRecord = {
  id: number;
  memoryId: number;
  conflictId: number | null;
  sourceType: "explicit" | "conversation" | "feedback" | "legacy";
  channel: string;
  sessionId: string | null;
  conversationId: string | null;
  messageId: string | null;
  snippet: string | null;
  metadata: Record<string, unknown> | null;
  observedAt: string;
};

export type AgentMemorySynthesisRecord = {
  id: number;
  userId: number;
  adoptId: string;
  slot: AgentMemorySynthesisSlot;
  canonicalKey: string;
  content: string;
  memoryIds: number[];
  sourceSignature: string;
  confidence: number;
  model: string;
  generatedAt: string;
  updatedAt: string;
};

export type AgentMemorySynthesisStateRecord = {
  desiredSignature: string;
  completedSignature: string;
  status: "pending" | "running" | "ready" | "failed";
  model: string;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
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

function mapMemory(row: any): AgentMemoryRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    adoptId: String(row.adopt_id || ""),
    roleTemplate: String(row.role_template || "general-assistant"),
    scope: row.scope === "user" ? "user" : "role",
    kind: String(row.kind || "preference") as AgentMemoryKind,
    status: String(row.status || "candidate") as AgentMemoryStatus,
    canonicalKey: String(row.canonical_key || ""),
    content: String(row.content || ""),
    source: String(row.source || "automatic") as AgentMemorySource,
    confidence: Number(row.confidence || 0),
    evidenceCount: Number(row.evidence_count || 0),
    version: Number(row.version || 1),
    lastObservedAt: isoDate(row.last_observed_at) || new Date(0).toISOString(),
    lastUsedAt: isoDate(row.last_used_at),
    expiresAt: isoDate(row.expires_at),
    createdAt: isoDate(row.created_at) || new Date(0).toISOString(),
    updatedAt: isoDate(row.updated_at) || new Date(0).toISOString(),
  };
}

function mapMemoryVersion(row: Record<string, unknown>): AgentMemoryVersionRecord {
  return {
    id: Number(row.id),
    memoryId: Number(row.memory_id),
    version: Number(row.version || 1),
    kind: String(row.kind || "preference") as AgentMemoryKind,
    content: String(row.content || ""),
    source: String(row.source || "automatic") as AgentMemorySource,
    confidence: Number(row.confidence || 0),
    changeType: String(row.change_type || "observed") as AgentMemoryVersionChange,
    validFrom: isoDate(row.valid_from) || new Date(0).toISOString(),
    validTo: isoDate(row.valid_to),
    createdAt: isoDate(row.created_at) || new Date(0).toISOString(),
  };
}

function numberArray(value: unknown): number[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return Array.from(new Set(parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
}

function mapSynthesis(row: any): AgentMemorySynthesisRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    adoptId: String(row.adopt_id || ""),
    slot: String(row.slot || "profile") as AgentMemorySynthesisSlot,
    canonicalKey: String(row.canonical_key || ""),
    content: String(row.content || ""),
    memoryIds: numberArray(row.memory_ids_json),
    sourceSignature: String(row.source_signature || ""),
    confidence: Number(row.confidence || 0),
    model: String(row.model || ""),
    generatedAt: isoDate(row.generated_at) || new Date(0).toISOString(),
    updatedAt: isoDate(row.updated_at) || new Date(0).toISOString(),
  };
}

const MEMORY_SELECT = sql.raw(`
  id, user_id, adopt_id, role_template, scope, kind, status, canonical_key,
  content, source, confidence, evidence_count, version, last_observed_at,
  last_used_at, expires_at, created_at, updated_at
`);

export async function getAgentMemoryMode(adoptionId: number): Promise<AgentMemoryMode> {
  const db = await getDb();
  if (!db) return "off";
  const result: any = await db.execute(sql`
    SELECT memory_mode, memoryEnabled
    FROM claw_profile_settings
    WHERE adoptionId = ${adoptionId}
    LIMIT 1
  `);
  const row = rowsFromResult(result)[0];
  if (!row) return "learn_and_use";
  if (row.memoryEnabled === "no") return "off";
  if (row.memory_mode === "learn_and_use" || row.memory_mode === "use_only" || row.memory_mode === "off") {
    return row.memory_mode;
  }
  return "learn_and_use";
}

export async function setAgentMemoryMode(adoptionId: number, mode: AgentMemoryMode, updatedBy: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const enabled = mode === "off" ? "no" : "yes";
  await db.execute(sql`
    INSERT INTO claw_profile_settings (adoptionId, memoryEnabled, memory_mode, updatedBy)
    VALUES (${adoptionId}, ${enabled}, ${mode}, ${updatedBy})
    ON DUPLICATE KEY UPDATE
      memoryEnabled = VALUES(memoryEnabled),
      memory_mode = VALUES(memory_mode),
      updatedBy = VALUES(updatedBy),
      updatedAt = CURRENT_TIMESTAMP
  `);
}

export async function listAgentMemories(input: {
  userId: number;
  adoptId: string;
  statuses?: AgentMemoryStatus[];
  limit?: number;
}): Promise<AgentMemoryRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const statuses = input.statuses?.length ? input.statuses : ["active", "candidate"];
  const limit = Math.min(Math.max(input.limit || 200, 1), 500);
  const result: any = await db.execute(sql`
    SELECT ${MEMORY_SELECT}
    FROM agent_memory_items
    WHERE user_id = ${input.userId}
      AND adopt_id = ${input.adoptId}
      AND status IN (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    ORDER BY FIELD(status, 'active', 'candidate'), updated_at DESC
    LIMIT ${limit}
  `);
  return rowsFromResult(result).map(mapMemory);
}

export async function getAgentMemoryById(userId: number, adoptId: string, id: number): Promise<AgentMemoryRecord | null> {
  const db = await getDb();
  if (!db) return null;
  const result: any = await db.execute(sql`
    SELECT ${MEMORY_SELECT}
    FROM agent_memory_items
    WHERE id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
    LIMIT 1
  `);
  const row = rowsFromResult(result)[0];
  return row ? mapMemory(row) : null;
}

export async function findAgentMemoryByKey(userId: number, adoptId: string, canonicalKey: string): Promise<AgentMemoryRecord | null> {
  const db = await getDb();
  if (!db) return null;
  const result: any = await db.execute(sql`
    SELECT ${MEMORY_SELECT}
    FROM agent_memory_items
    WHERE user_id = ${userId} AND adopt_id = ${adoptId} AND canonical_key = ${canonicalKey}
    LIMIT 1
  `);
  const row = rowsFromResult(result)[0];
  return row ? mapMemory(row) : null;
}

export async function createAgentMemory(input: {
  userId: number;
  adoptId: string;
  roleTemplate: string;
  scope: "role" | "user";
  kind: AgentMemoryKind;
  status: AgentMemoryStatus;
  canonicalKey: string;
  content: string;
  source: AgentMemorySource;
  confidence: number;
  expiresAt?: Date | null;
}): Promise<AgentMemoryRecord> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    INSERT INTO agent_memory_items (
      user_id, adopt_id, role_template, scope, kind, status, canonical_key,
      content, source, confidence, evidence_count, expires_at
    ) VALUES (
      ${input.userId}, ${input.adoptId}, ${input.roleTemplate}, ${input.scope}, ${input.kind},
      ${input.status}, ${input.canonicalKey}, ${input.content}, ${input.source}, ${input.confidence}, 0,
      ${input.expiresAt || null}
    )
  `);
  const created = await findAgentMemoryByKey(input.userId, input.adoptId, input.canonicalKey);
  if (!created) throw new Error("memory insert failed");
  await db.execute(sql`
    INSERT IGNORE INTO agent_memory_versions (
      memory_id, user_id, adopt_id, version, kind, content, source, confidence,
      change_type, valid_from
    ) VALUES (
      ${created.id}, ${created.userId}, ${created.adoptId}, ${created.version}, ${created.kind},
      ${created.content}, ${created.source}, ${created.confidence}, 'created', ${new Date(created.createdAt)}
    )
  `);
  return created;
}

export async function updateAgentMemoryObservation(input: {
  id: number;
  content: string;
  kind: AgentMemoryKind;
  source: AgentMemorySource;
  confidence: number;
  status?: AgentMemoryStatus;
  expiresAt?: Date | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async (tx) => {
    const locked: unknown = await tx.execute(sql`SELECT ${MEMORY_SELECT} FROM agent_memory_items WHERE id = ${input.id} FOR UPDATE`);
    const row = rowsFromResult(locked)[0];
    if (!row) return;
    const current = mapMemory(row);
    await tx.execute(sql`
      INSERT IGNORE INTO agent_memory_versions (
        memory_id, user_id, adopt_id, version, kind, content, source, confidence,
        change_type, valid_from
      ) VALUES (
        ${current.id}, ${current.userId}, ${current.adoptId}, ${current.version}, ${current.kind},
        ${current.content}, ${current.source}, ${current.confidence}, 'created', ${new Date(current.createdAt)}
      )
    `);
    const contentChanged = current.content !== input.content || current.kind !== input.kind;
    const nextVersion = current.version + (contentChanged ? 1 : 0);
    if (contentChanged) {
      await tx.execute(sql`
        UPDATE agent_memory_versions SET valid_to = CURRENT_TIMESTAMP
        WHERE memory_id = ${current.id} AND version = ${current.version} AND valid_to IS NULL
      `);
    }
    await tx.execute(sql`
      UPDATE agent_memory_items
      SET content = ${input.content}, kind = ${input.kind}, source = ${input.source},
          confidence = GREATEST(confidence, ${input.confidence}),
          status = COALESCE(${input.status || null}, status),
          expires_at = COALESCE(${input.expiresAt || null}, expires_at),
          last_observed_at = CURRENT_TIMESTAMP, version = ${nextVersion}
      WHERE id = ${input.id}
    `);
    if (contentChanged) {
      await tx.execute(sql`
        INSERT INTO agent_memory_versions (
          memory_id, user_id, adopt_id, version, kind, content, source, confidence,
          change_type, valid_from
        ) VALUES (
          ${current.id}, ${current.userId}, ${current.adoptId}, ${nextVersion}, ${input.kind},
          ${input.content}, ${input.source}, ${Math.max(current.confidence, input.confidence)}, 'observed', CURRENT_TIMESTAMP
        )
      `);
    }
  });
}

export async function addAgentMemoryEvidence(input: {
  memoryId: number;
  conflictId?: number;
  userId: number;
  adoptId: string;
  sourceType: "explicit" | "conversation" | "feedback" | "legacy";
  channel: string;
  sessionId?: string;
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  sourceHash: string;
  snippet?: string;
  metadata?: Record<string, unknown>;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    INSERT IGNORE INTO agent_memory_evidence (
      memory_id, conflict_id, user_id, adopt_id, source_type, channel, session_id, request_id,
      conversation_id, message_id, source_hash, snippet, metadata_json
    ) VALUES (
      ${input.memoryId}, ${input.conflictId || null}, ${input.userId}, ${input.adoptId}, ${input.sourceType}, ${input.channel},
      ${input.sessionId || null}, ${input.requestId || null}, ${input.conversationId || null},
      ${input.messageId || null}, ${input.sourceHash}, ${input.snippet || null},
      ${input.metadata ? JSON.stringify(input.metadata) : null}
    )
  `);
  const countResult: unknown = input.conflictId
    ? await db.execute(sql`
        SELECT COUNT(DISTINCT COALESCE(NULLIF(session_id, ''), source_hash)) AS evidence_count
        FROM agent_memory_evidence
        WHERE conflict_id = ${input.conflictId}
      `)
    : await db.execute(sql`
        SELECT COUNT(DISTINCT COALESCE(NULLIF(session_id, ''), source_hash)) AS evidence_count
        FROM agent_memory_evidence
        WHERE memory_id = ${input.memoryId} AND conflict_id IS NULL
      `);
  const count = Number(rowsFromResult(countResult)[0]?.evidence_count || 0);
  if (input.conflictId) {
    await db.execute(sql`
      UPDATE agent_memory_conflicts
      SET evidence_count = ${count}, last_observed_at = CURRENT_TIMESTAMP
      WHERE id = ${input.conflictId} AND memory_id = ${input.memoryId}
    `);
  } else {
    await db.execute(sql`
      UPDATE agent_memory_items
      SET evidence_count = ${count}, last_observed_at = CURRENT_TIMESTAMP
      WHERE id = ${input.memoryId}
    `);
  }
  return count;
}

export async function addAgentMemoryEvidenceOnce(input: Parameters<typeof addAgentMemoryEvidence>[0]): Promise<{
  inserted: boolean;
  evidenceCount: number;
}> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.transaction(async (tx) => {
    const result: unknown = await tx.execute(sql`
      INSERT IGNORE INTO agent_memory_evidence (
        memory_id, conflict_id, user_id, adopt_id, source_type, channel, session_id, request_id,
        conversation_id, message_id, source_hash, snippet, metadata_json
      ) VALUES (
        ${input.memoryId}, ${input.conflictId || null}, ${input.userId}, ${input.adoptId}, ${input.sourceType}, ${input.channel},
        ${input.sessionId || null}, ${input.requestId || null}, ${input.conversationId || null},
        ${input.messageId || null}, ${input.sourceHash}, ${input.snippet || null},
        ${input.metadata ? JSON.stringify(input.metadata) : null}
      )
    `);
    const first = Array.isArray(result) ? result[0] as { affectedRows?: unknown } | undefined : undefined;
    const inserted = Number(first?.affectedRows || 0) === 1;
    const countResult: unknown = await tx.execute(sql`
      SELECT COUNT(DISTINCT COALESCE(NULLIF(session_id, ''), source_hash)) AS evidence_count
      FROM agent_memory_evidence
      WHERE memory_id = ${input.memoryId} AND conflict_id IS NULL
    `);
    const evidenceCount = Number(rowsFromResult(countResult)[0]?.evidence_count || 0);
    await tx.execute(sql`
      UPDATE agent_memory_items
      SET evidence_count = ${evidenceCount}, last_observed_at = CURRENT_TIMESTAMP,
          confidence = LEAST(100, confidence + ${inserted ? 5 : 0})
      WHERE id = ${input.memoryId} AND user_id = ${input.userId} AND adopt_id = ${input.adoptId}
    `);
    return { inserted, evidenceCount };
  });
}

export async function setAgentMemoryStatus(id: number, userId: number, adoptId: string, status: AgentMemoryStatus): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE agent_memory_items
    SET status = ${status}
    WHERE id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
  `);
}

export async function listAgentMemoryEvidence(input: {
  userId: number;
  adoptId: string;
  memoryIds?: number[];
  limit?: number;
}): Promise<AgentMemoryEvidenceRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.max(1, Math.min(Number(input.limit || 500), 1000));
  const memoryIds = (input.memoryIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const memoryFilter = memoryIds.length
    ? sql`AND evidence.memory_id IN (${sql.join(memoryIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  const result: any = await db.execute(sql`
    SELECT evidence.id, evidence.memory_id, evidence.conflict_id, evidence.source_type, evidence.channel,
           evidence.session_id, evidence.conversation_id, evidence.message_id,
           evidence.snippet, evidence.metadata_json, evidence.observed_at
    FROM agent_memory_evidence evidence
    JOIN agent_memory_items item ON item.id = evidence.memory_id
    LEFT JOIN agent_memory_conflicts conflict ON conflict.id = evidence.conflict_id
    WHERE evidence.user_id = ${input.userId}
      AND evidence.adopt_id = ${input.adoptId}
      AND item.status IN ('active', 'candidate')
      AND (evidence.conflict_id IS NULL OR conflict.status = 'pending')
      ${memoryFilter}
    ORDER BY evidence.observed_at DESC, evidence.id DESC
    LIMIT ${limit}
  `);
  return rowsFromResult(result).map((row) => ({
    id: Number(row.id),
    memoryId: Number(row.memory_id),
    conflictId: row.conflict_id ? Number(row.conflict_id) : null,
    sourceType: String(row.source_type || "conversation") as AgentMemoryEvidenceRecord["sourceType"],
    channel: String(row.channel || "web"),
    sessionId: row.session_id ? String(row.session_id) : null,
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    messageId: row.message_id ? String(row.message_id) : null,
    snippet: row.snippet ? String(row.snippet) : null,
    metadata: row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : null,
    observedAt: isoDate(row.observed_at) || new Date(0).toISOString(),
  }));
}

export async function listAgentMemorySyntheses(input: {
  userId: number;
  adoptId: string;
  sourceSignature?: string;
}): Promise<AgentMemorySynthesisRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const signatureFilter = input.sourceSignature
    ? sql`AND source_signature = ${input.sourceSignature}`
    : sql``;
  const result: any = await db.execute(sql`
    SELECT id, user_id, adopt_id, slot, canonical_key, content, memory_ids_json,
           source_signature, confidence, model, generated_at, updated_at
    FROM agent_memory_syntheses
    WHERE user_id = ${input.userId}
      AND adopt_id = ${input.adoptId}
      ${signatureFilter}
    ORDER BY FIELD(slot, 'profile', 'recent', 'playbook'), canonical_key, id
  `);
  return rowsFromResult(result).map(mapSynthesis);
}

export async function getAgentMemorySynthesisState(
  userId: number,
  adoptId: string,
): Promise<AgentMemorySynthesisStateRecord | null> {
  const db = await getDb();
  if (!db) return null;
  const result: any = await db.execute(sql`
    SELECT desired_signature, completed_signature, status, model, error_message,
           started_at, completed_at
    FROM agent_memory_synthesis_state
    WHERE user_id = ${userId} AND adopt_id = ${adoptId}
    LIMIT 1
  `);
  const row = rowsFromResult(result)[0];
  return row ? {
    desiredSignature: String(row.desired_signature || ""),
    completedSignature: String(row.completed_signature || ""),
    status: String(row.status || "pending") as AgentMemorySynthesisStateRecord["status"],
    model: String(row.model || ""),
    errorMessage: row.error_message ? String(row.error_message) : null,
    startedAt: isoDate(row.started_at),
    completedAt: isoDate(row.completed_at),
  } : null;
}

export async function markAgentMemorySynthesisPending(input: {
  userId: number;
  adoptId: string;
  desiredSignature: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    INSERT INTO agent_memory_synthesis_state (
      user_id, adopt_id, desired_signature, completed_signature, status
    ) VALUES (
      ${input.userId}, ${input.adoptId}, ${input.desiredSignature}, '', 'pending'
    )
    ON DUPLICATE KEY UPDATE
      desired_signature = VALUES(desired_signature),
      status = IF(completed_signature = VALUES(desired_signature), 'ready', 'pending'),
      error_message = NULL,
      updated_at = CURRENT_TIMESTAMP
  `);
}

export async function markAgentMemorySynthesisRunning(input: {
  userId: number;
  adoptId: string;
  desiredSignature: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    INSERT INTO agent_memory_synthesis_state (
      user_id, adopt_id, desired_signature, completed_signature, status, started_at
    ) VALUES (
      ${input.userId}, ${input.adoptId}, ${input.desiredSignature}, '', 'running', CURRENT_TIMESTAMP
    )
    ON DUPLICATE KEY UPDATE
      desired_signature = VALUES(desired_signature),
      status = 'running',
      started_at = CURRENT_TIMESTAMP,
      completed_at = NULL,
      error_message = NULL,
      updated_at = CURRENT_TIMESTAMP
  `);
}

export async function replaceAgentMemorySyntheses(input: {
  userId: number;
  adoptId: string;
  sourceSignature: string;
  model: string;
  rows: Array<{
    slot: AgentMemorySynthesisSlot;
    canonicalKey: string;
    content: string;
    memoryIds: number[];
    confidence: number;
  }>;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM agent_memory_syntheses
      WHERE user_id = ${input.userId} AND adopt_id = ${input.adoptId}
    `);
    for (const row of input.rows) {
      await tx.execute(sql`
        INSERT INTO agent_memory_syntheses (
          user_id, adopt_id, slot, canonical_key, content, memory_ids_json,
          source_signature, confidence, model, generated_at
        ) VALUES (
          ${input.userId}, ${input.adoptId}, ${row.slot}, ${row.canonicalKey}, ${row.content},
          ${JSON.stringify(row.memoryIds)}, ${input.sourceSignature}, ${row.confidence},
          ${input.model.slice(0, 160)}, CURRENT_TIMESTAMP
        )
      `);
    }
    await tx.execute(sql`
      INSERT INTO agent_memory_synthesis_state (
        user_id, adopt_id, desired_signature, completed_signature, status,
        model, error_message, completed_at
      ) VALUES (
        ${input.userId}, ${input.adoptId}, ${input.sourceSignature}, ${input.sourceSignature},
        'ready', ${input.model.slice(0, 160)}, NULL, CURRENT_TIMESTAMP
      )
      ON DUPLICATE KEY UPDATE
        desired_signature = VALUES(desired_signature),
        completed_signature = VALUES(completed_signature),
        status = 'ready',
        model = VALUES(model),
        error_message = NULL,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `);
  });
}

export async function failAgentMemorySynthesis(input: {
  userId: number;
  adoptId: string;
  desiredSignature: string;
  errorMessage: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    INSERT INTO agent_memory_synthesis_state (
      user_id, adopt_id, desired_signature, completed_signature, status,
      error_message, completed_at
    ) VALUES (
      ${input.userId}, ${input.adoptId}, ${input.desiredSignature}, '', 'failed',
      ${input.errorMessage.slice(0, 1000)}, CURRENT_TIMESTAMP
    )
    ON DUPLICATE KEY UPDATE
      desired_signature = VALUES(desired_signature),
      status = 'failed',
      error_message = VALUES(error_message),
      completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `);
}

export async function confirmAgentMemoryRecord(id: number, userId: number, adoptId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE agent_memory_items
    SET status = 'active', source = 'explicit', confidence = 100,
        last_observed_at = CURRENT_TIMESTAMP
    WHERE id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId} AND status = 'candidate'
  `);
}

export async function rejectAgentMemoryRecord(id: number, userId: number, adoptId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE agent_memory_items
      SET status = 'rejected', last_observed_at = CURRENT_TIMESTAMP
      WHERE id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId} AND status = 'candidate'
    `);
    await tx.execute(sql`
      UPDATE agent_memory_evidence
      SET snippet = NULL
      WHERE memory_id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
    `);
  });
}

export async function forgetAgentMemoryRecord(id: number, userId: number, adoptId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE agent_memory_items
      SET status = 'forgotten', content = '[已忘记]',
          last_observed_at = CURRENT_TIMESTAMP
      WHERE id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
    `);
    await tx.execute(sql`
      UPDATE agent_memory_evidence
      SET snippet = NULL
      WHERE memory_id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
    `);
    await tx.execute(sql`
      UPDATE agent_memory_versions
      SET content = '[已忘记]', valid_to = COALESCE(valid_to, CURRENT_TIMESTAMP)
      WHERE memory_id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
    `);
    await tx.execute(sql`
      UPDATE agent_memory_conflicts
      SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP
      WHERE memory_id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId} AND status = 'pending'
    `);
  });
}

export async function updateAgentMemoryContent(
  id: number,
  userId: number,
  adoptId: string,
  content: string,
  changeType: AgentMemoryVersionChange = "edited",
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async (tx) => {
    const locked: unknown = await tx.execute(sql`
      SELECT ${MEMORY_SELECT} FROM agent_memory_items
      WHERE id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
      FOR UPDATE
    `);
    const row = rowsFromResult(locked)[0];
    if (!row) throw new Error("memory not found");
    const current = mapMemory(row);
    await tx.execute(sql`
      INSERT IGNORE INTO agent_memory_versions (
        memory_id, user_id, adopt_id, version, kind, content, source, confidence,
        change_type, valid_from
      ) VALUES (
        ${current.id}, ${current.userId}, ${current.adoptId}, ${current.version}, ${current.kind},
        ${current.content}, ${current.source}, ${current.confidence}, 'created', ${new Date(current.createdAt)}
      )
    `);
    if (current.content === content) {
      await tx.execute(sql`
        UPDATE agent_memory_items SET status = 'active', source = 'explicit', confidence = 100,
          last_observed_at = CURRENT_TIMESTAMP
        WHERE id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
      `);
      return;
    }
    const nextVersion = current.version + 1;
    await tx.execute(sql`
      UPDATE agent_memory_versions SET valid_to = CURRENT_TIMESTAMP
      WHERE memory_id = ${id} AND version = ${current.version} AND valid_to IS NULL
    `);
    await tx.execute(sql`
      UPDATE agent_memory_items
      SET content = ${content}, status = 'active', source = 'explicit', confidence = 100,
          version = ${nextVersion}, last_observed_at = CURRENT_TIMESTAMP
      WHERE id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
    `);
    await tx.execute(sql`
      INSERT INTO agent_memory_versions (
        memory_id, user_id, adopt_id, version, kind, content, source, confidence,
        change_type, valid_from
      ) VALUES (
        ${id}, ${userId}, ${adoptId}, ${nextVersion}, ${current.kind}, ${content},
        'explicit', 100, ${changeType}, CURRENT_TIMESTAMP
      )
    `);
    await tx.execute(sql`
      UPDATE agent_memory_conflicts
      SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP
      WHERE memory_id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId} AND status = 'pending'
    `);
  });
}

export async function listAgentMemoryVersions(input: {
  userId: number;
  adoptId: string;
  memoryIds?: number[];
  limit?: number;
}): Promise<AgentMemoryVersionRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const memoryIds = (input.memoryIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const memoryFilter = memoryIds.length
    ? sql`AND memory_id IN (${sql.join(memoryIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  const limit = Math.max(1, Math.min(Number(input.limit || 500), 1000));
  const result: unknown = await db.execute(sql`
    SELECT id, memory_id, version, kind, content, source, confidence, change_type,
           valid_from, valid_to, created_at
    FROM agent_memory_versions
    WHERE user_id = ${input.userId} AND adopt_id = ${input.adoptId} ${memoryFilter}
    ORDER BY memory_id, version DESC
    LIMIT ${limit}
  `);
  return rowsFromResult(result).map(mapMemoryVersion);
}

export async function markAgentMemoriesUsed(input: {
  userId: number;
  adoptId: string;
  memoryIds: number[];
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const memoryIds = Array.from(new Set(input.memoryIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  if (!memoryIds.length) return;
  await db.execute(sql`
    UPDATE agent_memory_items SET last_used_at = CURRENT_TIMESTAMP
    WHERE user_id = ${input.userId} AND adopt_id = ${input.adoptId}
      AND id IN (${sql.join(memoryIds.map((id) => sql`${id}`), sql`, `)})
      AND status = 'active'
  `);
}

export async function restoreAgentMemoryVersionRecord(input: {
  userId: number;
  adoptId: string;
  memoryId: number;
  version: number;
}): Promise<void> {
  const versions = await listAgentMemoryVersions({
    userId: input.userId,
    adoptId: input.adoptId,
    memoryIds: [input.memoryId],
  });
  const target = versions.find((item) => item.version === input.version);
  if (!target || target.content === "[已忘记]") throw new Error("记忆历史版本不存在");
  await updateAgentMemoryContent(input.memoryId, input.userId, input.adoptId, target.content, "restored");
}

export async function promoteConversationMemoryCandidates(input: {
  userId: number;
  adoptId: string;
  conversationId: string;
}): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result: any = await db.execute(sql`
    UPDATE agent_memory_items item
    JOIN agent_memory_evidence evidence ON evidence.memory_id = item.id
    SET item.status = 'active', item.source = 'feedback', item.confidence = GREATEST(item.confidence, 85),
        item.last_observed_at = CURRENT_TIMESTAMP
    WHERE item.user_id = ${input.userId}
      AND item.adopt_id = ${input.adoptId}
      AND item.status = 'candidate'
      AND evidence.conversation_id = ${input.conversationId}
  `);
  return Number((result as any)?.[0]?.affectedRows || 0);
}

export async function rejectConversationMemoryCandidates(input: {
  userId: number;
  adoptId: string;
  conversationId: string;
}): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result: any = await db.execute(sql`
    UPDATE agent_memory_items item
    JOIN agent_memory_evidence evidence ON evidence.memory_id = item.id
    SET item.status = 'rejected'
    WHERE item.user_id = ${input.userId}
      AND item.adopt_id = ${input.adoptId}
      AND item.status = 'candidate'
      AND evidence.conversation_id = ${input.conversationId}
  `);
  return Number((result as any)?.[0]?.affectedRows || 0);
}

export async function enqueueAgentMemoryJob(input: {
  idempotencyKey: string;
  userId: number;
  adoptId: string;
  roleTemplate: string;
  channel: string;
  sessionId?: string;
  requestId?: string;
  conversationId?: string;
  payloadEncrypted: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    INSERT IGNORE INTO agent_memory_jobs (
      idempotency_key, user_id, adopt_id, role_template, channel, session_id,
      request_id, conversation_id, payload_encrypted
    ) VALUES (
      ${input.idempotencyKey}, ${input.userId}, ${input.adoptId}, ${input.roleTemplate}, ${input.channel},
      ${input.sessionId || null}, ${input.requestId || null}, ${input.conversationId || null}, ${input.payloadEncrypted}
    )
  `);
}

export async function recoverStaleAgentMemoryJobs(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    UPDATE agent_memory_jobs
    SET status = 'pending', next_attempt_at = CURRENT_TIMESTAMP,
        error_message = 'recovered_after_worker_restart'
    WHERE status = 'running' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)
  `);
}

export async function claimNextAgentMemoryJob(): Promise<AgentMemoryJobRecord | null> {
  const db = await getDb();
  if (!db) return null;
  const result: any = await db.execute(sql`
    SELECT id, idempotency_key, user_id, adopt_id, role_template, channel, session_id,
      request_id, conversation_id, payload_encrypted, attempts
    FROM agent_memory_jobs
    WHERE status = 'pending' AND next_attempt_at <= CURRENT_TIMESTAMP
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const row = rowsFromResult(result)[0];
  if (!row) return null;
  const claim: any = await db.execute(sql`
    UPDATE agent_memory_jobs
    SET status = 'running', attempts = attempts + 1, started_at = CURRENT_TIMESTAMP,
        error_message = NULL
    WHERE id = ${Number(row.id)} AND status = 'pending'
  `);
  if (Number(claim?.[0]?.affectedRows || 0) !== 1) return null;
  return {
    id: Number(row.id),
    idempotencyKey: String(row.idempotency_key || ""),
    userId: Number(row.user_id),
    adoptId: String(row.adopt_id || ""),
    roleTemplate: String(row.role_template || "general-assistant"),
    channel: String(row.channel || "web"),
    sessionId: String(row.session_id || ""),
    requestId: String(row.request_id || ""),
    conversationId: String(row.conversation_id || ""),
    payloadEncrypted: String(row.payload_encrypted || ""),
    attempts: Number(row.attempts || 0) + 1,
  };
}

export async function finishAgentMemoryJob(id: number, status: "done" | "skipped"): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    UPDATE agent_memory_jobs
    SET status = ${status}, payload_encrypted = NULL, completed_at = CURRENT_TIMESTAMP,
        error_message = NULL
    WHERE id = ${id}
  `);
}

export async function failAgentMemoryJob(id: number, attempts: number, message: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  if (attempts >= 3) {
    await db.execute(sql`
      UPDATE agent_memory_jobs
      SET status = 'failed', payload_encrypted = NULL, completed_at = CURRENT_TIMESTAMP,
          error_message = ${message.slice(0, 1000)}
      WHERE id = ${id}
    `);
    return;
  }
  const delaySeconds = Math.min(300, 15 * (2 ** Math.max(0, attempts - 1)));
  const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000);
  await db.execute(sql`
    UPDATE agent_memory_jobs
    SET status = 'pending', next_attempt_at = ${nextAttemptAt},
        error_message = ${message.slice(0, 1000)}
    WHERE id = ${id}
  `);
}

export async function pruneAgentMemoryJobs(retentionDays = 30): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const days = Math.min(Math.max(Math.floor(retentionDays), 7), 365);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await db.execute(sql`
    DELETE FROM agent_memory_jobs
    WHERE status IN ('done', 'skipped', 'failed')
      AND completed_at IS NOT NULL
      AND completed_at < ${cutoff}
  `);
}

export async function getAgentMemoryCursor(sourceKey: string): Promise<{ lastTimestampMs: number; lastFingerprint: string } | null> {
  const db = await getDb();
  if (!db) return null;
  const result: any = await db.execute(sql`
    SELECT last_timestamp_ms, last_fingerprint
    FROM agent_memory_cursors
    WHERE source_key = ${sourceKey}
    LIMIT 1
  `);
  const row = rowsFromResult(result)[0];
  return row ? {
    lastTimestampMs: Number(row.last_timestamp_ms || 0),
    lastFingerprint: String(row.last_fingerprint || ""),
  } : null;
}

export async function upsertAgentMemoryCursor(input: {
  sourceKey: string;
  channel: string;
  lastTimestampMs: number;
  lastFingerprint?: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    INSERT INTO agent_memory_cursors (source_key, channel, last_timestamp_ms, last_fingerprint)
    VALUES (${input.sourceKey}, ${input.channel}, ${input.lastTimestampMs}, ${input.lastFingerprint || null})
    ON DUPLICATE KEY UPDATE
      channel = VALUES(channel),
      last_timestamp_ms = GREATEST(last_timestamp_ms, VALUES(last_timestamp_ms)),
      last_fingerprint = VALUES(last_fingerprint),
      updated_at = CURRENT_TIMESTAMP
  `);
}
