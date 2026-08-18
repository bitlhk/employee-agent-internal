import "dotenv/config";
import { createHash } from "crypto";
import { chmodSync, copyFileSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import {
  createKnowledgeBaseRecord,
  createKnowledgeDocumentRecord,
  deleteKnowledgeBaseRecord,
  deleteKnowledgeDocumentsByBase,
  getClawByAdoptId,
  getUserById,
  listGlobalRoleKnowledgeBases,
  listKnowledgeBasesOwnedByUser,
  prepareManagedKnowledgeBaseReplacement,
} from "../server/db";
import type { KnowledgeBaseRecord } from "../server/db";
import { queueKnowledgeIndex } from "../server/_core/knowledge-service";
import {
  KNOWLEDGE_EXTENSIONS,
  knowledgeDocumentStoragePath,
  knowledgeExtension,
  knowledgeMimeType,
  removeKnowledgeBaseFiles,
} from "../server/_core/knowledge-storage";
import {
  REFERENCE_ROLE_PACKS,
  referenceRoleTaskIdPattern,
} from "../server/_core/reference-role-pack-registry";

type KnowledgeClassification = "public" | "internal" | "sensitive" | "restricted";
type KnowledgeAuthority = "official" | "approved" | "reference" | "personal";
type KnowledgeLifecycle = "active" | "expired" | "archived";

export type ReferenceKnowledgeAsset = {
  assetId: string;
  documentSeriesId?: string | null;
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
  sourceAssetId: string | null;
  documentSeriesId: string | null;
  supersedesAssetId: string | null;
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
  key: string;
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
  ...REFERENCE_ROLE_PACKS.map((definition) => ({
    key: definition.key,
    roleTemplate: definition.roleTemplate,
    manifestPath: path.resolve(APP_ROOT, "examples", definition.packDirectory, "knowledge", "manifest.json"),
    sourceDir: path.resolve(APP_ROOT, definition.knowledgeSourceDirectory),
    taskIdPattern: referenceRoleTaskIdPattern(definition),
    legacyNames: [...definition.legacyKnowledgeBaseNames],
    fallbackKnowledgeBase: definition.fallbackKnowledgeBase,
  })),
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
  "保险顾问岗位知识（演示）",
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
  validateReferenceKnowledgeVersionGraph(manifest.assets);
}

export function validateReferenceKnowledgeVersionGraph(assets: ReferenceKnowledgeAsset[]): void {
  const assetsById = new Map(assets.map((asset) => [asset.assetId, asset]));
  for (const asset of assets) {
    if (asset.supersedes) {
      const previous = assetsById.get(asset.supersedes)!;
      if (previous.supersededBy && previous.supersededBy !== asset.assetId) {
        throw new Error(`Inconsistent replacement chain between ${asset.assetId} and ${previous.assetId}`);
      }
    }
    if (asset.supersededBy) {
      const next = assetsById.get(asset.supersededBy)!;
      if (next.supersedes && next.supersedes !== asset.assetId) {
        throw new Error(`Inconsistent replacement chain between ${asset.assetId} and ${next.assetId}`);
      }
    }
  }
  const series = resolveReferenceKnowledgeSeries(assets);
  const activeBySeries = new Map<string, ReferenceKnowledgeAsset[]>();
  for (const asset of assets.filter((item) => item.lifecycle === "active")) {
    const seriesId = series.get(asset.assetId)!;
    activeBySeries.set(seriesId, [...(activeBySeries.get(seriesId) || []), asset]);
  }
  for (const [seriesId, assets] of activeBySeries) {
    for (let leftIndex = 0; leftIndex < assets.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < assets.length; rightIndex += 1) {
        const left = assets[leftIndex];
        const right = assets[rightIndex];
        const leftStart = left.effectiveAt ? Date.parse(left.effectiveAt) : Number.NEGATIVE_INFINITY;
        const leftEnd = left.expiresAt ? Date.parse(left.expiresAt) : Number.POSITIVE_INFINITY;
        const rightStart = right.effectiveAt ? Date.parse(right.effectiveAt) : Number.NEGATIVE_INFINITY;
        const rightEnd = right.expiresAt ? Date.parse(right.expiresAt) : Number.POSITIVE_INFINITY;
        if (Math.max(leftStart, rightStart) < Math.min(leftEnd, rightEnd)) {
          throw new Error(`Overlapping active knowledge versions in ${seriesId}: ${left.assetId}, ${right.assetId}`);
        }
      }
    }
  }
}

