import { sql } from "drizzle-orm";
import { getDb } from "./connection";

export type AgentMemoryMode = "learn_and_use" | "use_only" | "off";
export type AgentMemoryKind = "preference" | "instruction" | "entity" | "procedure";
export type AgentMemoryStatus = "candidate" | "active" | "superseded" | "forgotten" | "rejected" | "expired";
export type AgentMemorySource = "explicit" | "automatic" | "feedback" | "legacy";

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
  if (input.status) {
    await db.execute(sql`
      UPDATE agent_memory_items
      SET content = ${input.content}, kind = ${input.kind}, source = ${input.source},
          confidence = GREATEST(confidence, ${input.confidence}), status = ${input.status},
          expires_at = ${input.expiresAt || null}, last_observed_at = CURRENT_TIMESTAMP,
          version = version + 1
      WHERE id = ${input.id}
    `);
  } else {
    await db.execute(sql`
      UPDATE agent_memory_items
      SET content = ${input.content}, kind = ${input.kind}, source = ${input.source},
          confidence = GREATEST(confidence, ${input.confidence}),
          expires_at = COALESCE(${input.expiresAt || null}, expires_at),
          last_observed_at = CURRENT_TIMESTAMP
      WHERE id = ${input.id}
    `);
  }
}

export async function addAgentMemoryEvidence(input: {
  memoryId: number;
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
      memory_id, user_id, adopt_id, source_type, channel, session_id, request_id,
      conversation_id, message_id, source_hash, snippet, metadata_json
    ) VALUES (
      ${input.memoryId}, ${input.userId}, ${input.adoptId}, ${input.sourceType}, ${input.channel},
      ${input.sessionId || null}, ${input.requestId || null}, ${input.conversationId || null},
      ${input.messageId || null}, ${input.sourceHash}, ${input.snippet || null},
      ${input.metadata ? JSON.stringify(input.metadata) : null}
    )
  `);
  const countResult: any = await db.execute(sql`
    SELECT COUNT(DISTINCT COALESCE(NULLIF(session_id, ''), source_hash)) AS evidence_count
    FROM agent_memory_evidence
    WHERE memory_id = ${input.memoryId}
  `);
  const count = Number(rowsFromResult(countResult)[0]?.evidence_count || 0);
  await db.execute(sql`
    UPDATE agent_memory_items
    SET evidence_count = ${count}, last_observed_at = CURRENT_TIMESTAMP
    WHERE id = ${input.memoryId}
  `);
  return count;
}

export async function setAgentMemoryStatus(id: number, userId: number, adoptId: string, status: AgentMemoryStatus): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE agent_memory_items
    SET status = ${status}, version = version + 1
    WHERE id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
  `);
}

export async function forgetAgentMemoryRecord(id: number, userId: number, adoptId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE agent_memory_items
      SET status = 'forgotten', content = '[已忘记]', version = version + 1,
          last_observed_at = CURRENT_TIMESTAMP
      WHERE id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
    `);
    await tx.execute(sql`
      UPDATE agent_memory_evidence
      SET snippet = NULL
      WHERE memory_id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
    `);
  });
}

export async function updateAgentMemoryContent(id: number, userId: number, adoptId: string, content: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    UPDATE agent_memory_items
    SET content = ${content}, status = 'active', source = 'explicit', confidence = 100,
        version = version + 1, last_observed_at = CURRENT_TIMESTAMP
    WHERE id = ${id} AND user_id = ${userId} AND adopt_id = ${adoptId}
  `);
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
        item.version = item.version + 1
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
    SET item.status = 'rejected', item.version = item.version + 1
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
