import { readFileSync } from "node:fs";
import path from "node:path";
import {
  runInsuranceRolePackContractChecks,
  runWealthRolePackContractChecks,
} from "../server/_core/reference-role-pack-contracts";

process.env.JWT_SECRET ||= "role-replication-controlled-scenario-secret-2026-08-13-not-for-runtime";
process.env.DATABASE_URL ||= "mysql://ea_scenario:4f8c2a91d7b6450ab3e0@127.0.0.1:3306/ea_controlled_scenario";
const { runInsuranceRolePackControlledScenarios } = await import("../server/_core/insurance-role-pack-scenarios");
const { runWealthRolePackControlledScenarios } = await import("../server/_core/wealth-role-pack-scenarios");

const root = process.cwd();
const neutralRuntimeFiles = [
  "shared/context-receipt.ts",
  "shared/context-evidence.ts",
  "server/_core/governance/context-receipt.ts",
  "server/_core/governance/response-evidence.ts",
  "server/_core/enterprise-mcp-gateway.ts",
  "client/src/lib/context-receipt.ts",
  "client/src/components/ContextReceiptPanel.tsx",
];
const forbiddenRoleMarkers = ["WM-GT-", "IA-GT-", "wealth-manager", "insurance-advisor"];
const specializationErrors = neutralRuntimeFiles.flatMap((file) => {
  const source = readFileSync(path.join(root, file), "utf8");
  return forbiddenRoleMarkers
    .filter((marker) => source.includes(marker))
    .map((marker) => `${file} contains role-specific marker ${marker}`);
});

const wealth = runWealthRolePackContractChecks(root);
const insurance = runInsuranceRolePackContractChecks(root);
const wealthScenarios = await runWealthRolePackControlledScenarios(root);
const insuranceScenarios = await runInsuranceRolePackControlledScenarios(root);
const evidenceChannelCoverage = {
  contextReceipt: ["wealth-manager", "insurance-advisor"],
  responseEvidence: ["wealth-manager", "insurance-advisor"],
  businessReceipt: ["wealth-manager", "insurance-advisor"],
  serverTaskReceiptBundle: ["wealth-manager", "insurance-advisor"],
  uiRenderer: "shared",
  governanceContracts: "shared",
};
const errors = [
  ...specializationErrors,
  ...(wealth.status === "PASS" ? [] : wealth.errors.map((error) => `wealth-manager: ${error}`)),
  ...(insurance.status === "PASS" ? [] : insurance.errors.map((error) => `insurance-advisor: ${error}`)),
  ...(wealthScenarios.status === "PASS" ? [] : wealthScenarios.errors.map((error) => `wealth-manager scenario: ${error}`)),
  ...(insuranceScenarios.status === "PASS" ? [] : insuranceScenarios.errors.map((error) => `insurance-advisor scenario: ${error}`)),
];
const report = {
  schema: "ea.grace-role-replication-validation.v1",
  status: errors.length ? "FAIL" : "PASS",
  validatedAt: new Date().toISOString(),
  acceptance: {
    wealthManagerClosedLoop: wealthScenarios.status,
    insuranceAdvisorReplication: insuranceScenarios.status,
    roleNeutralEvidenceUiGovernance: specializationErrors.length ? "FAIL" : "PASS",
    dualRoleGoldenTasks: wealthScenarios.status === "PASS" && insuranceScenarios.status === "PASS" ? "PASS" : "FAIL",
    referenceRolePacks: [wealth.rolePackId, insurance.rolePackId],
  },
  evidenceChannelCoverage,
  rolePacks: [wealth, insurance],
  controlledScenarios: [wealthScenarios, insuranceScenarios],
  errors,
};

console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
