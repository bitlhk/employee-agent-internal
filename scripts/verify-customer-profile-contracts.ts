import { runCustomerProfileContractChecks } from "../server/_core/customer-profile-contracts";

const report = runCustomerProfileContractChecks(process.cwd(), {
  requireDomainConfirmed: process.argv.includes("--require-domain-confirmed"),
});

// CLI output is the machine-verifiable evidence used by reviewers and CI.
// eslint-disable-next-line no-console
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
