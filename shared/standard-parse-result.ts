import { createHash } from "node:crypto";
import { z } from "zod";

export const STANDARD_PARSE_RESULT_SCHEMA = "ea.standard-parse-result.v1" as const;

const parseSegmentSchema = z.object({
  segmentId: z.string().min(1).max(128),
  position: z.string().min(1).max(500),
  text: z.string().max(2_000_000),
  headingPath: z.array(z.string().max(160)).max(12),
  page: z.number().int().positive().nullable(),
  contentType: z.enum(["text", "table"]),
});

const parseHintSchema = z.object({
  value: z.string().min(1).max(160),
  evidence: z.string().min(1).max(500),
  position: z.string().min(1).max(500),
});

export const standardParseResultSchema = z.object({
  schema: z.literal(STANDARD_PARSE_RESULT_SCHEMA),
  parserVersion: z.string().min(1).max(32),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime(),
  source: z.object({
    name: z.string().min(1).max(240),
    extension: z.string().max(16),
    sizeBytes: z.number().int().nonnegative(),
  }),
  documentText: z.string().max(2_000_000),
  segments: z.array(parseSegmentSchema).max(20_000),
  structure: z.object({
    segmentCount: z.number().int().nonnegative(),
    sectionCount: z.number().int().nonnegative(),
    tableCount: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
  }),
  hints: z.object({
    dates: z.array(parseHintSchema).max(128),
    versions: z.array(parseHintSchema).max(64),
    effectiveDates: z.array(parseHintSchema).max(32),
  }),
  diagnostics: z.array(z.object({
    code: z.string().min(1).max(64),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1).max(1000),
    position: z.string().min(1).max(500).nullable(),
  })).max(256),
  parseResultFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((value, ctx) => {
  if (value.structure.segmentCount !== value.segments.length) {
    ctx.addIssue({ code: "custom", path: ["structure", "segmentCount"], message: "segmentCount 与 segments 数量不一致" });
  }
});

export type StandardParseResultV1 = z.infer<typeof standardParseResultSchema>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce((result, key) => {
    result[key] = canonicalValue((value as Record<string, unknown>)[key]);
    return result;
  }, {} as Record<string, unknown>);
}

export function standardParseResultFingerprint(value: Omit<StandardParseResultV1, "parseResultFingerprint" | "generatedAt">): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

export function parseStandardParseResult(input: unknown): StandardParseResultV1 {
  const parsed = standardParseResultSchema.parse(input);
  const { parseResultFingerprint, generatedAt: _generatedAt, ...fingerprintBody } = parsed;
  if (standardParseResultFingerprint(fingerprintBody) !== parseResultFingerprint) {
    throw new Error("StandardParseResult fingerprint mismatch");
  }
  return parsed;
}
