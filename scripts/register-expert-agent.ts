import { existsSync, readFileSync } from "fs";
import path from "path";
import dotenv from "dotenv";
import { z } from "zod";

import { upsertBusinessAgent } from "../server/db/agents";

const ConfigSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().min(1).max(128),
  description: z.string().max(10_000).default(""),
  kind: z.enum(["local", "remote"]).default("remote"),
  apiUrl: z.string().url().max(512),
  apiTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  remoteAgentId: z.string().max(128).default("main"),
  localAgentId: z.string().max(128).optional(),
  icon: z.string().max(8).default("A"),
  enabled: z.number().int().min(0).max(1).default(1),
  sortOrder: z.number().int().default(0),
  maxDailyRequests: z.number().int().min(0).max(1_000_000).default(0),
  allowedProfiles: z.string().max(128).default("plus,internal"),
  tags: z.string().max(256).default(""),
  systemPrompt: z.string().max(20_000).optional(),
  providerType: z.string().min(1).max(64),
  adapterProtocol: z.string().min(1).max(96),
  capabilities: z.array(z.string().max(128)).max(100).default([]),
  uiConfig: z.record(z.string(), z.unknown()).default({}),
  endpointConfig: z.record(z.string(), z.unknown()).default({}),
});

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function loadExtraEnv(filePath: string): Record<string, string> {
  if (!filePath) return {};
  const resolved = path.resolve(filePath.replace(/^~(?=\/)/, process.env.HOME || ""));
  if (!existsSync(resolved)) throw new Error(`env file not found: ${resolved}`);
  return dotenv.parse(readFileSync(resolved));
}

async function main() {
  const configPath = argument("--config");
  if (!configPath) throw new Error("usage: register-expert-agent --config <file> [--env-file <file>]");
  const resolvedConfig = path.resolve(configPath);
  const config = ConfigSchema.parse(JSON.parse(readFileSync(resolvedConfig, "utf8")));
  const extraEnv = loadExtraEnv(argument("--env-file"));
  const token = config.apiTokenEnv
    ? String(process.env[config.apiTokenEnv] || extraEnv[config.apiTokenEnv] || "").trim()
    : "";
  if (config.apiTokenEnv && !token) {
    throw new Error(`${config.apiTokenEnv} is required but was not found in the process or --env-file`);
  }

  await upsertBusinessAgent({
    id: config.id,
    name: config.name,
    description: config.description,
    kind: config.kind,
    apiUrl: config.apiUrl,
    apiToken: token || null,
    remoteAgentId: config.remoteAgentId,
    localAgentId: config.localAgentId || null,
    icon: config.icon,
    enabled: config.enabled,
    sortOrder: config.sortOrder,
    maxDailyRequests: config.maxDailyRequests,
    healthStatus: "unknown",
    allowedProfiles: config.allowedProfiles,
    tags: config.tags,
    systemPrompt: config.systemPrompt || null,
    uiConfig: JSON.stringify(config.uiConfig),
    providerType: config.providerType,
    adapterProtocol: config.adapterProtocol,
    capabilitiesJson: JSON.stringify(config.capabilities),
    endpointConfigJson: JSON.stringify(config.endpointConfig),
  });
  console.log(`Expert registered: ${config.id} (${config.adapterProtocol}); credential=${token ? "configured" : "none"}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
