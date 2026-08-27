export type CustomerCrmContractStatusV1 =
  | "engineering_proposed"
  | "engineering_verified"
  | "environment_verified";

export type CustomerCrmIdentitySourceV1 = {
  sourceSystem: string;
  sourceCustomerIdPath: string;
  sourceTenantIdPath?: string;
  globalCustomerIdStrategy:
    | "crosswalk_required"
    | "source_scoped_seed"
    | "canonical_native";
  sourceScopedPrefix: string;
};

export type CustomerCrmIdentityPolicyV1 = {
  schemaVersion: "ea.customer-crm-identity-policy.v1";
  policyVersion: string;
  status: CustomerCrmContractStatusV1;
  globalCustomerId: {
    required: true;
    immutable: true;
    namespace: string;
  };
  mergePolicy: {
    automaticMergeAllowed: false;
    displayNameMayMatch: false;
    phoneMayMatch: false;
    modelMayMatch: false;
    unresolvedStatus: "identity_review_required";
  };
  sources: CustomerCrmIdentitySourceV1[];
};

export type CustomerCrmAuthorityRuleV1 = {
  fieldPattern: string;
  authority: string[];
  crmWriteMode: "authoritative" | "replicated" | "derived" | "reference_only";
  confirmationRequired: boolean;
  runtimeUse: "allowed" | "conditional" | "denied";
  conflictPolicy: "block" | "source_priority" | "human_confirmed";
  notes: string;
};

export type CustomerCrmFieldAuthorityMatrixV1 = {
  schemaVersion: "ea.customer-crm-field-authority-matrix.v1";
  matrixVersion: string;
  status: CustomerCrmContractStatusV1;
  canonicalLogicalContextId: "customer_profile";
  provenanceRequired: true;
  rules: CustomerCrmAuthorityRuleV1[];
};

export type CustomerCrmDomainFieldV1 = {
  path: string;
  dataType:
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "date"
    | "object"
    | "object_array"
    | "string_array";
  sensitivity: "internal" | "sensitive" | "restricted";
  runtimeApproved: boolean;
  provenanceRequired: true;
};

export type CustomerCrmDomainProfileSchemaV1 = {
  profileType: string;
  detailSchemaVersion: string;
  status: "active" | "candidate";
  fields: CustomerCrmDomainFieldV1[];
};

export type CustomerCrmDomainProfileSchemaSetV1 = {
  schemaVersion: "ea.customer-crm-domain-profile-schemas.v1";
  schemaSetVersion: string;
  status: CustomerCrmContractStatusV1;
  unknownProfilePolicy: {
    storageAllowed: true;
    runtimeAllowed: false;
    reviewStatus: "schema_review_required";
  };
  schemas: CustomerCrmDomainProfileSchemaV1[];
};
