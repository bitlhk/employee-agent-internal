import { describe, expect, it } from "vitest";
import {
  parseReleaseEvidence,
  parseRestoreDrillEvidence,
} from "./operational-evidence";

describe("operational evidence", () => {
  it("keeps only bounded release events inside the reporting window", () => {
    const nowMs = Date.parse("2026-07-30T06:00:00Z");
    const rows = parseReleaseEvidence([
      '{"time":"2026-07-29T06:00:00Z","action":"deploy","result":"success"}',
      '{"time":"2026-07-28T06:00:00Z","action":"rollback","result":"failed"}',
      '{"time":"2025-01-01T00:00:00Z","action":"deploy","result":"success"}',
      '{"time":"2026-07-29T06:00:00Z","action":"unknown","result":"success"}',
      "invalid-json",
    ].join("\n"), { nowMs });

    expect(rows).toEqual([
      { action: "deploy", result: "success", timestampSeconds: Date.parse("2026-07-29T06:00:00Z") / 1_000 },
      { action: "rollback", result: "failed", timestampSeconds: Date.parse("2026-07-28T06:00:00Z") / 1_000 },
    ]);
  });

  it("parses only successful restore reports with valid RPO and RTO", () => {
    expect(parseRestoreDrillEvidence([
      "result=passed",
      "rpo_seconds=3600",
      "rto_seconds=298",
    ].join("\n"))).toEqual({ rpoSeconds: 3600, rtoSeconds: 298 });

    expect(parseRestoreDrillEvidence("result=failed\nrpo_seconds=1\nrto_seconds=1")).toBeNull();
    expect(parseRestoreDrillEvidence("result=passed\nrpo_seconds=-1\nrto_seconds=1")).toBeNull();
  });
});
