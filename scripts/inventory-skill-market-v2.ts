import "dotenv/config";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  clawAdoptions,
  roleAssetGrants,
  runtimeOrganizationMemberships,
  skillMarketplace,
} from "../drizzle/schema";
import {
  buildSkillMarketV2Inventory,
  type SkillArtifactObservation,
} from "../server/_core/skills/skill-market-v2-inventory";
import { SKILL_STORE_ROOT } from "../server/_core/skills/skill-store";
import { parseSkillSourceDirectory } from "../server/_core/skills/skill-source";
import { closeDbConnection, getDb } from "../server/db/connection";
import { skillSchema, type Skill } from "../shared/types/skill";

const APP_ROOT = process.env.APP_ROOT || process.cwd();
const REGISTRY_PATH =
  process.env.SKILL_REGISTRY_PATH ||
  path.join(APP_ROOT, "data", "skill-registry.json");

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find(value => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function loadRegistry(): Skill[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as unknown;
  if (!Array.isArray(raw))
    throw new Error("skill registry must contain an array");
  return raw.map((row, index) => {
    const parsed = skillSchema.safeParse(row);
    if (!parsed.success)
      throw new Error(
        `skill registry row ${index} is invalid: ${parsed.error.message}`
      );
    return parsed.data;
  });
}

function hashSourceTree(sourcePath: string): string {
  const hash = createHash("sha256");
  const root = realpathSync(sourcePath);

  function visit(current: string, relative: string): void {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink())
      throw new Error(`symbolic link is not digestible: ${relative || "."}`);
    if (stat.isDirectory()) {
      hash.update(`D\0${relative}\0`);
      for (const name of readdirSync(current).sort())
        visit(path.join(current, name), path.join(relative, name));
      return;
    }
    if (!stat.isFile())
      throw new Error(`unsupported artifact entry: ${relative || "."}`);
    hash.update(`F\0${relative}\0${stat.size}\0`);
    hash.update(readFileSync(current));
    hash.update("\0");
  }

  visit(root, "");
  return hash.digest("hex");
}

function observeArtifact(row: {
  id: number;
  packagePath: string | null;
}): SkillArtifactObservation {
  const rawPath = String(row.packagePath || "").trim();
  if (!rawPath)
    return { marketplaceRowId: row.id, exists: false, insideSkillStore: false };
  const resolved = path.resolve(rawPath);
  if (!existsSync(resolved))
    return { marketplaceRowId: row.id, exists: false, insideSkillStore: false };
  let insideSkillStore = false;
  try {
    const realStore = existsSync(SKILL_STORE_ROOT)
      ? realpathSync(SKILL_STORE_ROOT)
      : path.resolve(SKILL_STORE_ROOT);
    const realArtifact = realpathSync(resolved);
    insideSkillStore =
      realArtifact === realStore ||
      realArtifact.startsWith(`${realStore}${path.sep}`);
  } catch {
    insideSkillStore = false;
  }
  let sourceTreeSha256: string;
  try {
    sourceTreeSha256 = hashSourceTree(resolved);
  } catch (error) {
    return {
      marketplaceRowId: row.id,
      exists: true,
      insideSkillStore,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const parsed = parseSkillSourceDirectory(resolved, path.basename(resolved));
    return {
      marketplaceRowId: row.id,
      exists: true,
      insideSkillStore,
      sourceTreeSha256,
      sourceSkillId: parsed.skillId,
      validSource: true,
    };
  } catch (error) {
    return {
      marketplaceRowId: row.id,
      exists: true,
      insideSkillStore,
      sourceTreeSha256,
      validSource: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const db = await getDb();
  if (!db)
    throw new Error("DATABASE_URL is required for Skill Market V2 inventory");
  const [marketplaceRows, grants, memberships, adoptions] = await Promise.all([
    db.select().from(skillMarketplace),
    db.select().from(roleAssetGrants),
    db.select().from(runtimeOrganizationMemberships),
    db
      .select({
        adoptId: clawAdoptions.adoptId,
        roleTemplate: clawAdoptions.roleTemplate,
      })
      .from(clawAdoptions),
  ]);
  const report = buildSkillMarketV2Inventory({
    marketplaceRows: marketplaceRows.map(row => ({
      id: row.id,
      skillId: row.skillId,
      authorUserId: row.authorUserId,
      version: row.version,
      status: row.status,
      origin: row.origin,
      author: row.author,
      license: row.license,
      packagePath: row.packagePath,
    })),
    registrySkills: loadRegistry(),
    roleSkillGrants: grants
      .filter(grant => grant.assetType === "skill")
      .map(grant => ({
        roleKey: grant.roleKey,
        assetId: grant.assetId,
        grantMode: grant.grantMode,
        source: grant.source,
        enabled: Boolean(grant.enabled),
      })),
    maintainerMemberships: memberships.map(membership => ({
      userId: membership.userId,
      organizationId: membership.organizationId,
      status: membership.status,
    })),
    adoptions,
    artifacts: marketplaceRows.map(observeArtifact),
  });

  const output = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = argument("output");
  if (outputPath) writeFileSync(path.resolve(outputPath), output, "utf8");
  process.stdout.write(output);
  if (
    hasFlag("require-clean") &&
    (report.summary.blockers > 0 || report.summary.warnings > 0)
  )
    process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
