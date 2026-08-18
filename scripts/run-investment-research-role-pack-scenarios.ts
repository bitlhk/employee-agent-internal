process.env.JWT_SECRET ||= "investment-research-controlled-scenario-secret-2026-08-18";
process.env.DATABASE_URL ||= "mysql://ea_scenario:4f8c2a91d7b6450ab3e0@127.0.0.1:3306/ea_controlled_scenario";

const { runInvestmentResearchRolePackControlledScenarios } = await import("../server/_core/investment-research-role-pack-scenarios");
const report = await runInvestmentResearchRolePackControlledScenarios();
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
