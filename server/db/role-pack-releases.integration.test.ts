import "dotenv/config";
import { randomUUID } from "node:crypto";
import mysql, { type Pool } from "mysql2/promise";
import { afterAll, describe, expect, it } from "vitest";
import { closeDbConnection } from "./connection";
import { persistRolePackRelease, resolveRolePackReleaseEvidence } from "./role-pack-releases";

const suite = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const rolePackId = `test.role-pack.${suffix}`;
let pool: Pool;

suite("Role Pack release evidence persistence", () => {
  afterAll(async () => {
    if (pool) await pool.query("DELETE FROM role_pack_releases WHERE role_pack_id = ?", [rolePackId]);
    await closeDbConnection();
    await pool?.end();
  });

  it("marks an old verified asset set stale when a new set is verified", async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 1 });
    const firstFingerprint = "1".repeat(64);
    const secondFingerprint = "2".repeat(64);
    await persistRolePackRelease({
      releaseId: `${rolePackId}@first`, rolePackId, evalSuiteVersion: "v1",
      assetSetFingerprint: firstFingerprint, verificationLevel: "controlled_scenario", status: "verified",
      contractReport: { status: "PASS" }, scenarioReport: { status: "PASS" },
    });
    expect(await resolveRolePackReleaseEvidence({ rolePackId, evalSuiteVersion: "v1", assetSetFingerprint: firstFingerprint }))
      .toMatchObject({ verificationStatus: "verified", verificationLevel: "controlled_scenario" });

    await persistRolePackRelease({
      releaseId: `${rolePackId}@second`, rolePackId, evalSuiteVersion: "v1",
      assetSetFingerprint: secondFingerprint, verificationLevel: "model_scenario", status: "verified",
      contractReport: { status: "PASS" }, scenarioReport: { status: "PASS" },
    });
    expect(await resolveRolePackReleaseEvidence({ rolePackId, evalSuiteVersion: "v1", assetSetFingerprint: firstFingerprint }))
      .toMatchObject({ rolePackReleaseId: `${rolePackId}@first`, verificationStatus: "stale" });
    expect(await resolveRolePackReleaseEvidence({ rolePackId, evalSuiteVersion: "v1", assetSetFingerprint: secondFingerprint }))
      .toMatchObject({ rolePackReleaseId: `${rolePackId}@second`, verificationStatus: "verified", verificationLevel: "model_scenario" });

    await persistRolePackRelease({
      releaseId: `${rolePackId}@second`, rolePackId, evalSuiteVersion: "v1",
      assetSetFingerprint: secondFingerprint, verificationLevel: "controlled_scenario", status: "verified",
      contractReport: { status: "PASS" }, scenarioReport: { executionLevel: "controlled_scenario" },
    });
    expect(await resolveRolePackReleaseEvidence({ rolePackId, evalSuiteVersion: "v1", assetSetFingerprint: secondFingerprint }))
      .toMatchObject({ verificationStatus: "verified", verificationLevel: "model_scenario" });

    await persistRolePackRelease({
      releaseId: `${rolePackId}@first`, rolePackId, evalSuiteVersion: "v1",
      assetSetFingerprint: firstFingerprint, verificationLevel: "model_scenario", status: "verified",
      contractReport: { status: "PASS", operation: "rollback" },
      scenarioReport: { status: "PASS", operation: "rollback" },
    });
    expect(await resolveRolePackReleaseEvidence({ rolePackId, evalSuiteVersion: "v1", assetSetFingerprint: firstFingerprint }))
      .toMatchObject({ verificationStatus: "verified", verificationLevel: "model_scenario" });
    expect(await resolveRolePackReleaseEvidence({ rolePackId, evalSuiteVersion: "v1", assetSetFingerprint: secondFingerprint }))
      .toMatchObject({ verificationStatus: "stale" });
  });
});
