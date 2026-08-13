import { resolveRolePackReleaseEvidence } from "../db/role-pack-releases";
import type { ReadinessCheck, ReleaseEvidenceRef } from "./governance/task-execution-envelope";
import { readinessCheck } from "./governance/wealth-task-readiness";
import { runWealthRolePackContractChecks, WEALTH_EVAL_SUITE_VERSION } from "./reference-role-pack-contracts";

const ROLE_PACK_ID = "linggan-bank.wealth-manager";

export async function resolveWealthRolePackReleaseEvidence(): Promise<ReleaseEvidenceRef> {
  const contract = runWealthRolePackContractChecks();
  try {
    return await resolveRolePackReleaseEvidence({
      rolePackId: ROLE_PACK_ID,
      evalSuiteVersion: WEALTH_EVAL_SUITE_VERSION,
      assetSetFingerprint: contract.assetSetFingerprint,
    });
  } catch {
    return {
      rolePackReleaseId: contract.releaseCandidateId,
      evalSuiteVersion: WEALTH_EVAL_SUITE_VERSION,
      verificationStatus: "unverified",
      verificationLevel: "contract",
      assetSetFingerprint: contract.assetSetFingerprint,
    };
  }
}

export function wealthRolePackReleaseReadiness(evidence: ReleaseEvidenceRef): ReadinessCheck {
  if (evidence.verificationStatus === "verified") {
    return readinessCheck(
      "READY",
      evidence.verificationLevel === "model_scenario" ? "ROLE_PACK_MODEL_VERIFIED" : "ROLE_PACK_CONTROLLED_VERIFIED",
      evidence.verificationLevel === "model_scenario"
        ? "当前岗位资产组合已通过模型场景验收。"
        : "当前岗位资产组合已通过受控治理场景验收。",
      { asOf: evidence.lastPassedAt },
    );
  }
  if (evidence.verificationStatus === "stale") {
    return readinessCheck("DEGRADED", "ROLE_PACK_RELEASE_STALE", "岗位资产已发生变化，需要重新运行标杆任务验收。", { retryable: true });
  }
  return readinessCheck("NOT_REQUIRED", "RELEASE_GATE_ROLLOUT", "当前岗位发布门禁尚在分阶段启用。", { retryable: true });
}
