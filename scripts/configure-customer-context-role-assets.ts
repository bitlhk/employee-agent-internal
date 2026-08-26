import "dotenv/config";

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  replaceAdminRoleAssetGrantsForAsset,
  syncRoleAssetSeed,
} from "../server/db";
import { closeDbConnection } from "../server/db/connection";

type Role = { mcpServers?: string[] };
type Baseline = {
  version?: string;
  skillRequirements?: Record<string, { servers?: Record<string, string[]> }>;
  industries?: Record<string, { roles?: Record<string, Role> }>;
};

const RAW_CUSTOMER_SERVERS = new Set([
  "wealth_assistant_customer",
  "insurance_customer_profile",
]);
const TARGET_SERVER = "customer_context";

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(value => String(value || "").trim()).filter(Boolean)));
}

export function applyCustomerContextBaseline(input: Baseline): Baseline {
  const roles = [
    input.industries?.banking?.roles?.["wealth-manager"],
    input.industries?.insurance?.roles?.["insurance-advisor"],
  ].filter(Boolean) as Role[];
  for (const role of roles) {
    const current = role.mcpServers || [];
    const firstRaw = current.findIndex(serverId => RAW_CUSTOMER_SERVERS.has(serverId));
    const next = current.filter(serverId => !RAW_CUSTOMER_SERVERS.has(serverId) && serverId !== TARGET_SERVER);
    next.splice(firstRaw >= 0 ? firstRaw : 0, 0, TARGET_SERVER);
    role.mcpServers = unique(next);
  }
  for (const requirement of Object.values(input.skillRequirements || {})) {
    const servers = requirement.servers || {};
    const aliases = Array.from(RAW_CUSTOMER_SERVERS).flatMap(serverId => servers[serverId] || []);
    if (!aliases.length) continue;
    for (const serverId of RAW_CUSTOMER_SERVERS) delete servers[serverId];
    servers[TARGET_SERVER] = unique([...(servers[TARGET_SERVER] || []), ...aliases]);
    requirement.servers = servers;
  }
  input.version = "2026-08-26-customer-context-v1";
  return input;
}

function baselinePath(): string {
  const configured = String(process.env.ROLE_SKILL_MCP_BASELINE_PATH || "").trim();
  if (!configured) throw new Error("ROLE_SKILL_MCP_BASELINE_PATH is required");
  return path.resolve(configured);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const file = baselinePath();
  const current = JSON.parse(readFileSync(file, "utf8")) as Baseline;
  const updated = applyCustomerContextBaseline(structuredClone(current));
  const changed = JSON.stringify(current) !== JSON.stringify(updated);
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", file, changed, updated }, null, 2));
    return;
  }
  if (changed) {
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }
  const seedPlan = await syncRoleAssetSeed();
  const retiredAdminGrants = [];
  for (const assetId of RAW_CUSTOMER_SERVERS) {
    retiredAdminGrants.push(...await replaceAdminRoleAssetGrantsForAsset({
      assetType: "mcp_server",
      assetId,
      grants: [],
      actor: "customer-context-consolidation-v1",
    }));
  }
  console.log(JSON.stringify({
    mode: "apply",
    file,
    changed,
    seed: {
      desired: seedPlan.desired.length,
      upsert: seedPlan.upsert.length,
      prune: seedPlan.prune.length,
    },
    rawCustomerAdminGrantRows: retiredAdminGrants,
  }, null, 2));
}

const isDirectExecution = Boolean(process.argv[1])
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main()
    .finally(async () => closeDbConnection().catch(() => undefined))
    .catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
