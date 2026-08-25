import {
  resolveRuntimeAgentId,
  resolveRuntimeWorkspaceByIds,
} from "./helpers";
import { resolveEnterpriseRuntimeRoute } from "./enterprise-runtime-adapter";

const ENTERPRISE_ARTIFACT_ROOT = "enterprise-artifacts/";

export function isEnterpriseRuntimeArtifactPath(value: unknown): boolean {
  return String(value || "").replace(/\\/g, "/").startsWith(ENTERPRISE_ARTIFACT_ROOT);
}

export async function resolveRuntimeFileWorkspace(args: {
  adoptId: string;
  dbAgentId: string;
  relativePath: string;
  resolveEnterpriseRoute?: typeof resolveEnterpriseRuntimeRoute;
}): Promise<{ runtimeAgentId: string; workspaceDir: string }> {
  let runtimeAgentId = resolveRuntimeAgentId(args.adoptId, args.dbAgentId);
  if (isEnterpriseRuntimeArtifactPath(args.relativePath)) {
    const routeDecision = await (args.resolveEnterpriseRoute || resolveEnterpriseRuntimeRoute)(args.adoptId);
    if (routeDecision.target === "enterprise") {
      runtimeAgentId = routeDecision.route.binding.runtimeAgentId;
    }
  }
  return {
    runtimeAgentId,
    workspaceDir: resolveRuntimeWorkspaceByIds(args.adoptId, runtimeAgentId),
  };
}
