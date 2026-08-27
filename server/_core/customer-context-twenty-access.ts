import type { RuntimePrincipalV2 } from "./governance/contracts";
import { governanceFingerprint } from "./governance/contracts";
import {
  TwentyCustomerCrmClientV1,
  type TwentyCustomerAssignmentV1,
  type TwentyAuthorizedCustomerV1,
  type TwentyCustomerAuthorizationDecisionV1,
  type TwentyCustomerSummaryV1,
} from "./customer-profile-twenty-client";

function enabled(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase()
  );
}

function requiredEnvironment(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`TWENTY_CUSTOMER_CONTEXT_ENV_REQUIRED:${name}`);
  return value;
}

function allowedProfileTypes(roleTemplate: string): string[] {
  if (roleTemplate === "wealth-manager") return ["wealth"];
  if (roleTemplate === "insurance-advisor")
    return ["auto_insurance", "life_insurance"];
  return [];
}

function allowedSourceSystems(roleTemplate: string): string[] {
  if (roleTemplate === "wealth-manager") return ["wealth_assistant_customer"];
  if (roleTemplate === "insurance-advisor")
    return ["insurance_customer_profile"];
  return [];
}

function configuredSourceTenant(): string {
  return String(process.env.EA_CUSTOMER_CONTEXT_TWENTY_TENANT_ID || "").trim();
}

function configuredOrganizations(): Set<string> {
  const configured = [
    process.env.EA_CUSTOMER_CONTEXT_TWENTY_ORGANIZATION_IDS,
    process.env.EA_CUSTOMER_CONTEXT_TWENTY_ORGANIZATION_ID,
  ]
    .flatMap(value => String(value || "").split(","))
    .map(value => value.trim())
    .filter(Boolean);
  return new Set(configured);
}

function principalAssignmentRefs(principal: RuntimePrincipalV2): Array<{
  principalType: TwentyCustomerAssignmentV1["principalType"];
  principalRef: string;
}> {
  return [
    { principalType: "user", principalRef: String(principal.userId) },
    { principalType: "role_adoption", principalRef: principal.adoptionId },
  ];
}

async function assignmentsForPrincipal(
  client: TwentyCustomerCrmClientV1,
  principal: RuntimePrincipalV2
): Promise<TwentyCustomerAssignmentV1[]> {
  const batches = await Promise.all(
    principalAssignmentRefs(principal).map(item =>
      client.listAssignmentsForPrincipal(item.principalRef)
    )
  );
  const unique = new Map<string, TwentyCustomerAssignmentV1>();
  for (const assignment of batches.flat())
    unique.set(assignment.assignmentKey, assignment);
  return Array.from(unique.values());
}

function assignmentMatchesPrincipal(
  assignment: TwentyCustomerAssignmentV1,
  principal: RuntimePrincipalV2
): boolean {
  return principalAssignmentRefs(principal).some(
    candidate =>
      candidate.principalType === assignment.principalType &&
      candidate.principalRef === assignment.principalRef
  );
}

function roleBusinessDomain(roleTemplate: string): string {
  if (roleTemplate === "wealth-manager") return "wealth";
  if (roleTemplate === "insurance-advisor") return "insurance";
  return "";
}

function activeAssignment(
  assignment: TwentyCustomerAssignmentV1,
  principal: RuntimePrincipalV2,
  now = new Date()
): boolean {
  if (
    !assignmentMatchesPrincipal(assignment, principal) ||
    assignment.organizationId !== principal.organizationId ||
    assignment.assignmentStatus !== "active"
  )
    return false;
  const domain = roleBusinessDomain(principal.roleTemplate);
  if (
    assignment.businessDomain &&
    assignment.businessDomain !== "shared" &&
    assignment.businessDomain !== domain
  )
    return false;
  const validFrom = Date.parse(assignment.validFrom || "");
  const validTo = Date.parse(assignment.validTo || "");
  if (Number.isFinite(validFrom) && validFrom > now.getTime()) return false;
  if (Number.isFinite(validTo) && validTo <= now.getTime()) return false;
  return true;
}

function customerBelongsToConfiguredScope(
  customer: TwentyCustomerSummaryV1,
  principal: RuntimePrincipalV2
): boolean {
  const organizations = configuredOrganizations();
  if (organizations.size && !organizations.has(principal.organizationId))
    return false;
  const sourceTenant = configuredSourceTenant();
  return customer.tenantId === (sourceTenant || principal.tenantId);
}

function createClient(): TwentyCustomerCrmClientV1 {
  return new TwentyCustomerCrmClientV1({
    baseUrl: requiredEnvironment("TWENTY_BASE_URL"),
    apiKey: requiredEnvironment("TWENTY_API_KEY"),
    timeoutMs: Number(
      process.env.EA_CUSTOMER_CONTEXT_TWENTY_TIMEOUT_MS || 10_000
    ),
  });
}

export function twentyCustomerContextEnabled(): boolean {
  return enabled(process.env.EA_CUSTOMER_CONTEXT_TWENTY_ENABLED);
}

export function twentyCustomerContextProductionReady(): boolean {
  return enabled(process.env.EA_CUSTOMER_CONTEXT_TWENTY_PRODUCTION_READY);
}

export function createConfiguredTwentyCustomerClient(): TwentyCustomerCrmClientV1 {
  if (!twentyCustomerContextEnabled())
    throw new Error("TWENTY_CUSTOMER_CONTEXT_NOT_ENABLED");
  return createClient();
}

