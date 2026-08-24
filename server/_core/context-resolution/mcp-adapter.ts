import type { ContextSourceBindingV1 } from "../../../shared/context-resolution";

export type McpBindingTarget = {
  endpointUrl: string;
  toolName: string;
};

const SERVICES: Record<string, () => string> = {
  "wealth-customer": () => String(process.env.WEALTH_CUSTOMER_MCP_URL || "http://127.0.0.1:18008/mcp").trim(),
  "wealth-product": () => String(process.env.WEALTH_PRODUCT_MCP_URL || "http://127.0.0.1:18007/mcp").trim(),
  "customer-profile": () => String(
    process.env.EA_CUSTOMER_PROFILE_MCP_URL
      || `http://127.0.0.1:${process.env.PORT || "5180"}/api/internal/customer-profile/mcp`,
  ).trim(),
};

export function mcpResourceRef(service: string, toolName: string): string {
  return `mcp://${service}/${toolName}`;
}

export function resolveMcpBindingTarget(binding: ContextSourceBindingV1): McpBindingTarget {
  if (binding.providerType !== "mcp") {
    throw new Error(`Context binding ${binding.bindingId} is not backed by MCP`);
  }
  const match = binding.resourceRef.match(/^mcp:\/\/([a-z0-9-]+)\/([A-Za-z0-9_-]{2,128})$/);
  if (!match) throw new Error(`Context binding ${binding.bindingId} has an invalid MCP resource reference`);
  const endpoint = SERVICES[match[1]];
  if (!endpoint) throw new Error(`Context binding ${binding.bindingId} uses an unsupported MCP service`);
  return { endpointUrl: endpoint(), toolName: match[2] };
}
