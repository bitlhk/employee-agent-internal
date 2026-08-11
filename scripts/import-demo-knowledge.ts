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

type KnowledgeClassification = "public" | "internal" | "sensitive" | "restricted";
type KnowledgeAuthority = "official" | "approved" | "reference" | "personal";
type KnowledgeLifecycle = "active" | "expired" | "archived";

type ReferenceKnowledgeAsset = {
  assetId: string;
  file: string;
  versionLabel: string;
  sourceDepartment: string;
  classification: KnowledgeClassification;
  authority: KnowledgeAuthority;
  lifecycle: KnowledgeLifecycle;
  effectiveAt: string | null;
  expiresAt: string | null;
  supersedes?: string | null;
  supersededBy?: string | null;
  taskIds: string[];
};

type ReferencePackManifest = {
  schemaVersion: string;
  rolePackId: string;
  roleTemplate: string;
  knowledgeBase?: {
    name: string;
    description: string;
    classification: KnowledgeClassification;
    externalProcessingAllowed: boolean;
  };
  assets: ReferenceKnowledgeAsset[];
};

type DocumentGovernance = {
  versionLabel: string;
  sourceDepartment: string;
  classification: KnowledgeClassification;
  authority: KnowledgeAuthority;
  effectiveAt: Date | null;
  expiresAt: Date | null;
  lifecycle: KnowledgeLifecycle;
};

type ImportCollection = {
  scope: "enterprise" | "role";
  roleTemplate: string | null;
  name: string;
  description: string;
  classification: KnowledgeClassification;
  externalProcessingAllowed: boolean;
};

type ImportPlanItem = {
  collection: ImportCollection;
  files: string[];
  governanceByFile: Map<string, DocumentGovernance>;
};

type ReferencePackDefinition = {
  key: "wealth-manager" | "insurance-advisor";
  roleTemplate: string;
  manifestPath: string;
  sourceDir: string;
  taskIdPattern: RegExp;
  legacyNames: string[];
  fallbackKnowledgeBase: ReferencePackManifest["knowledgeBase"];
};

const APP_ROOT = process.cwd();
const legacySourceDir = path.resolve(APP_ROOT, "examples", "financial-enterprise-knowledge-demo");
const adoptId = String(process.argv.find((arg) => arg.startsWith("--adopt-id="))?.split("=", 2)[1] || "").trim();
const validateOnly = process.argv.includes("--validate");
const requestedPack = String(process.argv.find((arg) => arg.startsWith("--pack="))?.split("=", 2)[1] || "").trim();

const REFERENCE_PACKS: ReferencePackDefinition[] = [
  {
    key: "wealth-manager",
    roleTemplate: "wealth-manager",
    manifestPath: path.resolve(APP_ROOT, "examples", "wealth-manager-reference-role-pack", "knowledge", "manifest.json"),
    sourceDir: legacySourceDir,
    taskIdPattern: /^WM-GT-0[1-6]$/,
    legacyNames: ["财富经理岗位知识（演示）"],
    fallbackKnowledgeBase: {
      name: "财富经理岗位操作规范（演示）",
      description: "财富经理岗位内部操作口径、访前准备、销售规范与官方监管法规。",
      classification: "internal",
      externalProcessingAllowed: true,
    },
  },
  {
    key: "insurance-advisor",
    roleTemplate: "insurance-advisor",
    manifestPath: path.resolve(APP_ROOT, "examples", "insurance-advisor-reference-role-pack", "knowledge", "manifest.json"),
    sourceDir: path.resolve(APP_ROOT, "examples", "insurance-advisor-reference-role-pack", "knowledge", "documents"),
    taskIdPattern: /^IA-GT-0[1-6]$/,
    legacyNames: ["保险顾问岗位知识（演示）"],
    fallbackKnowledgeBase: {
      name: "保险顾问岗位操作规范（演示）",
      description: "保险顾问岗位内部操作口径、车险客户经营、产品讲解、销售陪练与合规升级规范。",
      classification: "internal",
      externalProcessingAllowed: true,
    },
  },
];

const selectedPack = requestedPack
  ? REFERENCE_PACKS.find((pack) => pack.key === requestedPack)
  : undefined;
