import type { ContextResolutionEvidenceV1 } from "../../shared/context-resolution";
import {
  contextBindingEvidence,
  contextResolutionEvidence,
  observeWealthContextResolutionShadow,
  resolveWealthContextPlan,
  resolvedContextBinding,
  type ContextBindingEvidence,
} from "./context-resolution/wealth-source-resolution";
import { resolveRoleTaskEvidenceProfile } from "./reference-role-task-evidence";

const FOLLOWUP_LOGICAL_ASSET_ID = "governed_followup_payload";

export type ReferenceRoleTaskContextPreparation = {
  sourceBinding: ContextBindingEvidence | null;
  contextResolution?: ContextResolutionEvidenceV1;
  rejection?: {
    reason: string;
    errorCode: string;
  };
  shadowTaskId?: string;
};

export async function prepareReferenceRoleTaskContext(input: {
  roleTemplate: string;
  serverId: string;
  toolName: string;
  organizationId: string;
}): Promise<ReferenceRoleTaskContextPreparation> {
  const profile = resolveRoleTaskEvidenceProfile(input.roleTemplate, input.serverId, input.toolName);
  if (!profile || profile.roleTemplate !== "wealth-manager" || profile.taskId !== "WM-GT-05") {
    return { sourceBinding: null };
  }

  const resolution = await resolveWealthContextPlan({
    taskId: profile.taskId,
    organizationId: input.organizationId,
    contextType: "business_data",
  });
  if (resolution.mode !== "binding") {
    return { sourceBinding: null, shadowTaskId: profile.taskId };
  }

  const binding = resolvedContextBinding(resolution.plan, FOLLOWUP_LOGICAL_ASSET_ID);
  if (!binding || binding.providerType !== "api") {
    return {
      sourceBinding: null,
      contextResolution: contextResolutionEvidence([resolution.plan]),
      rejection: {
        reason: "必需跟进任务上下文来源尚未完成受治理绑定。",
        errorCode: "REQUIRED_CONTEXT_BINDING_MISSING",
      },
      shadowTaskId: profile.taskId,
    };
  }

  return {
    sourceBinding: contextBindingEvidence(binding),
    contextResolution: contextResolutionEvidence([resolution.plan]),
    shadowTaskId: profile.taskId,
  };
}

export async function observeReferenceRoleTaskContextShadow(input: {
  preparation: ReferenceRoleTaskContextPreparation;
  organizationId: string;
  adoptionId: string;
  agentId: string;
}): Promise<void> {
  if (!input.preparation.shadowTaskId) return;
  await observeWealthContextResolutionShadow({
    taskId: input.preparation.shadowTaskId,
    principal: {
      organizationId: input.organizationId,
      adoptionId: input.adoptionId,
      agentId: input.agentId,
    },
    observed: [{
      logicalAssetId: FOLLOWUP_LOGICAL_ASSET_ID,
      providerType: "api",
      resourceRef: "api://employee-agent/enterprise-mcp/governed-followup-intent",
    }],
  });
}
