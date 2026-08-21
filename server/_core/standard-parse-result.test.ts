import { describe, expect, it } from "vitest";
import {
  STANDARD_PARSE_RESULT_SCHEMA,
  parseStandardParseResult,
  standardParseResultFingerprint,
} from "../../shared/standard-parse-result";

describe("StandardParseResult V1", () => {
  it("rejects a derived artifact whose fingerprint no longer matches", () => {
    const body = {
      schema: STANDARD_PARSE_RESULT_SCHEMA,
      parserVersion: "2.1",
      contentHash: "a".repeat(64),
      source: { name: "policy.md", extension: "md", sizeBytes: 12 },
      documentText: "第一章 总则",
      segments: [{
        segmentId: "segment-1",
        position: "第一章 总则",
        text: "第一章 总则",
        headingPath: ["第一章 总则"],
        page: null,
        contentType: "text" as const,
      }],
      structure: { segmentCount: 1, sectionCount: 1, tableCount: 0, pageCount: 0 },
      hints: { dates: [], versions: [], effectiveDates: [] },
      diagnostics: [],
    };
    const input = {
      ...body,
      generatedAt: "2026-08-21T00:00:00.000Z",
      parseResultFingerprint: standardParseResultFingerprint(body),
    };
    expect(parseStandardParseResult(input).documentText).toBe("第一章 总则");
    expect(() => parseStandardParseResult({ ...input, documentText: "已被修改" }))
      .toThrow(/fingerprint mismatch/);
  });
});
