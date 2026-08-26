import { createHash } from "node:crypto";
import { desc, eq, or } from "drizzle-orm";
import { getDb } from "../../db";
import { runtimeContextReceipts } from "../../../drizzle/schema";
import {
  isContextReceiptV1,
  type ContextReceiptV1,
} from "../../../shared/context-receipt";
import {
  isContextInteractionGrantV1,
  type ContextInteractionGrantV1,
} from "../../../shared/context-evidence";
import { governanceFingerprint } from "./contracts";

type TrustedReceiptMetadata = {
  eaMetadataIssuer: "employee-agent";
  eaContextReceipt: ContextReceiptV1;
  eaInteractionGrant?: ContextInteractionGrantV1;
};

type StoredReceiptRow = {
  sessionId: string;
  adoptionId: string | null;
  toolName: string;
  resultFingerprint: string;
  trustedMetadataJson: Record<string, unknown>;
  createdAt: Date;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validReceiptFingerprint(receipt: ContextReceiptV1): boolean {
  const { receiptFingerprint, ...body } = receipt;
  return governanceFingerprint(body) === receiptFingerprint;
}

function trustedMetadata(value: unknown): TrustedReceiptMetadata | null {
  const metadata = object(object(value)._meta);
  if (metadata.eaMetadataIssuer !== "employee-agent") return null;
  if (!isContextReceiptV1(metadata.eaContextReceipt)) return null;
  if (!validReceiptFingerprint(metadata.eaContextReceipt)) return null;
  const grant = isContextInteractionGrantV1(metadata.eaInteractionGrant)
    ? metadata.eaInteractionGrant
    : undefined;
  return {
    eaMetadataIssuer: "employee-agent",
    eaContextReceipt: metadata.eaContextReceipt,
    ...(grant ? { eaInteractionGrant: grant } : {}),
  };
}

function visibleResultText(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(item => visibleResultText(item, depth + 1)).filter(Boolean).join("\n").trim();
  }
  if (typeof value !== "object") return "";
  const source = value as Record<string, unknown>;
  for (const key of ["raw_output", "content", "result", "output", "data"]) {
    const text = visibleResultText(source[key], depth + 1);
    if (text) return text;
  }
  if (typeof source.text === "string") return source.text.trim();
  return "";
}

export function contextReceiptResultFingerprint(value: unknown): string | null {
  const text = visibleResultText(value).replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex");
}

function normalizedToolName(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/^mcp_platform_tools_/, "");
}

function selectStoredMetadata(
  rows: StoredReceiptRow[],
  resultFingerprint: string,
  toolName: string,
  eventTime?: number | null,
): TrustedReceiptMetadata | null {
  const matching = rows.filter(row => row.resultFingerprint === resultFingerprint);
  const normalized = normalizedToolName(toolName);
  const eventMs = Number(eventTime || 0);
  const ordered = matching.sort((left, right) => {
    const leftTool = normalizedToolName(left.toolName) === normalized ? 0 : 1;
    const rightTool = normalizedToolName(right.toolName) === normalized ? 0 : 1;
    if (leftTool !== rightTool) return leftTool - rightTool;
    if (eventMs > 0) {
      const leftDistance = Math.abs(left.createdAt.getTime() - eventMs);
      const rightDistance = Math.abs(right.createdAt.getTime() - eventMs);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    }
    return right.createdAt.getTime() - left.createdAt.getTime();
  });
  for (const row of ordered) {
    const metadata = trustedMetadata({ _meta: row.trustedMetadataJson });
    if (metadata) return metadata;
  }
  return null;
}

export async function persistTrustedContextReceiptResult(input: {
  result: unknown;
  sessionId: string;
  adoptionId?: string | null;
  runtimeAgentId?: string | null;
  toolName: string;
}): Promise<boolean> {
  const sessionId = String(input.sessionId || "").trim().slice(0, 128);
  const adoptionId = String(input.adoptionId || "").trim().slice(0, 64);
  const toolName = String(input.toolName || "").trim().slice(0, 128);
  const metadata = trustedMetadata(input.result);
  const resultFingerprint = contextReceiptResultFingerprint(input.result);
  if ((!sessionId && !adoptionId) || !toolName || !metadata || !resultFingerprint) return false;
  const db = await getDb();
  if (!db) return false;
  const receipt = metadata.eaContextReceipt;
  await db.insert(runtimeContextReceipts).values({
    receiptId: receipt.receiptId,
    sessionId,
    adoptionId: adoptionId || null,
    runtimeAgentId: String(input.runtimeAgentId || "").trim().slice(0, 128) || null,
    toolName,
    resultFingerprint,
    receiptFingerprint: receipt.receiptFingerprint,
    trustedMetadataJson: metadata,
  }).onDuplicateKeyUpdate({
    set: {
      sessionId,
      toolName,
      resultFingerprint,
      receiptFingerprint: receipt.receiptFingerprint,
      trustedMetadataJson: metadata,
    },
  });
  return true;
}

