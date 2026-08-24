import "dotenv/config";
import { writeFileSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import { clawAdoptions } from "../drizzle/schema";
import { loadCustomerProfileContracts } from "../server/_core/customer-profile-contracts";
import { loadWealthCustomerProfileCompatibilitySource } from "../server/_core/customer-profile-compatibility-adapter";
import { normalizeCustomerProfileSource } from "../server/_core/customer-profile-source-adapters";
import { callCustomMcpTool } from "../server/_core/custom-mcp-client";
import { resolveRuntimePrincipalV2 } from "../server/_core/governance/principal";
import { parseInternalMcpJsonResult } from "../server/_core/internal-mcp-client";
import { callInternalMcpTool } from "../server/_core/internal-mcp-client";
import { getUserById } from "../server/db";
import { closeDbConnection, getDb } from "../server/db/connection";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function firstSubjectId(value: unknown): string | null {
  const queue: unknown[] = [value];
  while (queue.length) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const row = object(current);
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

function shapePaths(value: unknown, prefix = "", output = new Set<string>()) {
  if (Array.isArray(value)) {
    if (prefix) output.add(`${prefix}[]`);
    if (value[0] !== undefined) shapePaths(value[0], `${prefix}[]`, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value))
      shapePaths(child, prefix ? `${prefix}.${key}` : key, output);
    return output;
  }
  if (prefix) output.add(prefix);
  return output;
}

async function wealthInventory() {
  const db = await getDb();
  if (!db) throw new Error("CUSTOMER_PROFILE_INVENTORY_DB_UNAVAILABLE");
  const [adoption] = await db
    .select()
    .from(clawAdoptions)
    .where(
      and(
        eq(clawAdoptions.roleTemplate, "wealth-manager"),
        eq(clawAdoptions.status, "active")
      )
    )
    .orderBy(desc(clawAdoptions.updatedAt))
    .limit(1);
  if (!adoption)
    throw new Error("CUSTOMER_PROFILE_INVENTORY_WEALTH_ADOPTION_MISSING");
  const user = await getUserById(Number(adoption.userId || 0));
  if (!user) throw new Error("CUSTOMER_PROFILE_INVENTORY_WEALTH_USER_MISSING");
  const resolved = await resolveRuntimePrincipalV2({
    adoption,
    user,
    sessionId: `customer-profile-inventory-${Date.now()}`,
  });
  if (!resolved.complete)
    throw new Error("CUSTOMER_PROFILE_INVENTORY_WEALTH_PRINCIPAL_INCOMPLETE");
  const endpointUrl = String(
    process.env.WEALTH_CUSTOMER_MCP_URL || "http://127.0.0.1:18008/mcp"
  ).trim();
  const list = parseInternalMcpJsonResult(
    await callInternalMcpTool({
      endpointUrl,
      toolName: "wealth_assistant_customer_list",
      args: { page: 1, pageSize: 1 },
      agentId: resolved.principal.agentId,
      adoptId: resolved.principal.adoptionId,
      sessionId: resolved.principal.sessionId,
    })
  );
  const subjectId = firstSubjectId(list);
  if (!subjectId)
    throw new Error("CUSTOMER_PROFILE_INVENTORY_WEALTH_SUBJECT_MISSING");
  const loaded = await loadWealthCustomerProfileCompatibilitySource({
    principal: resolved.principal,
    subjectId,
  });
  const source = loaded.sources[0];
  if (!source)
    throw new Error("CUSTOMER_PROFILE_INVENTORY_WEALTH_SOURCE_MISSING");
  return {
    source,
    rawShapePaths: [] as string[],
    sourceNativePrincipalAuthorized: loaded.principalAuthorized,
    sourceNativeSubjectInScope: loaded.subjectInScope,
  };
}

async function insuranceInventory() {
  const endpointUrl = String(
    process.env.INSURANCE_CUSTOMER_MCP_URL ||
      "https://mcp.demo.linggan.top/insurance/customer-profile/mcp"
  ).trim();
  const config = {
    endpointUrl,
    authType: "none" as const,
    timeoutMs: 30_000,
  };
  const list = parseInternalMcpJsonResult(
    await callCustomMcpTool(config, "list_customer_profiles", {
      limit: 1,
      offset: 0,
    })
  );
  const listed = Array.isArray(list.items) ? object(list.items[0]) : {};
  const subjectId = String(listed.id ?? "").trim();
  const name = String(listed.name ?? "").trim();
  if (!subjectId || !name)
    throw new Error("CUSTOMER_PROFILE_INVENTORY_INSURANCE_SUBJECT_MISSING");
  const detail = parseInternalMcpJsonResult(
    await callCustomMcpTool(config, "get_customer_profile_by_name", { name })
  );
  const source = normalizeCustomerProfileSource({
    sourceContractId: "insurance-customer-profile-demo-v1",
    payload: detail,
    authorization: {
      inScope: false,
      organizationRef: "inventory-probe",
      principalRef: "inventory-probe",
    },
  });
  return {
    source,
    rawShapePaths: Array.from(shapePaths(detail)).sort(),
    sourceNativePrincipalAuthorized: false,
    sourceNativeSubjectInScope: false,
  };
}

function taskCoverage(input: {
  roleTemplate: "wealth-manager" | "insurance-advisor";
  fieldPaths: string[];
}) {
  const { projections } = loadCustomerProfileContracts();
  const projection = projections.projections.find(
    item => item.roleTemplate === input.roleTemplate
  );
  if (!projection)
    throw new Error(
      `CUSTOMER_PROFILE_INVENTORY_PROJECTION_MISSING:${input.roleTemplate}`
    );
  const present = new Set(input.fieldPaths);
  return projection.taskRequirements.map(requirement => {
    const requiredFields = Array.from(
      new Set([...projection.requiredCoreFields, ...requirement.requiredFields])
    );
    const missingRequiredFields = requiredFields.filter(
      path => !present.has(path)
    );
    return {
      taskIds: requirement.taskIds,
      requiredFields,
      presentRequiredFields: requiredFields.filter(path => present.has(path)),
      missingRequiredFields,
      ready: missingRequiredFields.length === 0,
    };
  });
}

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  const [wealth, insurance] = await Promise.all([
    wealthInventory(),
    insuranceInventory(),
  ]);
  const rows = [
    { roleTemplate: "wealth-manager" as const, ...wealth },
    { roleTemplate: "insurance-advisor" as const, ...insurance },
  ].map(row => {
    const mappedFieldPaths = row.source.fields.map(field => field.path).sort();
    return {
      roleTemplate: row.roleTemplate,
      sourceContractId: row.source.sourceContractId,
      sourceSystem: row.source.sourceSystem,
      productionReady: row.source.productionReady,
      sourceNativePrincipalAuthorized: row.sourceNativePrincipalAuthorized,
      sourceNativeSubjectInScope: row.sourceNativeSubjectInScope,
      rawShapePaths: row.rawShapePaths,
      mappedFieldPaths,
      providerGaps: row.source.providerGaps,
      taskCoverage: taskCoverage({
        roleTemplate: row.roleTemplate,
        fieldPaths: mappedFieldPaths,
      }),
    };
  });
  const result = {
    schemaVersion: "ea.customer-profile-source-inventory.v1",
    assessedAt: new Date().toISOString(),
    environment: "work.linggan.top",
    status: rows.every(
      row =>
        row.productionReady &&
        row.sourceNativePrincipalAuthorized &&
        row.sourceNativeSubjectInScope &&
        row.taskCoverage.every(task => task.ready)
    )
      ? "READY"
      : "SOURCE_INPUT_BLOCKED",
    containsCustomerValues: false,
    sources: rows,
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, text, "utf8");
  process.stdout.write(text);
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
