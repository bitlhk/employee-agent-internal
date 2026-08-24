import "dotenv/config";
import { writeFileSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import { clawAdoptions } from "../drizzle/schema";
import { assessCustomerProfileSourceReadiness } from "../server/_core/customer-profile-source-readiness";
import { defaultCustomerProfileSourceLoader } from "../server/_core/customer-profile-mcp";
import {
  callInternalMcpTool,
  parseInternalMcpJsonResult,
} from "../server/_core/internal-mcp-client";
import { resolveRuntimePrincipalV2 } from "../server/_core/governance/principal";
import type { RuntimePrincipalV2 } from "../server/_core/governance/contracts";
import { principalFingerprint } from "../server/_core/governance/contracts";
import { getUserById } from "../server/db";
import { closeDbConnection, getDb } from "../server/db/connection";

type JsonObject = Record<string, unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstCustomerId(value: unknown): string | null {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const row = current as JsonObject;
    const id =
      row.customerId ??
      row.customer_id ??
      row.customerCode ??
      row.customer_code ??
      row.CUST_NO ??
      row.id;
    if (typeof id === "string" || typeof id === "number") return String(id);
    for (const key of [
      "data",
      "customers",
      "items",
      "records",
      "rows",
      "list",
      "result",
    ]) {
      if (key in row) queue.push(row[key]);
    }
  }
  return null;
}

async function latestPrincipal(
  roleTemplate: "wealth-manager" | "insurance-advisor"
): Promise<RuntimePrincipalV2> {
  const db = await getDb();
  if (!db) throw new Error("CUSTOMER_PROFILE_READINESS_DB_UNAVAILABLE");
  const [adoption] = await db
    .select()
    .from(clawAdoptions)
    .where(
      and(
        eq(clawAdoptions.roleTemplate, roleTemplate),
        eq(clawAdoptions.status, "active")
      )
    )
    .orderBy(desc(clawAdoptions.updatedAt))
    .limit(1);
  if (!adoption)
    throw new Error(`CUSTOMER_PROFILE_ACTIVE_ADOPTION_MISSING:${roleTemplate}`);
  const user = await getUserById(Number(adoption.userId || 0));
  if (!user)
    throw new Error(`CUSTOMER_PROFILE_RUNTIME_USER_MISSING:${roleTemplate}`);
  const resolved = await resolveRuntimePrincipalV2({
    adoption,
    user,
    sessionId: `customer-profile-readiness-${roleTemplate}-${Date.now()}`,
  });
  if (!resolved.complete)
    throw new Error(
      `CUSTOMER_PROFILE_RUNTIME_PRINCIPAL_INCOMPLETE:${roleTemplate}:${resolved.issues.join(",")}`
    );
  return resolved.principal;
}

async function wealthSubject(principal: RuntimePrincipalV2): Promise<string> {
  const endpointUrl = String(
    process.env.WEALTH_CUSTOMER_MCP_URL || "http://127.0.0.1:18008/mcp"
  ).trim();
  const payload = parseInternalMcpJsonResult(
    await callInternalMcpTool({
      endpointUrl,
      toolName: "wealth_assistant_customer_list",
      args: { page: 1, pageSize: 1 },
      agentId: principal.agentId,
      adoptId: principal.adoptionId,
      sessionId: principal.sessionId,
      timeoutMs: 30_000,
    })
  );
  const subjectId = firstCustomerId(payload);
  if (!subjectId)
    throw new Error("CUSTOMER_PROFILE_WEALTH_SUBJECT_UNAVAILABLE");
  return subjectId;
}

async function assessRole(input: {
  roleTemplate: "wealth-manager" | "insurance-advisor";
  declaredSourceContractIds: string[];
}) {
  const principal = await latestPrincipal(input.roleTemplate);
  let subjectId = "environment-subject-unresolved";
  let loaded = {
    sources: [],
    principalAuthorized: false,
    subjectInScope: false,
    notes: [] as string[],
  };
  let environmentError: string | null = null;
  try {
    if (input.roleTemplate === "wealth-manager")
      subjectId = await wealthSubject(principal);
    loaded = await defaultCustomerProfileSourceLoader({
      principal,
      subjectId,
    });
  } catch (error) {
    environmentError = errorMessage(error);
  }
  const report = assessCustomerProfileSourceReadiness({
    roleTemplate: input.roleTemplate,
    principalFingerprint: principalFingerprint(principal),
    principalAuthorized: loaded.principalAuthorized,
    subjectInScope: loaded.subjectInScope,
    requestedSubjectId: subjectId,
    sources: loaded.sources,
    declaredSourceContractIds: input.declaredSourceContractIds,
  });
  return {
    report,
    environment: {
      environmentError,
      loaderNotes: loaded.notes,
    },
  };
}

async function main() {
  const requireReady = process.argv.includes("--require-ready");
  const outputIndex = process.argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  const generatedAt = new Date().toISOString();
  const roles = await Promise.all([
    assessRole({
      roleTemplate: "wealth-manager",
      declaredSourceContractIds: ["wealth-assistant-customer-v2.1"],
    }),
    assessRole({
      roleTemplate: "insurance-advisor",
      declaredSourceContractIds: ["insurance-customer-profile-demo-v1"],
    }),
  ]);
  const result = {
    schemaVersion: "ea.customer-profile-source-readiness-environment.v1",
    generatedAt,
    status: roles.every(item => item.report.status === "READY")
      ? "READY"
      : "SOURCE_REMEDIATION_PENDING",
    roles,
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, text, "utf8");
  process.stdout.write(text);
  if (requireReady && result.status !== "READY") process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbConnection();
  });
