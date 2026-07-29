import { readFile } from "node:fs/promises";
import { ESLint } from "eslint";

const baselineUrl = new URL("../config/type-debt-baseline.json", import.meta.url);
const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
const eslint = new ESLint({});
const results = await eslint.lintFiles(baseline.scope);
const warnings = results.flatMap((result) => result.messages
  .filter((message) => message.ruleId === "@typescript-eslint/no-explicit-any")
  .map((message) => ({ filePath: result.filePath, line: message.line })));

const current = warnings.length;
const allowed = Number(baseline.explicitAnyWarnings);
if (!Number.isInteger(allowed) || allowed < 0) {
  throw new Error("Invalid explicitAnyWarnings baseline");
}

if (current > allowed) {
  const byFile = new Map();
  for (const warning of warnings) {
    byFile.set(warning.filePath, (byFile.get(warning.filePath) || 0) + 1);
  }
  const topFiles = [...byFile.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([filePath, count]) => `${filePath}: ${count}`)
    .join("\n");
  console.error(`Explicit any debt increased: ${current} > ${allowed}\n${topFiles}`);
  process.exitCode = 1;
} else {
  console.log(`Explicit any debt: ${current}/${allowed}`);
}