if (requestedPack && !selectedPack) {
  throw new Error(`Unknown reference role pack: ${requestedPack}. Supported: ${REFERENCE_PACKS.map((pack) => pack.key).join(", ")}`);
}

const LEGACY_NAMES = new Set([
  "金融机构运营制度演示库",
  "企业差旅与合规制度（演示）",
  "财富经理岗位知识（演示）",
]);
const OFFICIAL_SUITABILITY_NAME = "11-金融机构产品适当性管理办法（2025）.pdf";
const OFFICIAL_SUITABILITY_SHA256 = "5f16e63b49fa264dfd43c986edfe27e1cb066e4c9236f7d75a1fd03f7fb2ad0c";

function readManifest(definition: ReferencePackDefinition): ReferencePackManifest {
  const manifest = JSON.parse(readFileSync(definition.manifestPath, "utf8")) as ReferencePackManifest;
  if (manifest.schemaVersion !== "ea.reference-role-pack.knowledge.v1") {
    throw new Error(`Unsupported knowledge manifest schema for ${definition.key}: ${manifest.schemaVersion}`);
  }
  if (manifest.roleTemplate !== definition.roleTemplate) {
    throw new Error(`Knowledge manifest roleTemplate must be ${definition.roleTemplate}`);
  }
  return manifest;
}

