import "dotenv/config";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ROOT } from "../server/_core/helpers";

const args = process.argv.slice(2);
const markerName = ".grace-filesystem-connector-demo.state";

function argument(name: string, fallback = ""): string {
  const prefix = `--${name}=`;
  return args.find(item => item.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function allowedRoots(): string[] {
  return String(process.env.ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS || path.join(APP_ROOT, "data", "enterprise-connectors"))
    .split(path.delimiter).map(item => path.resolve(item.trim())).filter(Boolean);
}

async function exists(filename: string): Promise<boolean> {
  try { await access(filename); return true; } catch { return false; }
}

async function requireMarker(root: string): Promise<void> {
  if (!await exists(path.join(root, markerName))) throw new Error("演示目录没有 GRACE marker；先执行 --step=1");
}

function document(index: number, revision = 0): string {
  return [
    `# 演示银行财富制度 ${String(index).padStart(2, "0")} V1.0`,
    "",
    `适用部门：财富管理部`,
    `当前内容修订：${revision}`,
    "本文件仅用于 Filesystem Connector 生命周期演示。",
    "",
  ].join("\n");
}

async function main() {
  const step = Number(argument("step"));
  if (![1, 2, 3, 4].includes(step)) throw new Error("使用 --step=1|2|3|4");
  const root = path.resolve(argument("root", path.join(APP_ROOT, "data", "enterprise-connectors", "demo-bank-nas")));
  if (!allowedRoots().some(allowed => isWithin(allowed, root))) {
    throw new Error("演示目录必须位于 ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS 白名单内");
  }

  if (step === 1) {
    if (await exists(root)) {
      const entries = await readdir(root);
      if (entries.length && !entries.includes(markerName)) throw new Error("拒绝重置没有 GRACE marker 的非空目录");
      await rm(root, { recursive: true, force: true });
    }
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, markerName), JSON.stringify({ schema: "ea.filesystem-connector-demo.v1", createdAt: new Date().toISOString() }, null, 2));
    for (let index = 1; index <= 10; index += 1) {
      await writeFile(path.join(root, `wealth-policy-${String(index).padStart(2, "0")}-V1.0.md`), document(index));
    }
  } else {
    await requireMarker(root);
    if (step === 2) {
      await writeFile(path.join(root, "wealth-policy-01-V1.0.md"), document(1, 1));
      await writeFile(path.join(root, "wealth-policy-02-V1.0.md"), document(2, 1));
      await writeFile(path.join(root, "wealth-policy-11-V1.0.md"), document(11));
    }
    if (step === 3) {
      await rename(path.join(root, "wealth-policy-03-V1.0.md"), path.join(root, "renamed-wealth-policy-03-V1.0.md"));
    }
    if (step === 4) await rm(path.join(root, "wealth-policy-04-V1.0.md"));
  }

  const expectations = {
    1: { new: 10, revision: 0, metadataChanged: 0, skipped: 0, tombstone: 0 },
    2: { new: 1, revision: 2, metadataChanged: 0, skipped: 8, tombstone: 0 },
    3: { new: 0, revision: 0, metadataChanged: 1, skipped: 10, tombstone: 0 },
    4: { new: 0, revision: 0, metadataChanged: 0, skipped: 10, tombstone: 1 },
  } as const;
  console.log(JSON.stringify({
    schema: "ea.filesystem-connector-demo-step.v1",
    step,
    root,
    sourceUri: pathToFileURL(root).href,
    expectedAfterNextFullSync: expectations[step as keyof typeof expectations],
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
