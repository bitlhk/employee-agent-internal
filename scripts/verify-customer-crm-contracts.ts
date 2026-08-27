import { runCustomerCrmContractChecks } from "../server/_core/customer-crm-contracts";

const report = runCustomerCrmContractChecks();

// This report is the machine-verifiable CRM integration boundary for CI.
// eslint-disable-next-line no-console
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