export function resolveReferenceKnowledgeSeries(assets: ReferenceKnowledgeAsset[]): Map<string, string> {
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  const resolved = new Map<string, string>();
  const visiting = new Set<string>();
  const visit = (assetId: string): string => {
    const cached = resolved.get(assetId);
    if (cached) return cached;
    if (visiting.has(assetId)) throw new Error(`Cyclic knowledge replacement chain at ${assetId}`);
    const asset = byId.get(assetId);
    if (!asset) throw new Error(`Unknown knowledge asset ${assetId}`);
    visiting.add(assetId);
    const seriesId = String(asset.documentSeriesId || "").trim()
      || (asset.supersedes ? visit(asset.supersedes) : asset.assetId);
    visiting.delete(assetId);
    resolved.set(assetId, seriesId);
    return seriesId;
  };
  for (const asset of assets) visit(asset.assetId);
  return resolved;
}

function statSafeIsFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function governanceFromAsset(asset: ReferenceKnowledgeAsset, seriesByAsset: Map<string, string>): DocumentGovernance {
  return {
    sourceAssetId: asset.assetId,
    documentSeriesId: seriesByAsset.get(asset.assetId) || asset.assetId,
    supersedesAssetId: asset.supersedes || null,
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
  const seriesByAsset = resolveReferenceKnowledgeSeries(manifest.assets);
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
      governanceByFile: new Map(manifest.assets.map((asset) => [asset.file, governanceFromAsset(asset, seriesByAsset)])),
    },
  };
}

function defaultGovernance(
  filename: string,
  wealthByFile: Map<string, ReferenceKnowledgeAsset>,
  wealthSeries: Map<string, string>,
): DocumentGovernance {
  if (filename === OFFICIAL_SUITABILITY_NAME) {
    return {
      sourceAssetId: null,
      documentSeriesId: null,
      supersedesAssetId: null,
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
  if (referenceAsset) return governanceFromAsset(referenceAsset, wealthSeries);
  return {
    sourceAssetId: null,
    documentSeriesId: null,
    supersedesAssetId: null,
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
  const wealthSeries = resolveReferenceKnowledgeSeries(wealthManifest.assets);
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
      roleTemplate: "credential-compliance",
      name: "审核专员岗位知识（演示）",
      description: "审核专员适用的票据附件、客户尽调、信息保护与审批职责示例知识。",
      files: ["03", "05", "06", "09", "10"],
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
        return [filename, defaultGovernance(filename, wealthByFile, wealthSeries)];
      })),
    };
  });
}

function buildImportPlan(): { items: ImportPlanItem[]; manifests: ReferencePackManifest[] } {
  if (selectedPack) {
    const selected = buildReferencePackPlan(selectedPack);
    return { items: [selected.item], manifests: [selected.manifest] };
  }
  const referencePlans = REFERENCE_PACKS.map((definition) => buildReferencePackPlan(definition));
  return {
    items: [...referencePlans.map((plan) => plan.item), ...buildLegacyImportPlan()],
    manifests: referencePlans.map((plan) => plan.manifest),
  };
}

function managedKnowledgeBaseNames(items: ImportPlanItem[]): Set<string> {
  if (!selectedPack) return new Set([
    ...LEGACY_NAMES,
    ...REFERENCE_PACKS.flatMap((definition) => definition.legacyNames),
    ...items.map((item) => item.collection.name),
  ]);
  return new Set([
    ...selectedPack.legacyNames,
    ...items.map((item) => item.collection.name),
  ]);
}

export function selectCanonicalReferenceKnowledgeBase<T extends Pick<KnowledgeBaseRecord, "id" | "name" | "status">>(
  bases: T[],
  targetName: string,
): { canonical: T | null; duplicates: T[] } {
  const ordered = bases.slice().sort((left, right) => {
    const leftNameRank = left.name === targetName ? 0 : 1;
    const rightNameRank = right.name === targetName ? 0 : 1;
    if (leftNameRank !== rightNameRank) return leftNameRank - rightNameRank;
    const leftStatusRank = left.status === "ready" ? 0 : 1;
    const rightStatusRank = right.status === "ready" ? 0 : 1;
    return leftStatusRank - rightStatusRank || left.id - right.id;
  });
  return { canonical: ordered[0] || null, duplicates: ordered.slice(1) };
}

