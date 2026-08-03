import { sql } from "drizzle-orm";
import { getDb } from "./connection";
import type { AgentMemoryKind, AgentMemorySource } from "./agent-memory";

export type AgentMemoryConflictStatus = "pending" | "accepted" | "rejected";

export type AgentMemoryConflictRecord = {
  id: number;
  memoryId: number;
  userId: number;
  adoptId: string;
  proposedKind: AgentMemoryKind;
  proposedContent: string;
  proposedHash: string;
  proposedSource: AgentMemorySource;
  proposedConfidence: number;
  evidenceCount: number;
  status: AgentMemoryConflictStatus;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  latestSnippet: string | null;
  latestChannel: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowsFromResult(result: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : [];
  return rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
}

function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  if (!header || typeof header !== "object" || !("affectedRows" in header)) return 0;
  return Number((header as { affectedRows?: unknown }).affectedRows || 0);
}

function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapMemoryConflict(row: Record<string, unknown>): AgentMemoryConflictRecord {
  return {
    id: Number(row.id),
    memoryId: Number(row.memory_id),
    userId: Number(row.user_id),
    adoptId: String(row.adopt_id || ""),
    proposedKind: String(row.proposed_kind || "preference") as AgentMemoryKind,
    proposedContent: String(row.proposed_content || ""),
    proposedHash: String(row.proposed_hash || ""),
    proposedSource: String(row.proposed_source || "automatic") as AgentMemorySource,
    proposedConfidence: Number(row.proposed_confidence || 0),
    evidenceCount: Number(row.evidence_count || 0),
    status: String(row.status || "pending") as AgentMemoryConflictStatus,
    firstObservedAt: isoDate(row.first_observed_at) || new Date(0).toISOString(),
    lastObservedAt: isoDate(row.last_observed_at) || new Date(0).toISOString(),
    resolvedAt: isoDate(row.resolved_at),
    latestSnippet: row.latest_snippet ? String(row.latest_snippet) : null,
    latestChannel: row.latest_channel ? String(row.latest_channel) : null,
    createdAt: isoDate(row.created_at) || new Date(0).toISOString(),
    updatedAt: isoDate(row.updated_at) || new Date(0).toISOString(),
  };
}

export async function observeAgentMemoryConflict(input: {
  memoryId: number;
  userId: number;
  adoptId: string;
  proposedKind: AgentMemoryKind;
  proposedContent: string;
  proposedHash: string;
  proposedSource: AgentMemorySource;
  proposedConfidence: number;
}): Promise<AgentMemoryConflictRecord> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.transaction(async (tx) => {
    const memoryResult = await tx.execute(sql`
      SELECT id FROM agent_memory_items
      WHERE id = ${input.memoryId} AND user_id = ${input.userId} AND adopt_id = ${input.adoptId}
      FOR UPDATE
    `);
    if (!rowsFromResult(memoryResult)[0]) throw new Error("memory not found");
    const existingResult = await tx.execute(sql`
      SELECT conflict.*, NULL AS latest_snippet, NULL AS latest_channel
      FROM agent_memory_conflicts conflict
      WHERE conflict.memory_id = ${input.memoryId}
        AND conflict.proposed_hash = ${input.proposedHash}
        AND conflict.status = 'pending'
      ORDER BY conflict.id DESC LIMIT 1 FOR UPDATE
    `);
    const existing = rowsFromResult(existingResult)[0];
    if (existing) {
      await tx.execute(sql`
        UPDATE agent_memory_conflicts
        SET proposed_kind = ${input.proposedKind}, proposed_content = ${input.proposedContent},
            proposed_source = ${input.proposedSource},
            proposed_confidence = GREATEST(proposed_confidence, ${input.proposedConfidence}),
            last_observed_at = CURRENT_TIMESTAMP
        WHERE id = ${Number(existing.id)}
      `);
      return mapMemoryConflict({
        ...existing,
        proposed_kind: input.proposedKind,
        proposed_content: input.proposedContent,
        proposed_source: input.proposedSource,
        proposed_confidence: Math.max(Number(existing.proposed_confidence || 0), input.proposedConfidence),
      });
    }
    await tx.execute(sql`
      INSERT INTO agent_memory_conflicts (
        memory_id, user_id, adopt_id, proposed_kind, proposed_content, proposed_hash,
        proposed_source, proposed_confidence
      ) VALUES (
        ${input.memoryId}, ${input.userId}, ${input.adoptId}, ${input.proposedKind},
        ${input.proposedContent}, ${input.proposedHash}, ${input.proposedSource}, ${input.proposedConfidence}
      )
    `);
    const insertedResult = await tx.execute(sql`
      SELECT conflict.*, NULL AS latest_snippet, NULL AS latest_channel
      FROM agent_memory_conflicts conflict WHERE conflict.id = LAST_INSERT_ID() LIMIT 1
    `);
    const inserted = rowsFromResult(insertedResult)[0];
    if (!inserted) throw new Error("memory conflict insert failed");
    return mapMemoryConflict(inserted);
  });
}

