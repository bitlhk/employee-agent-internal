import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const baselineUrl = new URL("../config/critical-coverage-baseline.json", import.meta.url);
const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
const summaryPath = path.resolve(root, String(baseline.summaryFile || ""));
const summary = JSON.parse(await readFile(summaryPath, "utf8"));
const metrics = ["lines", "statements", "branches", "functions"];
const violations = [];
const results = [];

for (const [relativeFile, thresholds] of Object.entries(baseline.files || {})) {
  const absoluteFile = path.resolve(root, relativeFile);
  const measured = summary[absoluteFile];
  if (!measured) {
    violations.push(`${relativeFile}: missing from coverage summary`);
    continue;
  }

  const parts = [];
  for (const metric of metrics) {
    const minimum = Number(thresholds[metric]);
    const actual = Number(measured[metric]?.pct);
    if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
      throw new Error(`Invalid ${metric} threshold for ${relativeFile}`);
    }
    parts.push(`${metric}=${actual.toFixed(2)}%/${minimum}%`);
    if (!Number.isFinite(actual) || actual + Number.EPSILON < minimum) {
      violations.push(`${relativeFile} ${metric}: ${actual.toFixed(2)}% < ${minimum}%`);
    }
  }
  results.push(`${relativeFile} ${parts.join(" ")}`);
}

if (violations.length > 0) {
  console.error(`Critical coverage budget failed:\n${violations.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Critical coverage budget passed:\n${results.join("\n")}`);
}
