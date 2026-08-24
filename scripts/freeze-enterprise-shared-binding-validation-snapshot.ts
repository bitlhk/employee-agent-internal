import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  freezeSharedBindingValidationSnapshot,
} from "../server/_core/context-resolution/shared-binding-validation-snapshot";
import { listContextSourceBindingContracts } from "../server/db/context-source-bindings";
import { closeDbConnection } from "../server/db/connection";
import { latestVerifiedRolePackReleases } from "../server/db/role-pack-releases";

const SNAPSHOT_PATH =
  "examples/insurance-advisor-reference-role-pack/eval/shared-binding-validation-snapshot.v1.json";
const ROLE_PACK_IDS = [
  "linggan-bank.wealth-manager",
  "linggan-insurance.insurance-advisor",
];
const TARGET_IDS = [
  "customer_profile",
  "customer_relationship_memory",
  "governed_work_state",
];
const PROVIDER_FILES = [
  "shared/customer-profile-contract.ts",
  "server/_core/customer-profile-source-adapters.ts",
  "server/_core/customer-profile-compatibility-adapter.ts",
  "server/_core/customer-profile-demo-facts.ts",
  "server/_core/customer-profile-provider.ts",
  "server/_core/customer-profile-mcp.ts",
  "shared/memory-purpose.ts",
  "server/_core/agent-memory-retrieval.ts",
  "server/_core/context-resolution/governed-memory-provider.ts",
  "server/_core/governed-work-continuity.ts",
];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const organizationId = String(
    process.env.EA_DEMO_ORGANIZATION_ID || "org_linggan_finance",
  ).trim();
  const bindings = (
    await listContextSourceBindingContracts({
      organizationId,
      rolePackId: "linggan-insurance.insurance-advisor",
      stage: "shadow",
    })
  )
    .filter(binding => TARGET_IDS.includes(binding.logicalAssetId))
    .filter(binding => binding.status === "active");
  if (bindings.length !== TARGET_IDS.length)
    throw new Error("Shared Shadow Binding set is incomplete");
  const releases = await latestVerifiedRolePackReleases(ROLE_PACK_IDS);
  if (releases.length !== ROLE_PACK_IDS.length)
    throw new Error("Verified wealth and insurance Role Pack releases are required");
  const snapshot = freezeSharedBindingValidationSnapshot({
    schema: "ea.shared-binding-validation-snapshot.v1",
    organizationId,
    stage: "shadow",
    providerContractFingerprint: sha256(
      PROVIDER_FILES.map(file => `${file}:${sha256(readFileSync(file))}`).join("\n"),
    ),
    bindings,
    rolePackReleases: releases.map(release => ({
      releaseId: release.releaseId,
      rolePackId: release.rolePackId,
      verificationLevel: release.verificationLevel,
      assetSetFingerprint: release.assetSetFingerprint,
      verifiedAt: null,
    })),
    plans: [
      {
        rolePackId: "linggan-bank.wealth-manager",
        planId: "linggan-bank.wealth-manager.shared-shadow.environment",
        planVersion: "1.0.0",
      },
      {
        rolePackId: "linggan-insurance.insurance-advisor",
        planId: "linggan-insurance.insurance-advisor.IA-GT-01.context",
        planVersion: "1.0.0",
      },
    ],
  });
  if (process.argv.includes("--apply"))
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  return {
    mode: process.argv.includes("--apply") ? "apply" : "dry-run",
    snapshotPath: SNAPSHOT_PATH,
    snapshotFingerprint: snapshot.snapshotFingerprint,
    organizationId,
    bindings: bindings.map(binding => binding.bindingId),
    releases: releases.map(release => release.releaseId),
  };
}

main()
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
