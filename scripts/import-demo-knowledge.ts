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

const LEGACY_NAMES = new Set(["金融机构运营制度演示库"]);
const COLLECTIONS = [
  {
    scope: "enterprise" as const,
    roleTemplate: null,
    name: "企业差旅与合规制度（演示）",
    description: "面向全员的差旅报销、发票附件、客户信息保护、员工申报与审批职责示例制度。",
    files: ["01", "02", "03", "06", "09", "10", "SOURCES"],
  },
  {
    scope: "role" as const,
    roleTemplate: "wealth-manager",
    name: "财富经理岗位知识（演示）",
    description: "财富经理适用的客户适当性、反洗钱、信息保护与投资研究合规示例知识。",
    files: ["04", "05", "06", "08", "09", "SOURCES"],
  },
  {
    scope: "role" as const,
    roleTemplate: "post-loan-risk-control",
    name: "风控经理岗位知识（演示）",
    description: "风控经理适用的客户尽调、数据保护、贷后预警与升级处置示例知识。",
    files: ["05", "06", "07", "09", "10", "SOURCES"],
  },
  {
    scope: "role" as const,
    roleTemplate: "credential-compliance",
    name: "审核专员岗位知识（演示）",
    description: "审核专员适用的票据附件、客户尽调、信息保护与审批职责示例知识。",
    files: ["03", "05", "06", "09", "10", "SOURCES"],
  },
  {
    scope: "role" as const,
    roleTemplate: "insurance-advisor",
    name: "保险顾问岗位知识（演示）",
    description: "保险顾问适用的产品适当性、客户尽调、信息保护与员工申报示例知识。",
    files: ["04", "05", "06", "09", "SOURCES"],
  },
  {
    scope: "role" as const,
    roleTemplate: "investment-researcher",
    name: "投顾分析岗位知识（演示）",
    description: "投顾分析适用的数据保护、投资研究合规与利益冲突申报示例知识。",
    files: ["06", "08", "09", "SOURCES"],
  },
] as const;

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

async function main() {
  if (!adoptId) throw new Error("Usage: pnpm tsx scripts/import-demo-knowledge.ts --adopt-id=lgj-xxx");
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
  for (const collection of COLLECTIONS) {
    const files = collectionFiles(collection.files);
    const base = await createKnowledgeBaseRecord({
      publicId: `kb_${nanoid(18)}`,
      ownerUserId,
      ownerGroupId,
      scope: collection.scope,
      isGlobal: true,
      roleTemplate: collection.roleTemplate,
      name: collection.name,
      description: collection.description,
    });
    for (const sourcePath of files) {
      const filename = path.basename(sourcePath);
      const extension = knowledgeExtension(filename);
      const content = readFileSync(sourcePath);
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
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
    await queueKnowledgeIndex({ ...base, documentCount: files.length, status: "indexing" });
    imported.push({ knowledgeBaseId: base.publicId, name: base.name, scope: base.scope, roleTemplate: base.roleTemplate, documents: files.length });
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, adoptId, removed: existing.length, imported }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
