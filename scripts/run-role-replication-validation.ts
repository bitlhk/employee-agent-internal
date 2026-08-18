import { readFileSync } from "node:fs";
import path from "node:path";
import {
  runInsuranceRolePackContractChecks,
  runInvestmentResearchRolePackContractChecks,
  runPostLoanRiskRolePackContractChecks,
  runSmartAuditRolePackContractChecks,
  runWealthRolePackContractChecks,
} from "../server/_core/reference-role-pack-contracts";

process.env.JWT_SECRET ||= "role-replication-controlled-scenario-secret-2026-08-13-not-for-runtime";
process.env.DATABASE_URL ||= "mysql://ea_scenario:4f8c2a91d7b6450ab3e0@127.0.0.1:3306/ea_controlled_scenario";
const { runInsuranceRolePackControlledScenarios } = await import("../server/_core/insurance-role-pack-scenarios");
const { runInvestmentResearchRolePackControlledScenarios } = await import("../server/_core/investment-research-role-pack-scenarios");
const { runPostLoanRiskRolePackControlledScenarios } = await import("../server/_core/post-loan-risk-role-pack-scenarios");
const { runSmartAuditRolePackControlledScenarios } = await import("../server/_core/smart-audit-role-pack-scenarios");
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
const forbiddenRoleMarkers = ["WM-GT-", "IA-GT-", "RC-GT-", "AU-GT-", "IR-GT-", "wealth-manager", "insurance-advisor", "post-loan-risk-control", "credential-compliance", "investment-researcher"];
const specializationErrors = neutralRuntimeFiles.flatMap((file) => {
  const source = readFileSync(path.join(root, file), "utf8");
  return forbiddenRoleMarkers
    .filter((marker) => source.includes(marker))
    .map((marker) => `${file} contains role-specific marker ${marker}`);
});

const wealth = runWealthRolePackContractChecks(root);
const insurance = runInsuranceRolePackContractChecks(root);
const postLoanRisk = runPostLoanRiskRolePackContractChecks(root);
const smartAudit = runSmartAuditRolePackContractChecks(root);
const investmentResearch = runInvestmentResearchRolePackContractChecks(root);
const wealthScenarios = await runWealthRolePackControlledScenarios(root);
const insuranceScenarios = await runInsuranceRolePackControlledScenarios(root);
const postLoanRiskScenarios = await runPostLoanRiskRolePackControlledScenarios(root);
const smartAuditScenarios = await runSmartAuditRolePackControlledScenarios(root);
const investmentResearchScenarios = await runInvestmentResearchRolePackControlledScenarios(root);
const validatedRoles = ["wealth-manager", "insurance-advisor", "post-loan-risk-control", "credential-compliance", "investment-researcher"];
const evidenceChannelCoverage = {
  contextReceipt: validatedRoles,
  responseEvidence: validatedRoles,
  businessReceipt: validatedRoles,
  serverTaskReceiptBundle: validatedRoles,
  uiRenderer: "shared",
  governanceContracts: "shared",
};
const errors = [
  ...specializationErrors,
  ...(wealth.status === "PASS" ? [] : wealth.errors.map((error) => `wealth-manager: ${error}`)),
  ...(insurance.status === "PASS" ? [] : insurance.errors.map((error) => `insurance-advisor: ${error}`)),
  ...(postLoanRisk.status === "PASS" ? [] : postLoanRisk.errors.map((error) => `post-loan-risk-control: ${error}`)),
  ...(smartAudit.status === "PASS" ? [] : smartAudit.errors.map((error) => `credential-compliance: ${error}`)),
  ...(investmentResearch.status === "PASS" ? [] : investmentResearch.errors.map((error) => `investment-researcher: ${error}`)),
  ...(wealthScenarios.status === "PASS" ? [] : wealthScenarios.errors.map((error) => `wealth-manager scenario: ${error}`)),
  ...(insuranceScenarios.status === "PASS" ? [] : insuranceScenarios.errors.map((error) => `insurance-advisor scenario: ${error}`)),
  ...(postLoanRiskScenarios.status === "PASS" ? [] : postLoanRiskScenarios.errors.map((error) => `post-loan-risk-control scenario: ${error}`)),
  ...(smartAuditScenarios.status === "PASS" ? [] : smartAuditScenarios.errors.map((error) => `credential-compliance scenario: ${error}`)),
  ...(investmentResearchScenarios.status === "PASS" ? [] : investmentResearchScenarios.errors.map((error) => `investment-researcher scenario: ${error}`)),
];
const report = {
  schema: "ea.grace-role-replication-validation.v1",
  status: errors.length ? "FAIL" : "PASS",
  validatedAt: new Date().toISOString(),
  acceptance: {
    wealthManagerClosedLoop: wealthScenarios.status,
    insuranceAdvisorReplication: insuranceScenarios.status,
    postLoanRiskControlReplication: postLoanRiskScenarios.status,
    smartAuditReplication: smartAuditScenarios.status,
    investmentResearchReplication: investmentResearchScenarios.status,
    roleNeutralEvidenceUiGovernance: specializationErrors.length ? "FAIL" : "PASS",
    multiRoleGoldenTasks: wealthScenarios.status === "PASS" && insuranceScenarios.status === "PASS" && postLoanRiskScenarios.status === "PASS" && smartAuditScenarios.status === "PASS" && investmentResearchScenarios.status === "PASS" ? "PASS" : "FAIL",
    referenceRolePacks: [wealth.rolePackId, insurance.rolePackId, postLoanRisk.rolePackId, smartAudit.rolePackId, investmentResearch.rolePackId],
  },
  evidenceChannelCoverage,
  rolePacks: [wealth, insurance, postLoanRisk, smartAudit, investmentResearch],
  controlledScenarios: [wealthScenarios, insuranceScenarios, postLoanRiskScenarios, smartAuditScenarios, investmentResearchScenarios],
  errors,
};

console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
