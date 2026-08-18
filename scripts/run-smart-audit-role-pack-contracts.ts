import { runSmartAuditRolePackContractChecks } from "../server/_core/reference-role-pack-contracts";

const report = runSmartAuditRolePackContractChecks();
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
