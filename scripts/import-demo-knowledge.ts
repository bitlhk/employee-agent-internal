import "dotenv/config";
import { createHash } from "crypto";
import { chmodSync, copyFileSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import {
  createKnowledgeBaseRecord,
  createKnowledgeDocumentRecord,
  deleteKnowledgeBaseRecord,
  deleteKnowledgeDocumentsByBase,
  getClawByAdoptId,
  getUserById,
  listKnowledgeBasesOwnedByUser,
} from "../server/db";
import { queueKnowledgeIndex } from "../server/_core/knowledge-service";
import {
  KNOWLEDGE_EXTENSIONS,
  knowledgeDocumentStoragePath,
  knowledgeExtension,
  knowledgeMimeType,
  removeKnowledgeBaseFiles,
} from "../server/_core/knowledge-storage";

const adoptId = String(process.argv.find((arg) => arg.startsWith("--adopt-id="))?.split("=", 2)[1] || "").trim();
const validateOnly = process.argv.includes("--validate");
const sourceDir = path.resolve(process.cwd(), "examples", "financial-enterprise-knowledge-demo");
const wealthKnowledgeManifestPath = path.resolve(
  process.cwd(),
  "examples",
  "wealth-manager-reference-role-pack",
  "knowledge",
  "manifest.json",
);

type ReferenceKnowledgeAsset = {
  assetId: string;
  file: string;
  versionLabel: string;
  sourceDepartment: string;
  classification: "public" | "internal" | "sensitive" | "restricted";
  authority: "official" | "approved" | "reference" | "personal";
  lifecycle: "active" | "expired" | "archived";
  effectiveAt: string | null;
  expiresAt: string | null;
  supersedes?: string | null;
  supersededBy?: string | null;
  taskIds: string[];
};

const wealthKnowledgeManifest = JSON.parse(readFileSync(wealthKnowledgeManifestPath, "utf8")) as {
  roleTemplate: string;
  assets: ReferenceKnowledgeAsset[];
};
if (wealthKnowledgeManifest.roleTemplate !== "wealth-manager") {
  throw new Error("Wealth knowledge manifest roleTemplate must be wealth-manager");
}

function validateWealthKnowledgeManifest(assets: ReferenceKnowledgeAsset[]): void {
  const assetIds = new Set<string>();
  const files = new Set<string>();
  const prefixes = new Set<string>();
  for (const asset of assets) {
    if (!asset.assetId || assetIds.has(asset.assetId)) throw new Error(`Duplicate or empty knowledge assetId: ${asset.assetId}`);
    if (!/^\d{2}-.+\.md$/.test(asset.file) || files.has(asset.file)) throw new Error(`Invalid or duplicate knowledge file: ${asset.file}`);
    const prefix = asset.file.split("-", 1)[0];
    if (prefixes.has(prefix)) throw new Error(`Knowledge file prefix must be unique: ${prefix}`);
    if (!asset.taskIds.length || asset.taskIds.some((taskId) => !/^WM-GT-0[1-6]$/.test(taskId))) {
      throw new Error(`Invalid benchmark task mapping for: ${asset.assetId}`);
    }
    const effectiveAt = asset.effectiveAt ? Date.parse(asset.effectiveAt) : null;
    const expiresAt = asset.expiresAt ? Date.parse(asset.expiresAt) : null;
    if (effectiveAt !== null && !Number.isFinite(effectiveAt)) throw new Error(`Invalid effectiveAt for: ${asset.assetId}`);
    if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new Error(`Invalid expiresAt for: ${asset.assetId}`);
    if (effectiveAt !== null && expiresAt !== null && expiresAt <= effectiveAt) {
      throw new Error(`expiresAt must be after effectiveAt for: ${asset.assetId}`);
    }
    if (asset.lifecycle === "expired" && expiresAt === null) throw new Error(`Expired asset requires expiresAt: ${asset.assetId}`);
    assetIds.add(asset.assetId);
    files.add(asset.file);
    prefixes.add(prefix);
  }
  for (const asset of assets) {
    for (const reference of [asset.supersedes, asset.supersededBy]) {
      if (reference && !assetIds.has(reference)) throw new Error(`Unknown replacement asset ${reference} from ${asset.assetId}`);
    }
  }
}

validateWealthKnowledgeManifest(wealthKnowledgeManifest.assets);
const wealthKnowledgeByFile = new Map(wealthKnowledgeManifest.assets.map((asset) => [asset.file, asset]));
const wealthKnowledgePrefixes = wealthKnowledgeManifest.assets.map((asset) => asset.file.split("-", 1)[0]);

const LEGACY_NAMES = new Set([
  "金融机构运营制度演示库",
  "企业差旅与合规制度（演示）",
  "财富经理岗位知识（演示）",
]);
const OFFICIAL_SUITABILITY_NAME = "11-金融机构产品适当性管理办法（2025）.pdf";
const OFFICIAL_SUITABILITY_SHA256 = "5f16e63b49fa264dfd43c986edfe27e1cb066e4c9236f7d75a1fd03f7fb2ad0c";
const COLLECTIONS = [
  {
    scope: "enterprise" as const,
    roleTemplate: null,
    name: "企业公共制度与合规规范（演示）",
    description: "面向全部岗位共享的企业制度、合规要求与公共操作规范。",
    files: ["01", "02", "03", "05", "06", "09", "10"],
  },
  {
    scope: "role" as const,
    roleTemplate: "wealth-manager",
    name: "财富经理岗位操作规范（演示）",
    description: "财富经理岗位内部操作口径、访前准备、销售规范与官方监管法规。",
    files: ["11", ...wealthKnowledgePrefixes],
  },
  {
    scope: "role" as const,
    roleTemplate: "post-loan-risk-control",
    name: "风控经理岗位知识（演示）",
    description: "风控经理适用的客户尽调、数据保护、贷后预警与升级处置示例知识。",
    files: ["05", "06", "07", "09", "10"],
  },
  {
    scope: "role" as const,
    roleTemplate: "credential-compliance",
    name: "审核专员岗位知识（演示）",
    description: "审核专员适用的票据附件、客户尽调、信息保护与审批职责示例知识。",
    files: ["03", "05", "06", "09", "10"],
  },
  {
    scope: "role" as const,
    roleTemplate: "insurance-advisor",
    name: "保险顾问岗位知识（演示）",
    description: "保险顾问适用的产品适当性、客户尽调、信息保护与员工申报示例知识。",
    files: ["04", "05", "06", "09"],
  },
  {
    scope: "role" as const,
    roleTemplate: "investment-researcher",
    name: "投顾分析岗位知识（演示）",
    description: "投顾分析适用的数据保护、投资研究合规与利益冲突申报示例知识。",
    files: ["06", "08", "09"],
  },
] as const;

function documentGovernance(filename: string) {
  if (filename === OFFICIAL_SUITABILITY_NAME) {
    return {
      versionLabel: "国家金融监督管理总局令〔2025〕7号",
      sourceDepartment: "国家金融监督管理总局",
      classification: "public" as const,
      authority: "official" as const,
      effectiveAt: new Date("2026-02-01T00:00:00.000Z"),
      expiresAt: null,
      lifecycle: "active" as const,
    };
  }
  const referenceAsset = wealthKnowledgeByFile.get(filename);
  if (referenceAsset) {
    return {
      versionLabel: referenceAsset.versionLabel,
      sourceDepartment: referenceAsset.sourceDepartment,
      classification: referenceAsset.classification,
      authority: referenceAsset.authority,
      effectiveAt: referenceAsset.effectiveAt ? new Date(referenceAsset.effectiveAt) : null,
      expiresAt: referenceAsset.expiresAt ? new Date(referenceAsset.expiresAt) : null,
      lifecycle: referenceAsset.lifecycle,
    };
  }
  return {
    versionLabel: "演示版 1.0",
    sourceDepartment: "演示业务规范",
    classification: "internal" as const,
    authority: "reference" as const,
    effectiveAt: null,
    expiresAt: null,
    lifecycle: "active" as const,
  };
}

function collectionFiles(prefixes: readonly string[]): string[] {
  return readdirSync(sourceDir)
    .map((filename) => path.join(sourceDir, filename))
    .filter((filename) => {
      if (!statSync(filename).isFile() || !KNOWLEDGE_EXTENSIONS.has(knowledgeExtension(filename))) return false;
      const basename = path.basename(filename);
      return prefixes.some((prefix) => prefix === "SOURCES" ? basename === "SOURCES.md" : basename.startsWith(`${prefix}-`));
    })
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function buildImportPlan() {
  const plan = COLLECTIONS.map((collection) => {
    const files = collectionFiles(collection.files);
    if (files.length !== collection.files.length) {
      throw new Error(`Knowledge source files are incomplete for: ${collection.name}`);
    }
    return { collection, files };
  });
  const officialPath = path.join(sourceDir, OFFICIAL_SUITABILITY_NAME);
  const officialSha256 = createHash("sha256").update(readFileSync(officialPath)).digest("hex");
  if (officialSha256 !== OFFICIAL_SUITABILITY_SHA256) {
    throw new Error(`Official suitability document checksum mismatch: ${OFFICIAL_SUITABILITY_NAME}`);
  }
  return plan;
}

async function main() {
  // Validate bundled assets before removing an existing demo import.
  const importPlan = buildImportPlan();
  if (validateOnly) {
    console.log(JSON.stringify({
      ok: true,
      mode: "validate",
      roleTemplate: wealthKnowledgeManifest.roleTemplate,
      referenceAssets: wealthKnowledgeManifest.assets.length,
      collections: importPlan.map(({ collection, files }) => ({
        name: collection.name,
        roleTemplate: collection.roleTemplate,
        documents: files.length,
      })),
    }, null, 2));
    return;
  }
  if (!adoptId) throw new Error("Usage: pnpm tsx scripts/import-demo-knowledge.ts --validate | --adopt-id=lgj-xxx");
  const claw = await getClawByAdoptId(adoptId);
  if (!claw) throw new Error(`Agent adoption not found: ${adoptId}`);
  const user = await getUserById(Number(claw.userId));
  if (!user) throw new Error(`User not found: ${claw.userId}`);
  const ownerUserId = Number(user.id);
  const ownerGroupId = Number(user.groupId || 0);
  const managedNames = new Set([...LEGACY_NAMES, ...COLLECTIONS.map((item) => item.name)]);
  const existing = (await listKnowledgeBasesOwnedByUser(ownerUserId)).filter((item) => managedNames.has(item.name));
  for (const base of existing) {
    await deleteKnowledgeDocumentsByBase(base.id);
    await deleteKnowledgeBaseRecord(base.id, ownerUserId);
    removeKnowledgeBaseFiles(base.publicId);
  }

  const imported: Array<{ knowledgeBaseId: string; name: string; scope: string; roleTemplate: string | null; documents: number }> = [];
  for (const { collection, files } of importPlan) {
    const base = await createKnowledgeBaseRecord({
      publicId: `kb_${nanoid(18)}`,
      ownerUserId,
      ownerGroupId,
      scope: collection.scope,
      isGlobal: true,
      roleTemplate: collection.roleTemplate,
      name: collection.name,
      description: collection.description,
      classification: "internal",
      externalProcessingAllowed: true,
    });
    for (const sourcePath of files) {
      const filename = path.basename(sourcePath);
      const extension = knowledgeExtension(filename);
      const content = readFileSync(sourcePath);
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (filename === OFFICIAL_SUITABILITY_NAME && sha256 !== OFFICIAL_SUITABILITY_SHA256) {
        throw new Error(`Official suitability document checksum mismatch: ${filename}`);
      }
      const governance = documentGovernance(filename);
      const documentPublicId = `doc_${nanoid(18)}`;
      const storage = knowledgeDocumentStoragePath(base.publicId, documentPublicId, filename);
      copyFileSync(sourcePath, storage.absolute);
      chmodSync(storage.absolute, 0o600);
      await createKnowledgeDocumentRecord({
        publicId: documentPublicId,
        knowledgeBaseId: base.id,
        name: filename,
        extension,
        mimeType: knowledgeMimeType(extension),
        storagePath: storage.relative,
        sizeBytes: content.length,
        sha256,
        versionLabel: governance.versionLabel,
        lifecycle: governance.lifecycle,
        sourceDepartment: governance.sourceDepartment,
        classification: governance.classification,
        authority: governance.authority,
        externalProcessingAllowed: true,
        effectiveAt: governance.effectiveAt,
        expiresAt: governance.expiresAt,
      });
    }
    await queueKnowledgeIndex({ ...base, documentCount: files.length, status: "indexing" }, "demo_import");
    imported.push({ knowledgeBaseId: base.publicId, name: base.name, scope: base.scope, roleTemplate: base.roleTemplate, documents: files.length });
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, adoptId, removed: existing.length, imported }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