async function populateKnowledgeBase(
  item: ImportPlanItem,
  base: KnowledgeBaseRecord,
): Promise<{ knowledgeBaseId: string; name: string; scope: string; roleTemplate: string | null; documents: number }> {
  const documentIdByFile = new Map(item.files.map((sourcePath) => [path.basename(sourcePath), `doc_${nanoid(18)}`]));
  const documentIdByAsset = new Map<string, string>();
  for (const [filename, governance] of item.governanceByFile) {
    if (governance.sourceAssetId) documentIdByAsset.set(governance.sourceAssetId, documentIdByFile.get(filename)!);
  }
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
    const documentPublicId = documentIdByFile.get(filename)!;
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
      sourceAssetId: governance.sourceAssetId,
      documentSeriesId: governance.documentSeriesId,
      supersedesDocumentId: governance.supersedesAssetId
        ? documentIdByAsset.get(governance.supersedesAssetId) || null
        : null,
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
  await queueKnowledgeIndex(
    {
      ...base,
      name: item.collection.name,
      description: item.collection.description,
      classification: item.collection.classification,
      externalProcessingAllowed: item.collection.externalProcessingAllowed,
      status: "indexing",
      documentCount: item.files.length,
      chunkCount: 0,
      lastError: null,
    },
    selectedPack ? "reference_pack_import" : "demo_import",
  );
  return {
    knowledgeBaseId: base.publicId,
    name: item.collection.name,
    scope: base.scope,
    roleTemplate: base.roleTemplate,
    documents: item.files.length,
  };
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
  return populateKnowledgeBase(item, base);
}

async function replaceKnowledgeBase(
  item: ImportPlanItem,
  base: KnowledgeBaseRecord,
): ReturnType<typeof populateKnowledgeBase> {
  await deleteKnowledgeDocumentsByBase(base.id);
  removeKnowledgeBaseFiles(base.publicId);
  await prepareManagedKnowledgeBaseReplacement({
    id: base.id,
    ownerUserId: base.ownerUserId,
    name: item.collection.name,
    description: item.collection.description,
    classification: item.collection.classification,
    externalProcessingAllowed: item.collection.externalProcessingAllowed,
  });
  return populateKnowledgeBase(item, base);
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
    throw new Error(`Usage: tsx scripts/import-demo-knowledge.ts --validate [--pack=${REFERENCE_PACKS.map((pack) => pack.key).join("|")}] | --adopt-id=lgj-xxx [--pack=...]`);
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
  const removed: KnowledgeBaseRecord[] = [];
  const reused: KnowledgeBaseRecord[] = [];
  const imported = [];
  if (selectedPack) {
    const item = items[0];
    const existing = (await listGlobalRoleKnowledgeBases(selectedPack.roleTemplate))
      .filter((base) => managedNames.has(base.name));
    const { canonical, duplicates } = selectCanonicalReferenceKnowledgeBase(existing, item.collection.name);
    for (const base of duplicates) {
      await deleteKnowledgeDocumentsByBase(base.id);
      await deleteKnowledgeBaseRecord(base.id, base.ownerUserId);
      removeKnowledgeBaseFiles(base.publicId);
      removed.push(base);
    }
    if (canonical) {
      imported.push(await replaceKnowledgeBase(item, canonical));
      reused.push(canonical);
    } else {
      imported.push(await importKnowledgeBase(item, ownerUserId, ownerGroupId));
    }
  } else {
    const existing = (await listKnowledgeBasesOwnedByUser(ownerUserId)).filter((item) => managedNames.has(item.name));
    for (const base of existing) {
      await deleteKnowledgeDocumentsByBase(base.id);
      await deleteKnowledgeBaseRecord(base.id, ownerUserId);
      removeKnowledgeBaseFiles(base.publicId);
      removed.push(base);
    }
    for (const item of items) imported.push(await importKnowledgeBase(item, ownerUserId, ownerGroupId));
  }
  console.log(JSON.stringify({
    ok: true,
    adoptId,
    selectedPack: selectedPack?.key || null,
    reused: reused.map((base) => ({ id: base.publicId, name: base.name, ownerUserId: base.ownerUserId })),
    removed: removed.map((base) => ({ id: base.publicId, name: base.name, ownerUserId: base.ownerUserId })),
    imported,
  }, null, 2));
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
