import { sql } from "drizzle-orm";
import {
  MESSAGE_FEEDBACK_REASON_CODES,
  type MessageFeedbackRating,
  type MessageFeedbackReasonCode,
} from "../../shared/message-feedback";
import { getDb } from "./connection";

export type MessageFeedbackToolSummary = {
  name: string;
  status: "running" | "done" | "error";
  durationMs?: number;
};

export type UpsertMessageFeedbackInput = {
  userId: number;
  adoptId: string;
  conversationId: string;
  messageId: string;
  rating: MessageFeedbackRating;
  reasonCodes: MessageFeedbackReasonCode[];
  comment?: string;
  roleTemplate?: string;
  runtimeType?: string;
  selectedModelId?: string;
  actualModelId?: string;
  skillIds: string[];
  tools: MessageFeedbackToolSummary[];
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
};

let ensurePromise: Promise<void> | null = null;

async function ensureMessageFeedbackTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS message_feedback (
          id bigint NOT NULL AUTO_INCREMENT,
          user_id int NOT NULL,
          adopt_id varchar(64) NOT NULL,
          conversation_id varchar(128) NOT NULL,
          message_id varchar(128) NOT NULL,
          rating enum('positive','negative') NOT NULL,
          reason_codes_json text DEFAULT NULL,
          comment varchar(500) DEFAULT NULL,
          role_template varchar(64) DEFAULT NULL,
          runtime_type varchar(32) DEFAULT NULL,
          selected_model_id varchar(200) DEFAULT NULL,
          actual_model_id varchar(200) DEFAULT NULL,
          skill_ids_json text DEFAULT NULL,
          tool_summary_json text DEFAULT NULL,
          input_tokens int DEFAULT NULL,
          output_tokens int DEFAULT NULL,
          duration_ms int DEFAULT NULL,
          created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uk_message_feedback_message (user_id, adopt_id, conversation_id, message_id),
          KEY idx_message_feedback_rating_created (rating, created_at),
          KEY idx_message_feedback_adopt_created (adopt_id, created_at),
          KEY idx_message_feedback_model_rating (actual_model_id, rating)
        )
      `);
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}

function rowsFromResult(result: unknown): any[] {
  return Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : [];
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function parseMessageFeedbackReasonCodes(value: unknown): MessageFeedbackReasonCode[] {
  const allowed = new Set<string>(MESSAGE_FEEDBACK_REASON_CODES);
  return parseStringArray(value).filter((code): code is MessageFeedbackReasonCode => allowed.has(code));
}

function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export async function upsertMessageFeedback(input: UpsertMessageFeedbackInput): Promise<void> {
  await ensureMessageFeedbackTable();
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    INSERT INTO message_feedback (
      user_id, adopt_id, conversation_id, message_id, rating, reason_codes_json, comment,
      role_template, runtime_type, selected_model_id, actual_model_id, skill_ids_json,
      tool_summary_json, input_tokens, output_tokens, duration_ms
    ) VALUES (
      ${input.userId}, ${input.adoptId}, ${input.conversationId}, ${input.messageId}, ${input.rating},
      ${JSON.stringify(input.reasonCodes)}, ${input.comment || null}, ${input.roleTemplate || null},
      ${input.runtimeType || null}, ${input.selectedModelId || null}, ${input.actualModelId || null},
      ${JSON.stringify(input.skillIds)}, ${JSON.stringify(input.tools)}, ${input.inputTokens ?? null},
      ${input.outputTokens ?? null}, ${input.durationMs ?? null}
    )
    ON DUPLICATE KEY UPDATE
      rating = VALUES(rating),
      reason_codes_json = VALUES(reason_codes_json),
      comment = VALUES(comment),
      role_template = VALUES(role_template),
      runtime_type = VALUES(runtime_type),
      selected_model_id = VALUES(selected_model_id),
      actual_model_id = VALUES(actual_model_id),
      skill_ids_json = VALUES(skill_ids_json),
      tool_summary_json = VALUES(tool_summary_json),
      input_tokens = VALUES(input_tokens),
      output_tokens = VALUES(output_tokens),
      duration_ms = VALUES(duration_ms),
      updated_at = CURRENT_TIMESTAMP
  `);
}