export function validateReferenceKnowledgeManifest(
  manifest: ReferencePackManifest,
  definition: Pick<ReferencePackDefinition, "key" | "sourceDir" | "taskIdPattern">,
): void {
  const assetIds = new Set<string>();
  const files = new Set<string>();
  const prefixes = new Set<string>();
  for (const asset of manifest.assets) {
    if (!asset.assetId || assetIds.has(asset.assetId)) throw new Error(`Duplicate or empty knowledge assetId: ${asset.assetId}`);
    if (!/^\d{2}-.+\.md$/.test(asset.file) || files.has(asset.file)) throw new Error(`Invalid or duplicate knowledge file: ${asset.file}`);
    const prefix = asset.file.split("-", 1)[0];
    if (prefixes.has(prefix)) throw new Error(`Knowledge file prefix must be unique: ${prefix}`);
    if (!asset.taskIds.length || asset.taskIds.some((taskId) => !definition.taskIdPattern.test(taskId))) {
      throw new Error(`Invalid benchmark task mapping for ${definition.key}: ${asset.assetId}`);
    }
    const sourcePath = path.join(definition.sourceDir, asset.file);
    if (!statSafeIsFile(sourcePath)) throw new Error(`Knowledge source file does not exist: ${sourcePath}`);
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
  for (const asset of manifest.assets) {
    for (const reference of [asset.supersedes, asset.supersededBy]) {
      if (reference && !assetIds.has(reference)) throw new Error(`Unknown replacement asset ${reference} from ${asset.assetId}`);
    }
  }
}

function statSafeIsFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function governanceFromAsset(asset: ReferenceKnowledgeAsset): DocumentGovernance {
  return {
    versionLabel: asset.versionLabel,
    sourceDepartment: asset.sourceDepartment,
    classification: asset.classification,
    authority: asset.authority,
    effectiveAt: asset.effectiveAt ? new Date(asset.effectiveAt) : null,
    expiresAt: asset.expiresAt ? new Date(asset.expiresAt) : null,
    lifecycle: asset.lifecycle,
  };
}

function buildReferencePackPlan(definition: ReferencePackDefinition): { manifest: ReferencePackManifest; item: ImportPlanItem } {
  const manifest = readManifest(definition);
  validateReferenceKnowledgeManifest(manifest, definition);
  const knowledgeBase = manifest.knowledgeBase || definition.fallbackKnowledgeBase;
  if (!knowledgeBase) throw new Error(`Missing knowledgeBase metadata for ${definition.key}`);
  return {
    manifest,
    item: {
      collection: {
        scope: "role",
        roleTemplate: manifest.roleTemplate,
        name: knowledgeBase.name,
        description: knowledgeBase.description,
        classification: knowledgeBase.classification,
        externalProcessingAllowed: knowledgeBase.externalProcessingAllowed,
      },
      files: manifest.assets.map((asset) => path.join(definition.sourceDir, asset.file)),
      governanceByFile: new Map(manifest.assets.map((asset) => [asset.file, governanceFromAsset(asset)])),
    },
  };
}

function defaultGovernance(filename: string, wealthByFile: Map<string, ReferenceKnowledgeAsset>): DocumentGovernance {
  if (filename === OFFICIAL_SUITABILITY_NAME) {
    return {
      versionLabel: "国家金融监督管理总局令〔2025〕7号",
      sourceDepartment: "国家金融监督管理总局",
      classification: "public",
      authority: "official",
      effectiveAt: new Date("2026-02-01T00:00:00.000Z"),
      expiresAt: null,
      lifecycle: "active",
    };
  }
  const referenceAsset = wealthByFile.get(filename);
  if (referenceAsset) return governanceFromAsset(referenceAsset);
  return {
    versionLabel: "演示版 1.0",
    sourceDepartment: "演示业务规范",
    classification: "internal",
    authority: "reference",
    effectiveAt: null,
    expiresAt: null,
    lifecycle: "active",
  };
}

function legacyCollectionFiles(prefixes: readonly string[]): string[] {
  return readdirSync(legacySourceDir)
    .map((filename) => path.join(legacySourceDir, filename))
    .filter((filePath) => {
      if (!statSync(filePath).isFile() || !KNOWLEDGE_EXTENSIONS.has(knowledgeExtension(filePath))) return false;
      const basename = path.basename(filePath);
      return prefixes.some((prefix) => prefix === "SOURCES" ? basename === "SOURCES.md" : basename.startsWith(`${prefix}-`));
    })
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function buildLegacyImportPlan(): ImportPlanItem[] {
  const wealthDefinition = REFERENCE_PACKS.find((pack) => pack.key === "wealth-manager")!;
  const wealthManifest = readManifest(wealthDefinition);
  validateReferenceKnowledgeManifest(wealthManifest, wealthDefinition);
  const wealthByFile = new Map(wealthManifest.assets.map((asset) => [asset.file, asset]));
  const wealthPrefixes = wealthManifest.assets.map((asset) => asset.file.split("-", 1)[0]);
  const collections = [
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
      files: ["11", ...wealthPrefixes],
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
      description: "保险顾问旧版通用金融演示知识；建议改用 --pack=insurance-advisor。",
      files: ["04", "05", "06", "09"],
    },
    {
      scope: "role" as const,
      roleTemplate: "investment-researcher",
      name: "投顾分析岗位知识（演示）",
      description: "投顾分析适用的数据保护、投资研究合规与利益冲突申报示例知识。",
      files: ["06", "08", "09"],
    },
  ];
  const officialPath = path.join(legacySourceDir, OFFICIAL_SUITABILITY_NAME);
  const officialSha256 = createHash("sha256").update(readFileSync(officialPath)).digest("hex");
  if (officialSha256 !== OFFICIAL_SUITABILITY_SHA256) {
    throw new Error(`Official suitability document checksum mismatch: ${OFFICIAL_SUITABILITY_NAME}`);
  }
  return collections.map((collection) => {
    const files = legacyCollectionFiles(collection.files);
    if (files.length !== collection.files.length) throw new Error(`Knowledge source files are incomplete for: ${collection.name}`);
    return {
      collection: {
        scope: collection.scope,
        roleTemplate: collection.roleTemplate,
        name: collection.name,
        description: collection.description,
        classification: "internal" as const,
        externalProcessingAllowed: true,
      },
      files,
      governanceByFile: new Map(files.map((filePath) => {
        const filename = path.basename(filePath);
        return [filename, defaultGovernance(filename, wealthByFile)];
      })),
    };
  });
}

function buildImportPlan(): { items: ImportPlanItem[]; manifests: ReferencePackManifest[] } {
  if (selectedPack) {
    const selected = buildReferencePackPlan(selectedPack);
    return { items: [selected.item], manifests: [selected.manifest] };
  }
  const manifests = REFERENCE_PACKS.map((definition) => buildReferencePackPlan(definition).manifest);
  return { items: buildLegacyImportPlan(), manifests };
}

function managedKnowledgeBaseNames(items: ImportPlanItem[]): Set<string> {
  if (!selectedPack) return new Set([...LEGACY_NAMES, ...items.map((item) => item.collection.name)]);
  return new Set([
    ...selectedPack.legacyNames,
    ...items.map((item) => item.collection.name),
  ]);
}

async function importKnowledgeBase(
  item: ImportPlanItem,
  ownerUserId: number,
  ownerGroupId: number,
): Promise<{ knowledgeBaseId: string; name: string; scope: string; roleTemplate: string | null; documents: number }> {
  const base = await createKnowledgeBaseRecord({
    publicId: `kb_${nanoid(18)}`,
    ownerUserId,
    ownerGroupId,
    scope: item.collection.scope,
    isGlobal: true,
    roleTemplate: item.collection.roleTemplate,
    name: item.collection.name,
    description: item.collection.description,
    classification: item.collection.classification,
    externalProcessingAllowed: item.collection.externalProcessingAllowed,
  });
  for (const sourcePath of item.files) {
    const filename = path.basename(sourcePath);
    const extension = knowledgeExtension(filename);
    const content = readFileSync(sourcePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (filename === OFFICIAL_SUITABILITY_NAME && sha256 !== OFFICIAL_SUITABILITY_SHA256) {
      throw new Error(`Official suitability document checksum mismatch: ${filename}`);
    }
    const governance = item.governanceByFile.get(filename);
    if (!governance) throw new Error(`Missing document governance metadata: ${filename}`);
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
      externalProcessingAllowed: item.collection.externalProcessingAllowed,
      effectiveAt: governance.effectiveAt,
      expiresAt: governance.expiresAt,
    });
  }
  await queueKnowledgeIndex({ ...base, documentCount: item.files.length, status: "indexing" }, selectedPack ? "reference_pack_import" : "demo_import");
  return {
    knowledgeBaseId: base.publicId,
    name: base.name,
    scope: base.scope,
    roleTemplate: base.roleTemplate,
    documents: item.files.length,
  };
}

