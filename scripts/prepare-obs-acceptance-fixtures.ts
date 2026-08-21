import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const markerName = ".grace-obs-acceptance.state.json";
const manifestName = "acceptance-manifest.json";
const BULK_COUNT = 1_005;
const LARGE_FILE_BYTES = 16 * 1024 * 1024;

type Phase = "baseline" | "mutation" | "deletion";

type State = {
  schema: "ea.obs-environment-acceptance-fixture-state.v1";
  acceptanceId: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
};

function argument(name: string, fallback = ""): string {
  const prefix = `--${name}=`;
  return args.find(item => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
}

function phaseArgument(): Phase {
  const value = argument("phase");
  if (!new Set(["baseline", "mutation", "deletion"]).has(value)) {
    throw new Error("使用 --phase=baseline|mutation|deletion");
  }
  return value as Phase;
}

async function exists(filename: string): Promise<boolean> {
  try { await access(filename); return true; } catch { return false; }
}

function safeAcceptanceId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(normalized)) {
    throw new Error("acceptance-id 只能使用 3-48 位小写字母、数字和连字符");
  }
  return normalized;
}

function bulkKey(index: number): string {
  return `bulk/policy-${String(index).padStart(4, "0")}-V1.0.md`;
}

function policy(index: number, revision = 0): string {
  return [
    `# 华为云 OBS 验收制度 ${String(index).padStart(4, "0")} V1.0`,
    "",
    "适用部门：财富管理部",
    "适用岗位：财富经理",
    `验收修订：${revision}`,
    "本文件仅用于 GRACE OBS Connector 非生产环境验收。",
    "",
  ].join("\n");
}

async function writeObject(objectsRoot: string, key: string, content: string | Buffer): Promise<void> {
  const filename = path.join(objectsRoot, ...key.split("/"));
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

async function readState(root: string): Promise<State> {
  const marker = path.join(root, markerName);
  if (!await exists(marker)) throw new Error("验收目录没有 GRACE marker；先执行 --phase=baseline");
  return JSON.parse(await readFile(marker, "utf8")) as State;
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listFiles(root, next));
    else if (entry.isFile()) result.push(next);
  }
  return result.sort();
}

async function fileEvidence(objectsRoot: string, key: string) {
  const filename = path.join(objectsRoot, ...key.split("/"));
  const [content, info] = await Promise.all([readFile(filename), stat(filename)]);
  return {
    key,
    sizeBytes: info.size,
    sha256: createHash("sha256").update(content).digest("hex"),
    scenario: key.startsWith("bulk/") ? "pagination" : key.startsWith("multipart/") ? "multipart" : key.startsWith("unsupported/") ? "unsupported" : "special_key",
  };
}

async function resetBaseline(root: string, acceptanceId: string): Promise<State> {
  if (await exists(root)) {
    const entries = await readdir(root);
    if (entries.length && !entries.includes(markerName)) {
      throw new Error("拒绝重置没有 GRACE marker 的非空目录");
    }
    await rm(root, { recursive: true, force: true });
  }
  const objectsRoot = path.join(root, "objects");
  await mkdir(objectsRoot, { recursive: true });
  for (let index = 1; index <= BULK_COUNT; index += 1) {
    await writeObject(objectsRoot, bulkKey(index), policy(index));
  }
  await writeObject(objectsRoot, "中文目录/私人银行 销售办法（试行）V1.0.md", policy(2_001));
  await writeObject(objectsRoot, "特殊字符/产品+规则#补充%25?问答-V1.0.md", policy(2_002));
  await writeObject(objectsRoot, "nested/space name/[draft]-policy_V1.0.md", policy(2_003));
  const largeHeader = Buffer.from(policy(3_001));
  const large = Buffer.alloc(LARGE_FILE_BYTES, 0x41);
  largeHeader.copy(large, 0, 0, Math.min(largeHeader.length, large.length));
  await writeObject(objectsRoot, "multipart/large-policy-V1.0.md", large);
  await writeObject(objectsRoot, "unsupported/should-be-skipped.tmp", "unsupported fixture\n");
  const now = new Date().toISOString();
  return {
    schema: "ea.obs-environment-acceptance-fixture-state.v1",
    acceptanceId,
    phase: "baseline",
    createdAt: now,
    updatedAt: now,
  };
}

async function applyMutation(root: string, state: State): Promise<State> {
  if (state.phase !== "baseline") throw new Error("mutation 必须紧接 baseline，并在 baseline 已完成 OBS 同步后执行");
  const objectsRoot = path.join(root, "objects");
  await writeObject(objectsRoot, bulkKey(1), policy(1, 1));
  await writeObject(objectsRoot, "中文目录/私人银行 销售办法（试行）V1.0.md", policy(2_001, 1));
  await writeObject(objectsRoot, bulkKey(BULK_COUNT + 1), policy(BULK_COUNT + 1));
  return { ...state, phase: "mutation", updatedAt: new Date().toISOString() };
}

async function applyDeletion(root: string, state: State): Promise<State> {
  if (state.phase !== "mutation") throw new Error("deletion 必须紧接 mutation，并在 mutation 已完成 OBS 同步后执行");
  await rm(path.join(root, "objects", ...bulkKey(2).split("/")));
  return { ...state, phase: "deletion", updatedAt: new Date().toISOString() };
}

function expected(phase: Phase) {
  if (phase === "baseline") return { listedObjects: 1_010, supportedObjects: 1_009, created: 1_009, changed: 0, unchanged: 0, tombstones: 0 };
  if (phase === "mutation") return { listedObjects: 1_011, supportedObjects: 1_010, created: 1, changed: 2, unchanged: 1_007, tombstones: 0 };
  return { listedObjects: 1_010, supportedObjects: 1_009, created: 0, changed: 0, unchanged: 1_009, tombstones: 1 };
}

async function main() {
  const phase = phaseArgument();
  const root = path.resolve(argument("root", path.join(os.tmpdir(), "grace-obs-environment-acceptance")));
  const acceptanceId = safeAcceptanceId(argument("acceptance-id", `obs-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`));
  let state = phase === "baseline" ? await resetBaseline(root, acceptanceId) : await readState(root);
  if (phase !== "baseline" && state.acceptanceId !== acceptanceId) {
    throw new Error(`acceptance-id 与现有验收目录不一致：${state.acceptanceId}`);
  }
  if (phase === "mutation") state = await applyMutation(root, state);
  if (phase === "deletion") state = await applyDeletion(root, state);
  await writeFile(path.join(root, markerName), JSON.stringify(state, null, 2));

  const objectsRoot = path.join(root, "objects");
  const keys = await listFiles(objectsRoot);
  const evidence = await Promise.all(keys.map(key => fileEvidence(objectsRoot, key)));
  const manifestBody = {
    schema: "ea.obs-environment-acceptance-fixtures.v1",
    acceptanceId: state.acceptanceId,
    phase: state.phase,
    generatedAt: state.updatedAt,
    uploadRoot: objectsRoot,
    recommendedPrefix: `grace-acceptance/${state.acceptanceId}/`,
    multipartObjectKey: "multipart/large-policy-V1.0.md",
    unsupportedObjectKey: "unsupported/should-be-skipped.tmp",
    expectedAfterNextFullSync: expected(state.phase),
    objects: evidence,
  };
  const manifestJson = JSON.stringify(manifestBody, null, 2);
  await writeFile(path.join(root, manifestName), manifestJson);
  console.log(JSON.stringify({
    ...manifestBody,
    objects: { count: evidence.length, manifestSha256: createHash("sha256").update(manifestJson).digest("hex") },
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