export async function deleteMessageFeedback(
  userId: number,
  adoptId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await ensureMessageFeedbackTable();
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    DELETE FROM message_feedback
    WHERE user_id = ${userId}
      AND adopt_id = ${adoptId}
      AND conversation_id = ${conversationId}
      AND message_id = ${messageId}
  `);
}

export async function listMessageFeedbackForConversation(
  userId: number,
  adoptId: string,
  conversationId: string,
) {
  await ensureMessageFeedbackTable();
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result: any = await db.execute(sql`
    SELECT message_id, rating, reason_codes_json, comment, updated_at
    FROM message_feedback
    WHERE user_id = ${userId}
      AND adopt_id = ${adoptId}
      AND conversation_id = ${conversationId}
    ORDER BY updated_at ASC
  `);
  return rowsFromResult(result).map((row) => ({
    messageId: String(row.message_id || ""),
    rating: String(row.rating || "") as MessageFeedbackRating,
    reasonCodes: parseMessageFeedbackReasonCodes(row.reason_codes_json),
    comment: String(row.comment || ""),
    updatedAt: isoDate(row.updated_at),
  }));
}

export async function getMessageFeedbackAdminSummary(options: { days: number; limit: number }) {
  await ensureMessageFeedbackTable();
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const cutoff = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);

  const totalsResult: any = await db.execute(sql`
    SELECT
      COUNT(*) AS total,
      SUM(rating = 'positive') AS positive,
      SUM(rating = 'negative') AS negative
    FROM message_feedback
    WHERE updated_at >= ${cutoff}
  `);
  const totals = rowsFromResult(totalsResult)[0] || {};
  const positive = Number(totals.positive || 0);
  const negative = Number(totals.negative || 0);
  const total = Number(totals.total || 0);

  const negativeReasonResult: any = await db.execute(sql`
    SELECT reason_codes_json
    FROM message_feedback
    WHERE rating = 'negative' AND updated_at >= ${cutoff}
  `);
  const reasonCountMap = new Map<MessageFeedbackReasonCode, number>();
  for (const row of rowsFromResult(negativeReasonResult)) {
    for (const reason of parseMessageFeedbackReasonCodes(row.reason_codes_json)) {
      reasonCountMap.set(reason, (reasonCountMap.get(reason) || 0) + 1);
    }
  }

  const modelResult: any = await db.execute(sql`
    SELECT
      COALESCE(NULLIF(actual_model_id, ''), NULLIF(selected_model_id, ''), '未记录') AS model_id,
      COUNT(*) AS total,
      SUM(rating = 'positive') AS positive,
      SUM(rating = 'negative') AS negative
    FROM message_feedback
    WHERE updated_at >= ${cutoff}
    GROUP BY COALESCE(NULLIF(actual_model_id, ''), NULLIF(selected_model_id, ''), '未记录')
    ORDER BY total DESC
    LIMIT 20
  `);
  const roleResult: any = await db.execute(sql`
    SELECT
      COALESCE(NULLIF(role_template, ''), '未记录') AS role_template,
      COUNT(*) AS total,
      SUM(rating = 'positive') AS positive,
      SUM(rating = 'negative') AS negative
    FROM message_feedback
    WHERE updated_at >= ${cutoff}
    GROUP BY COALESCE(NULLIF(role_template, ''), '未记录')
    ORDER BY total DESC
    LIMIT 20
  `);
  const recentResult: any = await db.execute(sql`
    SELECT adopt_id, role_template, runtime_type, selected_model_id, actual_model_id,
      reason_codes_json, comment, skill_ids_json, tool_summary_json,
      input_tokens, output_tokens, duration_ms, updated_at
    FROM message_feedback
    WHERE rating = 'negative' AND updated_at >= ${cutoff}
    ORDER BY updated_at DESC
    LIMIT ${options.limit}
  `);

  const mapBreakdown = (rows: any[], key: string) => rows.map((row) => {
    const rowTotal = Number(row.total || 0);
    const rowPositive = Number(row.positive || 0);
    return {
      key: String(row[key] || "未记录"),
      total: rowTotal,
      positive: rowPositive,
      negative: Number(row.negative || 0),
      satisfactionRate: rowTotal > 0 ? Math.round((rowPositive / rowTotal) * 1000) / 10 : 0,
    };
  });

  return {
    periodDays: options.days,
    summary: {
      total,
      positive,
      negative,
      satisfactionRate: total > 0 ? Math.round((positive / total) * 1000) / 10 : 0,
    },
    reasonCounts: Array.from(reasonCountMap, ([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    byModel: mapBreakdown(rowsFromResult(modelResult), "model_id"),
    byRole: mapBreakdown(rowsFromResult(roleResult), "role_template"),
    recentNegative: rowsFromResult(recentResult).map((row) => ({
      adoptId: String(row.adopt_id || ""),
      roleTemplate: String(row.role_template || ""),
      runtimeType: String(row.runtime_type || ""),
      selectedModelId: String(row.selected_model_id || ""),
      actualModelId: String(row.actual_model_id || ""),
      reasonCodes: parseMessageFeedbackReasonCodes(row.reason_codes_json),
      comment: String(row.comment || ""),
      skillIds: parseStringArray(row.skill_ids_json),
      tools: (() => {
        try {
          const parsed = JSON.parse(String(row.tool_summary_json || "[]"));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
      inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      updatedAt: isoDate(row.updated_at),
    })),
  };
}
