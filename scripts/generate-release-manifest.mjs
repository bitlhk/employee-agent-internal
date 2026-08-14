import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sortedDependencies(value) {
  return Object.fromEntries(
    Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

const output = argument("--output");
const releaseId = argument("--release-id");
const sourceCommit = argument("--source-commit");
const sourceRepository = argument("--source-repository");
const createdAt = argument("--created-at");
if (!output || !releaseId || !sourceCommit || !sourceRepository || !createdAt) {
  throw new Error("output, release-id, source-commit, source-repository, and created-at are required");
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository)) {
  throw new Error("source-repository must be a GitHub owner/repository pair");
}

const packageText = await readFile("package.json", "utf8");
const lockfileText = await readFile("pnpm-lock.yaml", "utf8");
const packageJson = JSON.parse(packageText);
const manifest = {
  schema: 3,
  releaseId,
  sourceCommit,
  sourceRepository,
  createdAt,
  packageManager: packageJson.packageManager,
  packageJsonSha256: sha256(packageText),
  lockfileSha256: sha256(lockfileText),
  dependencies: sortedDependencies(packageJson.dependencies),
  devDependencies: sortedDependencies(packageJson.devDependencies),
};

await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