export async function listAgentMemoryConflicts(input: {
  userId: number;
  adoptId: string;
  statuses?: AgentMemoryConflictStatus[];
  limit?: number;
}): Promise<AgentMemoryConflictRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const statuses = input.statuses?.length ? input.statuses : ["pending"];
  const limit = Math.max(1, Math.min(Number(input.limit || 100), 300));
  const result = await db.execute(sql`
    SELECT conflict.*,
      (SELECT evidence.snippet FROM agent_memory_evidence evidence
       WHERE evidence.conflict_id = conflict.id ORDER BY evidence.observed_at DESC, evidence.id DESC LIMIT 1) AS latest_snippet,
      (SELECT evidence.channel FROM agent_memory_evidence evidence
       WHERE evidence.conflict_id = conflict.id ORDER BY evidence.observed_at DESC, evidence.id DESC LIMIT 1) AS latest_channel
    FROM agent_memory_conflicts conflict
    JOIN agent_memory_items item ON item.id = conflict.memory_id
    WHERE conflict.user_id = ${input.userId} AND conflict.adopt_id = ${input.adoptId}
      AND conflict.status IN (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})
      AND item.status IN ('active', 'candidate')
    ORDER BY conflict.last_observed_at DESC, conflict.id DESC LIMIT ${limit}
  `);
  return rowsFromResult(result).map(mapMemoryConflict);
}

export async function acceptAgentMemoryConflictRecord(input: {
  conflictId: number;
  memoryId: number;
  userId: number;
  adoptId: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async (tx) => {
    const conflictResult = await tx.execute(sql`
      SELECT * FROM agent_memory_conflicts
      WHERE id = ${input.conflictId} AND memory_id = ${input.memoryId}
        AND user_id = ${input.userId} AND adopt_id = ${input.adoptId} FOR UPDATE
    `);
    const conflict = rowsFromResult(conflictResult)[0];
    if (!conflict || conflict.status !== "pending") throw new Error("待确认的记忆变化不存在");
    const memoryResult = await tx.execute(sql`
      SELECT id, user_id, adopt_id, kind, content, source, confidence, version, created_at
      FROM agent_memory_items
      WHERE id = ${input.memoryId} AND user_id = ${input.userId} AND adopt_id = ${input.adoptId} FOR UPDATE
    `);
    const current = rowsFromResult(memoryResult)[0];
    if (!current) throw new Error("memory not found");
    const proposedContent = String(conflict.proposed_content || "");
    const proposedKind = String(conflict.proposed_kind || current.kind) as AgentMemoryKind;
    if (String(current.content) !== proposedContent || String(current.kind) !== proposedKind) {
      await tx.execute(sql`
        INSERT IGNORE INTO agent_memory_versions (
          memory_id, user_id, adopt_id, version, kind, content, source, confidence, change_type, valid_from
        ) VALUES (
          ${input.memoryId}, ${input.userId}, ${input.adoptId}, ${Number(current.version || 1)}, ${current.kind},
          ${current.content}, ${current.source}, ${Number(current.confidence || 0)}, 'created', ${new Date(String(current.created_at))}
        )
      `);
      await tx.execute(sql`
        UPDATE agent_memory_versions SET valid_to = CURRENT_TIMESTAMP
        WHERE memory_id = ${input.memoryId} AND version = ${Number(current.version || 1)} AND valid_to IS NULL
      `);
      const nextVersion = Number(current.version || 1) + 1;
      await tx.execute(sql`
        UPDATE agent_memory_items
        SET kind = ${proposedKind}, content = ${proposedContent}, status = 'active', source = 'feedback',
            confidence = 100, version = ${nextVersion}, last_observed_at = CURRENT_TIMESTAMP
        WHERE id = ${input.memoryId} AND user_id = ${input.userId} AND adopt_id = ${input.adoptId}
      `);
      await tx.execute(sql`
        INSERT INTO agent_memory_versions (
          memory_id, user_id, adopt_id, version, kind, content, source, confidence, change_type, valid_from
        ) VALUES (
          ${input.memoryId}, ${input.userId}, ${input.adoptId}, ${nextVersion}, ${proposedKind},
          ${proposedContent}, 'feedback', 100, 'edited', CURRENT_TIMESTAMP
        )
      `);
    }
    await tx.execute(sql`
      UPDATE agent_memory_evidence SET conflict_id = NULL
      WHERE conflict_id = ${input.conflictId} AND memory_id = ${input.memoryId}
    `);
    const countResult = await tx.execute(sql`
      SELECT COUNT(DISTINCT COALESCE(NULLIF(session_id, ''), source_hash)) AS evidence_count
      FROM agent_memory_evidence WHERE memory_id = ${input.memoryId} AND conflict_id IS NULL
    `);
    await tx.execute(sql`
      UPDATE agent_memory_items SET evidence_count = ${Number(rowsFromResult(countResult)[0]?.evidence_count || 0)}
      WHERE id = ${input.memoryId}
    `);
    await tx.execute(sql`
      UPDATE agent_memory_conflicts
      SET status = CASE WHEN id = ${input.conflictId} THEN 'accepted' ELSE 'rejected' END,
          resolved_at = CURRENT_TIMESTAMP
      WHERE memory_id = ${input.memoryId} AND status = 'pending'
    `);
  });
}

export async function rejectAgentMemoryConflictRecord(input: {
  conflictId: number;
  memoryId: number;
  userId: number;
  adoptId: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.execute(sql`
    UPDATE agent_memory_conflicts SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP
    WHERE id = ${input.conflictId} AND memory_id = ${input.memoryId}
      AND user_id = ${input.userId} AND adopt_id = ${input.adoptId} AND status = 'pending'
  `);
  if (affectedRows(result) !== 1) throw new Error("待确认的记忆变化不存在");
}
