import {
  loadCustomerProfileSourceRemediationPlan,
  verifyCustomerProfileSourceRemediationPlan,
} from "../server/_core/customer-profile-source-remediation";

const report = verifyCustomerProfileSourceRemediationPlan(
  loadCustomerProfileSourceRemediationPlan()
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "PASS") process.exitCode = 1;