async function main() {
  const { items, manifests } = buildImportPlan();
  if (validateOnly) {
    console.log(JSON.stringify({
      ok: true,
      mode: "validate",
      selectedPack: selectedPack?.key || null,
      referencePacks: manifests.map((manifest) => ({
        rolePackId: manifest.rolePackId,
        roleTemplate: manifest.roleTemplate,
        assets: manifest.assets.length,
      })),
      collections: items.map((item) => ({
        name: item.collection.name,
        roleTemplate: item.collection.roleTemplate,
        documents: item.files.length,
      })),
    }, null, 2));
    return;
  }
  if (!adoptId) {
    throw new Error("Usage: tsx scripts/import-demo-knowledge.ts --validate [--pack=wealth-manager|insurance-advisor] | --adopt-id=lgj-xxx [--pack=...]");
  }
  const claw = await getClawByAdoptId(adoptId);
  if (!claw) throw new Error(`Agent adoption not found: ${adoptId}`);
  if (selectedPack && String(claw.roleTemplate || "general-assistant") !== selectedPack.roleTemplate) {
    throw new Error(`岗位实例 ${adoptId} 属于 ${claw.roleTemplate || "general-assistant"}，不是 ${selectedPack.roleTemplate}`);
  }
  const user = await getUserById(Number(claw.userId));
  if (!user) throw new Error(`User not found: ${claw.userId}`);
  const ownerUserId = Number(user.id);
  const ownerGroupId = Number(user.groupId || 0);
  const managedNames = managedKnowledgeBaseNames(items);
  const existing = (await listKnowledgeBasesOwnedByUser(ownerUserId)).filter((item) => managedNames.has(item.name));
  for (const base of existing) {
    await deleteKnowledgeDocumentsByBase(base.id);
    await deleteKnowledgeBaseRecord(base.id, ownerUserId);
    removeKnowledgeBaseFiles(base.publicId);
  }

  const imported = [];
  for (const item of items) imported.push(await importKnowledgeBase(item, ownerUserId, ownerGroupId));
  console.log(JSON.stringify({
    ok: true,
    adoptId,
    selectedPack: selectedPack?.key || null,
    removed: existing.map((base) => ({ id: base.publicId, name: base.name })),
    imported,
  }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
