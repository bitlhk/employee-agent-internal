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
const sourceDir = path.resolve(process.cwd(), "examples", "financial-enterprise-knowledge-demo");

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
    description: "财富经理岗位内部操作口径、销售规范与官方监管法规。",
    files: ["04", "08", "11"],
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
    };
  }
  return {
    versionLabel: "演示版 1.0",
    sourceDepartment: "演示业务规范",
    classification: "internal" as const,
    authority: "reference" as const,
    effectiveAt: null,
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
  if (!adoptId) throw new Error("Usage: pnpm tsx scripts/import-demo-knowledge.ts --adopt-id=lgj-xxx");
  // Validate bundled assets before removing an existing demo import.
  const importPlan = buildImportPlan();
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
        lifecycle: "active",
        sourceDepartment: governance.sourceDepartment,
        classification: governance.classification,
        authority: governance.authority,
        externalProcessingAllowed: true,
        effectiveAt: governance.effectiveAt,
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
