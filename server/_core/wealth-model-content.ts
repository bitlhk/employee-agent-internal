import type { TaskReadinessDecision } from "./governance/task-execution-envelope";
import type { WealthAllocationContextResult } from "./wealth-allocation-context";
import type { WealthPolicyBasis } from "./wealth-policy-source";
import type { WealthPrevisitContextResult } from "./wealth-previsit-context";

export function modelReadiness(readiness: TaskReadinessDecision) {
  return {
    status: readiness.status,
    requestedOutcome: readiness.requestedOutcome,
    allowedOutcomes: readiness.allowedOutcomes,
    deniedOutcomes: readiness.deniedOutcomes,
    reasons: readiness.reasons,
    remediation: readiness.remediation,
  };
}

export function wealthPolicyModelContent(basis: WealthPolicyBasis, readiness: TaskReadinessDecision) {
  const selected = basis.selected ? {
    documentName: basis.selected.documentName,
    versionLabel: basis.selected.versionLabel,
    sourceDepartment: basis.selected.sourceDepartment,
    effectiveAt: basis.selected.effectiveAt,
    sourceLocator: basis.selected.sourceLocator,
  } : null;
  return {
    schema: basis.schema,
    status: basis.status,
    roleTemplate: basis.roleTemplate,
    evaluatedAt: basis.evaluatedAt,
    selected,
    filtered: {
      historicalVersionFiltered: basis.governance.historicalVersionFiltered,
      filteredForValidity: basis.governance.filteredForValidity,
      accessRestricted: basis.governance.accessRestricted,
    },
    userMessage: basis.userMessage,
    readiness: modelReadiness(readiness),
  };
}

export function wealthAllocationModelContent(result: WealthAllocationContextResult, readiness: TaskReadinessDecision) {
  return {
    schema: result.schema,
    status: result.status,
    customer: result.customer,
    eligibleProducts: result.eligibleProducts,
    excludedProducts: result.excludedProducts,
    policySource: {
      ready: result.policySource.ready,
      versionLabel: result.policySource.versionLabel,
      sourceLocator: result.policySource.sourceLocator,
    },
    dataAsOf: {
      customer: result.evidence.customerDataAsOf,
      products: result.evidence.productDataAsOf,
    },
    readiness: modelReadiness(readiness),
  };
}

export function wealthPrevisitModelContent(input: {
  result: WealthPrevisitContextResult;
  readiness: TaskReadinessDecision;
  taskMemoryContext?: string;
}) {
  const selected = input.result.knowledgeBasis.selected ? {
    documentId: input.result.knowledgeBasis.selected.documentId,
    versionLabel: input.result.knowledgeBasis.selected.versionLabel,
    sourceDepartment: input.result.knowledgeBasis.selected.sourceDepartment,
  } : null;
  return {
    schema: input.result.schema,
    status: input.result.status,
    customer: input.result.customer,
    knowledgeBasis: {
      status: input.result.knowledgeBasis.status,
      evaluatedAt: input.result.knowledgeBasis.evaluatedAt,
      selected,
      userMessage: input.result.knowledgeBasis.userMessage,
    },
    dataAsOf: input.result.evidence.customerDataAsOf,
    ...(input.taskMemoryContext ? { taskMemoryContext: input.taskMemoryContext } : {}),
    readiness: modelReadiness(input.readiness),
  };
}
