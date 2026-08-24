import {
  loadCustomerProfileSourceRemediationPlan,
  verifyCustomerProfileSourceRemediationPlan,
} from "../server/_core/customer-profile-source-remediation";

const report = verifyCustomerProfileSourceRemediationPlan(
  loadCustomerProfileSourceRemediationPlan(),
  process.cwd(),
  {
    requireDomainConfirmed: process.argv.includes("--require-domain-confirmed"),
  }
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "PASS") process.exitCode = 1;