async function storedReceiptsForScope(sessionId: string, adoptionId?: string | null): Promise<StoredReceiptRow[]> {
  const normalizedSession = String(sessionId || "").trim().slice(0, 128);
  const normalizedAdoption = String(adoptionId || "").trim().slice(0, 64);
  if (!normalizedSession && !normalizedAdoption) return [];
  const db = await getDb();
  if (!db) return [];
  const predicate = normalizedSession && normalizedAdoption
    ? or(
        eq(runtimeContextReceipts.sessionId, normalizedSession),
        eq(runtimeContextReceipts.adoptionId, normalizedAdoption),
      )
    : normalizedSession
      ? eq(runtimeContextReceipts.sessionId, normalizedSession)
      : eq(runtimeContextReceipts.adoptionId, normalizedAdoption);
  const rows = await db.select({
    sessionId: runtimeContextReceipts.sessionId,
    adoptionId: runtimeContextReceipts.adoptionId,
    toolName: runtimeContextReceipts.toolName,
    resultFingerprint: runtimeContextReceipts.resultFingerprint,
    trustedMetadataJson: runtimeContextReceipts.trustedMetadataJson,
    createdAt: runtimeContextReceipts.createdAt,
  }).from(runtimeContextReceipts)
    .where(predicate)
    .orderBy(desc(runtimeContextReceipts.createdAt))
    .limit(1_000);
  return rows.filter(row => (
    Boolean(normalizedSession && row.sessionId === normalizedSession)
    || Boolean(normalizedAdoption && row.adoptionId === normalizedAdoption)
  ));
}

function toolResultBody(value: unknown): Record<string, unknown> {
  const source = object(value);
  return Object.keys(object(source.tool_result)).length ? object(source.tool_result) : source;
}

function toolNameFromResult(value: unknown): string {
  const source = toolResultBody(value);
  return String(source.name || source.toolName || source.tool_name || source.tool || "").trim();
}

function hasTrustedMetadata(value: unknown): boolean {
  const source = toolResultBody(value);
  return Boolean(trustedMetadata(source.raw_output) || trustedMetadata(source));
}

function attachStoredMetadata(value: Record<string, unknown>, metadata: TrustedReceiptMetadata): Record<string, unknown> {
  const nested = object(value.tool_result);
  const target = Object.keys(nested).length ? nested : value;
  const rawOutput = object(target.raw_output);
  const fallbackResult = target.result ?? target.content ?? target.output ?? "";
  const enriched = {
    ...target,
    raw_output: {
      ...(Object.keys(rawOutput).length ? rawOutput : { result: fallbackResult }),
      _meta: metadata,
    },
  };
  return Object.keys(nested).length ? { ...value, tool_result: enriched } : enriched;
}

export async function restoreTrustedContextReceiptInToolResult(input: {
  payload: Record<string, unknown>;
  sessionId: string;
  adoptionId?: string | null;
  eventTime?: number | null;
}): Promise<Record<string, unknown>> {
  if (hasTrustedMetadata(input.payload)) return input.payload;
  const resultFingerprint = contextReceiptResultFingerprint(toolResultBody(input.payload));
  if (!resultFingerprint) return input.payload;
  const rows = await storedReceiptsForScope(input.sessionId, input.adoptionId);
  const metadata = selectStoredMetadata(rows, resultFingerprint, toolNameFromResult(input.payload), input.eventTime);
  return metadata ? attachStoredMetadata(input.payload, metadata) : input.payload;
}

export async function restoreTrustedContextReceiptsInHistory(
  records: unknown[],
  sessionId: string,
  adoptionId?: string | null,
): Promise<unknown[]> {
  const rows = await storedReceiptsForScope(sessionId, adoptionId);
  if (!rows.length) return records;
  return records.map(record => {
    const source = object(record);
    const eventType = String(source.event_type || source.type || "").toLowerCase();
    if (eventType !== "chat.tool_result" || hasTrustedMetadata(source)) return record;
    const resultFingerprint = contextReceiptResultFingerprint(toolResultBody(source));
    if (!resultFingerprint) return record;
    const rawTime = source.timestamp ?? source.ts ?? source.created_at ?? source.createdAt ?? source.event_time;
    const parsedTime = typeof rawTime === "number"
      ? (rawTime < 10_000_000_000 ? rawTime * 1_000 : rawTime)
      : Date.parse(String(rawTime || ""));
    const metadata = selectStoredMetadata(
      rows,
      resultFingerprint,
      toolNameFromResult(source),
      Number.isFinite(parsedTime) ? parsedTime : null,
    );
    return metadata ? attachStoredMetadata(source, metadata) : record;
  });
}
