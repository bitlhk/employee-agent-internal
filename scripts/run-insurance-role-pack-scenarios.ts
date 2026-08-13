import { runInsuranceRolePackControlledScenarios } from "../server/_core/insurance-role-pack-scenarios";

const report = await runInsuranceRolePackControlledScenarios();
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
