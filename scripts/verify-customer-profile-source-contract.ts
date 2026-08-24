import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CustomerProfileSourceEnvelopeV1 } from "../shared/customer-profile-contract";
import {
  validateCustomerProfileSourceEnvelope,
  verifyCustomerProfileSourceImplementationContract,
} from "../server/_core/customer-profile-source-contract";

const fixture = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "examples/customer-profile-contract-v1/source-envelope.valid.fixture.json"
    ),
    "utf8"
  )
) as CustomerProfileSourceEnvelopeV1;

const contract = verifyCustomerProfileSourceImplementationContract();
const conformance = validateCustomerProfileSourceEnvelope({
  envelope: fixture,
  expectedIdentity: {
    organizationId: fixture.authorizationEvidence.organizationId,
    principalFingerprint: fixture.authorizationEvidence.principalFingerprint,
    authorizationSnapshotId:
      fixture.authorizationEvidence.authorizationSnapshotId,
    authorizationFingerprint:
      fixture.authorizationEvidence.authorizationFingerprint,
    requestedSubjectId: fixture.subjectId,
  },
});

const report = {
  schemaVersion: "ea.customer-profile-source-contract-verification.v1",
  status:
    contract.status === "PASS" && conformance.status === "PASS"
      ? "PASS"
      : "FAIL",
  contract,
  fixtureConformance: conformance,
  currentState: {
    sourceImplementation: "engineering_candidate",
    sourceProductionReady: false,
    runtimeChanged: false,
    authorizationChanged: false,
    bindingChanged: false,
    gateBRerunRequiredBeforePromotion: true,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "PASS") process.exitCode = 1;
