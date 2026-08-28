import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aggregateSkillQualityRuntimeSmokes } from "../server/_core/skill-quality-evaluation-runtime-aggregate";

function reportPaths(): string[] {
  return process.argv
    .filter(value => value.startsWith("--report="))
    .map(value => path.resolve(value.slice("--report=".length)));
}

function markdown(report: ReturnType<typeof aggregateSkillQualityRuntimeSmokes>): string {
  return [
    "# Skill Quality Phase 1B Runtime Smoke Aggregate",
    "",
    `- Status: **${report.status}**`,
    `- Profile fingerprint: \`${report.profileFingerprint}\``,
    `- Suite fingerprint: \`${report.suiteFingerprint}\``,
    `- Aggregate fingerprint: \`${report.aggregateFingerprint}\``,
    "- Result semantics: **Runtime integration evidence / non-certifying**",
    "",
    "| Arm | Adoption | Runtime identity | Source report | ms | Events |",
    "|---|---|---|---|---:|---:|",
    ...report.arms.map(arm =>
      `| ${arm.executionArm} | ${arm.adoptionId} | ${arm.runtimeIdentityFingerprint.slice(0, 12)} | ${arm.sourceReportFingerprint.slice(0, 12)} | ${arm.elapsedMs} | ${arm.eventCount} |`
    ),
    "",
    "This aggregate proves three isolated EA Runtime turns used the frozen target, no-Skill and previous-version identities. It does not certify the Skill: the full Suite, native fixture control, runner hard gates, Judge calibration and expert validation remain pending.",
    "",
  ].join("\n");
}

function main(): void {
  const paths = reportPaths();
  const reports = paths.map(filePath => JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  const report = aggregateSkillQualityRuntimeSmokes(reports);
  const outputRoot = path.resolve(
    process.env.EA_SKILL_EVAL_RUNTIME_REPORT_DIR ||
      path.join(
        process.cwd(),
        "reports",
        "skill-quality-evaluation-runtime",
        `aggregate-${new Date().toISOString().replace(/[-:.]/gu, "")}`
      )
  );
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(path.join(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(outputRoot, "report.md"), markdown(report));
  console.log(JSON.stringify({ status: report.status, outputRoot, aggregateFingerprint: report.aggregateFingerprint }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
