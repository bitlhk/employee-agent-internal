import "dotenv/config";
import { and, desc, eq } from "drizzle-orm";
import { clawAdoptions } from "../drizzle/schema";
import {
  defaultCustomerDirectoryLoader,
  defaultCustomerPortfolioLoader,
} from "../server/_core/customer-context-tools";
import {
  twentyCustomerContextEnabled,
  twentyCustomerContextProductionReady,
} from "../server/_core/customer-context-twenty-access";
import { defaultCustomerProfileSourceLoader } from "../server/_core/customer-profile-mcp";
import type { RuntimePrincipalV2 } from "../server/_core/governance/contracts";
import { resolveRuntimePrincipalV2 } from "../server/_core/governance/principal";
import { getUserById } from "../server/db";
import { closeDbConnection, getDb } from "../server/db/connection";

type SupportedRole = "wealth-manager" | "insurance-advisor";

async function latestPrincipal(
  role: SupportedRole
): Promise<RuntimePrincipalV2> {
  const database = await getDb();
  if (!database) throw new Error("TWENTY_RUNTIME_DATABASE_UNAVAILABLE");
  const [adoption] = await database
    .select()
    .from(clawAdoptions)
    .where(
      and(
        eq(clawAdoptions.roleTemplate, role),
        eq(clawAdoptions.status, "active")
      )
    )
    .orderBy(desc(clawAdoptions.updatedAt))
    .limit(1);
  if (!adoption) throw new Error(`TWENTY_RUNTIME_ADOPTION_MISSING:${role}`);
  const user = await getUserById(Number(adoption.userId));
  if (!user) throw new Error(`TWENTY_RUNTIME_USER_MISSING:${role}`);
  const resolved = await resolveRuntimePrincipalV2({
    adoption,
    user,
    sessionId: `twenty-runtime-verification-${role}-${Date.now()}`,
  });
  if (!resolved.complete)
    throw new Error(
      `TWENTY_RUNTIME_PRINCIPAL_INCOMPLETE:${role}:${resolved.issues.join(",")}`
    );
  return resolved.principal;
}

function subjectFor(role: SupportedRole): string {
  return role === "wealth-manager"
    ? String(
        process.env.EA_CUSTOMER_CONTEXT_TWENTY_WEALTH_SUBJECT_ID || "C005"
      ).trim()
    : String(
        process.env.EA_CUSTOMER_CONTEXT_TWENTY_INSURANCE_SUBJECT_ID || "1"
      ).trim();
}

async function verifyRole(role: SupportedRole) {
  const principal = await latestPrincipal(role);
  const requestedSubjectId = subjectFor(role);
  const loaded = await defaultCustomerProfileSourceLoader({
    principal,
    subjectId: requestedSubjectId,
  });
  const resolvedSubjectId = String(loaded.resolvedSubjectId || "");
  if (!/^CUST-[0-9]{6}$/u.test(resolvedSubjectId))
    throw new Error(`TWENTY_RUNTIME_CANONICAL_SUBJECT_MISSING:${role}`);
  if (!loaded.principalAuthorized || !loaded.subjectInScope)
    throw new Error(`TWENTY_RUNTIME_SUBJECT_NOT_AUTHORIZED:${role}`);
  if (
    loaded.sources.length !== 1 ||
    loaded.sources.some(
      source =>
        source.sourceSystem !== "twenty_crm" ||
        source.productionReady !== true ||
        source.assuranceLevel !== "production"
    )
  )
    throw new Error(`TWENTY_RUNTIME_PROFILE_SOURCE_INVALID:${role}`);

  const directory = await defaultCustomerDirectoryLoader({
    principal,
    query: "",
    offset: 0,
    limit: 100,
  });
  if (
    !directory.items.some(item => item.customerId === resolvedSubjectId) ||
    directory.sourceEvidence.some(item => item.sourceSystem !== "twenty_crm")
  )
    throw new Error(`TWENTY_RUNTIME_DIRECTORY_SOURCE_INVALID:${role}`);

  let portfolio: { status: string; sourceSystems: string[] } | undefined;
  if (role === "wealth-manager") {
    const result = await defaultCustomerPortfolioLoader({
      principal,
      subjectId: requestedSubjectId,
    });
    const sourceSystems = result.sourceEvidence.map(item => item.sourceSystem);
    if (
      result.subjectId !== resolvedSubjectId ||
      sourceSystems.some(source => source !== "twenty_crm")
    )
      throw new Error("TWENTY_RUNTIME_PORTFOLIO_SOURCE_INVALID");
    portfolio = { status: result.status, sourceSystems };
  }

  return {
    role,
    adoptionId: principal.adoptionId,
    organizationId: principal.organizationId,
    requestedSubjectId,
    resolvedSubjectId,
    directoryCount: directory.total,
    profileSourceSystems: loaded.sources.map(source => source.sourceSystem),
    profileAssurance: loaded.sources.map(source => source.assuranceLevel),
    ...(portfolio ? { portfolio } : {}),
  };
}

if (!twentyCustomerContextEnabled())
  throw new Error("TWENTY_RUNTIME_FEATURE_NOT_ENABLED");
if (!twentyCustomerContextProductionReady())
  throw new Error("TWENTY_RUNTIME_PRODUCTION_GATE_NOT_ENABLED");

try {
  const roles: SupportedRole[] = ["wealth-manager", "insurance-advisor"];
  const observations = [];
  for (const role of roles) observations.push(await verifyRole(role));
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        schemaVersion: "ea.twenty-customer-context-runtime-verification.v1",
        status: "PASS",
        observations,
      },
      null,
      2
    )
  );
} finally {
  await closeDbConnection();
}
