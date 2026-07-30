import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const baselineUrl = new URL("../config/module-size-baseline.json", import.meta.url);
const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
const maxUnlistedLines = Number(baseline.maxUnlistedLines);
const fileLimits = new Map(Object.entries(baseline.files || {}));
const sourceExtensions = new Set([".ts", ".tsx"]);

if (!Number.isInteger(maxUnlistedLines) || maxUnlistedLines < 1) {
  throw new Error("Invalid maxUnlistedLines module-size baseline");
}

async function collectSourceFiles(relativeDir) {
  const absoluteDir = path.join(root, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(relativePath));
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(relativePath);
    }
  }
  return files;
}

function countLines(content) {
  if (!content) return 0;
  return content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
}

const files = (await Promise.all((baseline.scope || []).map(collectSourceFiles))).flat();
const violations = [];
const measured = new Map();

for (const file of files) {
  const content = await readFile(path.join(root, file), "utf8");
  const lines = countLines(content);
  measured.set(file, lines);
  const limit = Number(fileLimits.get(file) ?? maxUnlistedLines);
  if (lines > limit) violations.push(`${file}: ${lines} > ${limit}`);
}

for (const file of fileLimits.keys()) {
  if (!measured.has(file)) violations.push(`${file}: baseline entry has no source file`);
}

if (violations.length > 0) {
  console.error(`Module size budget exceeded:\n${violations.join("\n")}`);
  process.exitCode = 1;
} else {
  const tracked = [...fileLimits.entries()]
    .map(([file, limit]) => `${file} ${measured.get(file)}/${limit}`)
    .join("\n");
  console.log(`Module size budget passed; unlisted max=${maxUnlistedLines}\n${tracked}`);
}