export async function evaluateTwentyCustomerAccess(input: {
  client: TwentyCustomerCrmClientV1;
  principal: RuntimePrincipalV2;
  globalCustomerId: string;
}): Promise<TwentyCustomerAuthorizationDecisionV1> {
  const profileTypes = allowedProfileTypes(input.principal.roleTemplate);
  const customer = await input.client.loadCustomerSummary(
    input.globalCustomerId
  );
  const assignments =
    customer?.visibilityScope === "restricted"
      ? await assignmentsForPrincipal(input.client, input.principal)
      : [];
  const assignment = assignments.find(
    item =>
      item.globalCustomerId === input.globalCustomerId &&
      activeAssignment(item, input.principal)
  );
  const roleAllowed = profileTypes.length > 0;
  const customerInScope = Boolean(
    customer &&
      customer.customerStatus === "active" &&
      customerBelongsToConfiguredScope(customer, input.principal) &&
      (customer.visibilityScope === "demo_public" || assignment)
  );
  const evidence = {
    contract: "ea.twenty-customer-access.v1",
    globalCustomerId: input.globalCustomerId,
    organizationId: input.principal.organizationId,
    principalRefs: principalAssignmentRefs(input.principal),
    roleTemplate: input.principal.roleTemplate,
    visibilityScope: customer?.visibilityScope || "not_found",
    assignmentKey: assignment?.assignmentKey || null,
    sourceTenant: customer?.tenantId || null,
    roleAllowed,
    customerInScope,
  };
  return {
    allowed: roleAllowed,
    subjectInScope: customerInScope,
    authorizationEvidenceId: governanceFingerprint(evidence),
    allowedProfileTypes: profileTypes,
  };
}

export function createConfiguredTwentyCustomerProfileLoader() {
  const client = createConfiguredTwentyCustomerClient();
  return async (request: {
    globalCustomerId: string;
    principal: RuntimePrincipalV2;
  }) => {
    const resolvedGlobalCustomerId = await client.resolveGlobalCustomerId({
      customerId: request.globalCustomerId,
      allowedSourceSystems: allowedSourceSystems(
        request.principal.roleTemplate
      ),
    });
    if (!resolvedGlobalCustomerId) return null;
    const decision = await evaluateTwentyCustomerAccess({
      client,
      principal: request.principal,
      globalCustomerId: resolvedGlobalCustomerId,
    });
    if (!decision.authorizationEvidenceId.trim())
      throw new Error("TWENTY_CUSTOMER_CRM_AUTHORIZATION_EVIDENCE_REQUIRED");
    if (!decision.allowed || !decision.subjectInScope)
      return {
        record: null,
        resolvedGlobalCustomerId,
        principalAuthorized: decision.allowed,
        subjectInScope: decision.subjectInScope,
        authorizationEvidenceId: decision.authorizationEvidenceId,
      };
    const record = await client.loadCustomerProfile({
      globalCustomerId: resolvedGlobalCustomerId,
      allowedProfileTypes: decision.allowedProfileTypes,
      allowedRuntimeStatuses: twentyCustomerContextProductionReady()
        ? ["active"]
        : ["candidate", "active"],
    });
    return record
      ? {
          record,
          resolvedGlobalCustomerId,
          principalAuthorized: true,
          subjectInScope: true,
          authorizationEvidenceId: decision.authorizationEvidenceId,
        }
      : null;
  };
}

export async function listAuthorizedTwentyCustomers(input: {
  client: TwentyCustomerCrmClientV1;
  principal: RuntimePrincipalV2;
}): Promise<TwentyAuthorizedCustomerV1[]> {
  if (!allowedProfileTypes(input.principal.roleTemplate).length) return [];
  const [publicCustomers, assignments] = await Promise.all([
    input.client.listPublicCustomers(),
    assignmentsForPrincipal(input.client, input.principal),
  ]);
  const activeAssignments = assignments.filter(item =>
    activeAssignment(item, input.principal)
  );
  const assignedCustomers = await Promise.all(
    activeAssignments.map(item =>
      input.client.loadCustomerSummary(item.globalCustomerId)
    )
  );
  const assignmentsByCustomer = new Map(
    activeAssignments.map(item => [item.globalCustomerId, item])
  );
  const unique = new Map<string, TwentyAuthorizedCustomerV1>();
  for (const customer of [...publicCustomers, ...assignedCustomers]) {
    if (
      !customer ||
      customer.customerStatus !== "active" ||
      !customerBelongsToConfiguredScope(customer, input.principal)
    )
      continue;
    const assignment = assignmentsByCustomer.get(customer.globalCustomerId);
    unique.set(customer.globalCustomerId, {
      ...customer,
      accessScope: assignment ? "assigned" : "demo_public",
      businessDomain:
        assignment?.businessDomain ||
        roleBusinessDomain(input.principal.roleTemplate),
      relationshipRole: assignment?.relationshipRole || "demo_shared",
      preferredForWrite: Boolean(assignment),
      ...(assignment ? { assignmentKey: assignment.assignmentKey } : {}),
    });
  }
  return Array.from(unique.values()).sort((left, right) => {
    if (left.preferredForWrite !== right.preferredForWrite)
      return left.preferredForWrite ? -1 : 1;
    return left.globalCustomerId.localeCompare(right.globalCustomerId);
  });
}
