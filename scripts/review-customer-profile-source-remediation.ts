import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CUSTOMER_PROFILE_SOURCE_REMEDIATION_PLAN_PATH,
  loadCustomerProfileSourceRemediationPlan,
  verifyCustomerProfileSourceRemediationPlan,
} from "../server/_core/customer-profile-source-remediation";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const status = argument("--status");
if (
  !["domain_reviewing", "domain_confirmed", "needs_resolution"].includes(status)
)
  throw new Error(
    "--status must be domain_reviewing, domain_confirmed or needs_resolution"
  );
const itemIds = argument("--items")
  .split(",")
  .map(item => item.trim())
  .filter(Boolean);
if (!itemIds.length) throw new Error("--items is required");
const reviewerId = argument("--reviewer-id");
const reviewerRole = argument("--reviewer-role");
if (!reviewerId || !reviewerRole)
  throw new Error("--reviewer-id and --reviewer-role are required");
const reviewComment = argument("--comment");
const groundTruthVersion = argument("--ground-truth-version");
if (status === "domain_confirmed" && (!reviewComment || !groundTruthVersion))
  throw new Error(
    "domain_confirmed requires --comment and --ground-truth-version"
  );
if (status === "needs_resolution" && !reviewComment)
  throw new Error("needs_resolution requires --comment");

const plan = loadCustomerProfileSourceRemediationPlan();
const knownIds = new Set(plan.workItems.map(item => item.workItemId));
for (const itemId of itemIds) {
  if (!knownIds.has(itemId)) throw new Error(`Unknown work item: ${itemId}`);
}
const reviewedAt = new Date().toISOString();
for (const item of plan.workItems) {
  if (!itemIds.includes(item.workItemId)) continue;
  item.review = {
    status: status as typeof item.review.status,
    reviewerId,
    reviewerRole,
    ...(reviewComment ? { reviewComment } : {}),
    ...(status === "domain_confirmed" ? { reviewedAt } : {}),
    ...(groundTruthVersion ? { groundTruthVersion } : {}),
  };
}
const statuses = new Set(plan.workItems.map(item => item.review.status));
plan.status =
  statuses.size === 1 && statuses.has("domain_confirmed")
    ? "domain_confirmed"
    : "domain_reviewing";
const report = verifyCustomerProfileSourceRemediationPlan(plan);
if (report.status !== "PASS")
  throw new Error(`Review update rejected: ${report.errors.join("; ")}`);
writeFileSync(
  resolve(process.cwd(), CUSTOMER_PROFILE_SOURCE_REMEDIATION_PLAN_PATH),
  `${JSON.stringify(plan, null, 2)}\n`,
  "utf8"
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
