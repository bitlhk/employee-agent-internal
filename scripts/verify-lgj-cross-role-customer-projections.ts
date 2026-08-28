import { createHash } from "node:crypto";
import { getClawByAdoptId, getUserById } from "../server/db";
import {
  createConfiguredTwentyCustomerClient,
  createConfiguredTwentyCustomerProfileLoader,
  listAuthorizedTwentyCustomers,
} from "../server/_core/customer-context-twenty-access";
import { resolveRuntimePrincipalV2 } from "../server/_core/governance/principal";
import { loadTwentyCustomerProfileCompatibilitySource } from "../server/_core/customer-profile-twenty-adapter";

const adoptionId = String(process.argv[2] || "lgj-lihongkun").trim();
const expectedCustomerIds = Array.from(
  { length: 6 },
  (_, index) => `CUST-${String(201 + index).padStart(6, "0")}`
);

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

async function evaluateRole(roleTemplate: "wealth-manager" | "insurance-advisor") {
  const adoption = await getClawByAdoptId(adoptionId);
  if (!adoption) throw new Error(`CROSS_ROLE_ADOPTION_MISSING:${adoptionId}`);
  const user = await getUserById(Number(adoption.userId));
  if (!user) throw new Error(`CROSS_ROLE_USER_MISSING:${adoption.userId}`);
  const resolved = await resolveRuntimePrincipalV2({
    adoption: { ...adoption, roleTemplate },
    user,
    sessionId: `cross-role-customer-acceptance:${roleTemplate}`,
  });
  if (!resolved.complete)
    throw new Error(`CROSS_ROLE_PRINCIPAL_INCOMPLETE:${resolved.issues.join(",")}`);

  const principal = resolved.principal;
  const client = createConfiguredTwentyCustomerClient();
  const assignedCustomers = (
    await listAuthorizedTwentyCustomers({ client, principal })
  )
    .filter(customer => customer.accessScope === "assigned")
    .sort((left, right) =>
      left.globalCustomerId.localeCompare(right.globalCustomerId)
    );
  const assigned = assignedCustomers.map(customer => customer.globalCustomerId);
  if (JSON.stringify(assigned) !== JSON.stringify(expectedCustomerIds))
    throw new Error(`CROSS_ROLE_ASSIGNED_SET_MISMATCH:${roleTemplate}:${assigned.join(",")}`);
  const writeEligibleCustomers = assignedCustomers.filter(
    customer => customer.preferredForWrite && customer.assignmentKey
  );
  if (writeEligibleCustomers.length !== expectedCustomerIds.length)
    throw new Error(
      `CROSS_ROLE_WRITE_SCOPE_MISMATCH:${roleTemplate}:${writeEligibleCustomers.length}/${expectedCustomerIds.length}`
    );

  const profiles = [];
  for (const customerId of assigned) {
    const loaded = await loadTwentyCustomerProfileCompatibilitySource({
      principal,
      subjectId: customerId,
      recordLoader: createConfiguredTwentyCustomerProfileLoader(),
      productionReady: true,
    });
    const fieldPaths = Array.from(
      new Set(loaded.sources.flatMap(source => source.fields.map(field => field.path)))
    ).sort();
    const sourceSystems = Array.from(new Set(loaded.sources.map(source => source.sourceSystem))).sort();
    if (roleTemplate === "wealth-manager") {
      if (!fieldPaths.some(path => path.startsWith("wealth.")) || fieldPaths.some(path => path.startsWith("insurance.")))
        throw new Error(`CROSS_ROLE_WEALTH_PROJECTION_INVALID:${customerId}`);
    } else if (!fieldPaths.some(path => path.startsWith("insurance.")) || fieldPaths.some(path => path.startsWith("wealth."))) {
      throw new Error(`CROSS_ROLE_INSURANCE_PROJECTION_INVALID:${customerId}`);
    }
    profiles.push({
      customerId,
      sourceSystems,
      sourceCount: loaded.sources.length,
      fieldPaths,
      assignmentKey: assignedCustomers.find(
        customer => customer.globalCustomerId === customerId
      )?.assignmentKey,
    });
  }
  return {
    roleTemplate,
    assignedCustomerIds: assigned,
    assignedSetFingerprint: fingerprint(assigned),
    profiles,
  };
}

const wealth = await evaluateRole("wealth-manager");
const insurance = await evaluateRole("insurance-advisor");
if (wealth.assignedSetFingerprint !== insurance.assignedSetFingerprint)
  throw new Error("CROSS_ROLE_CUSTOMER_SET_IDENTITY_MISMATCH");

const evidence = {
  schemaVersion: "ea.cross-role-customer-projection-acceptance.v1",
  status: "PASS",
  adoptionId,
  customerCount: expectedCustomerIds.length,
  sharedCustomerSetIdentity: true,
  assignedSetFingerprint: wealth.assignedSetFingerprint,
  wealth: {
    roleTemplate: wealth.roleTemplate,
    assignedCustomerIds: wealth.assignedCustomerIds,
    sampleFieldPaths: wealth.profiles[0]?.fieldPaths || [],
    writeAuthorization: "6/6 ALLOW",
  },
  insurance: {
    roleTemplate: insurance.roleTemplate,
    assignedCustomerIds: insurance.assignedCustomerIds,
    sampleFieldPaths: insurance.profiles[0]?.fieldPaths || [],
    writeAuthorization: "6/6 ALLOW",
  },
  crossRoleFieldLeakage: 0,
  evidenceFingerprint: fingerprint({ wealth, insurance }),
};

// eslint-disable-next-line no-console
console.log(JSON.stringify(evidence, null, 2));
