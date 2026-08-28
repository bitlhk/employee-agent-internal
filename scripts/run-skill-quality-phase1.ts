import {
  buildWealthSkillQualityPhase1Plan,
  runWealthSkillQualityPhase1,
} from "../server/_core/skill-quality-evaluation-phase1";

const planOnly = process.argv.includes("--plan");

async function main(): Promise<void> {
  if (planOnly) {
    process.stdout.write(
      `${JSON.stringify(buildWealthSkillQualityPhase1Plan(), null, 2)}\n`
    );
    return;
  }
  let lastCompleted = 0;
  const result = await runWealthSkillQualityPhase1({
    onProgress: (completed, total) => {
      if (completed === lastCompleted) return;
      lastCompleted = completed;
      process.stderr.write(`\rSkill Quality Phase 1: ${completed}/${total}`);
    },
  });
  if (lastCompleted) process.stderr.write("\n");
  process.stdout.write(
    `${JSON.stringify(
      {
        ...result.report,
        outputRoot: result.outputRoot,
      },
      null,
      2
    )}\n`
  );
  if (
    result.report.status !== "DIAGNOSTIC_COMPLETE" ||
    result.report.targetHardGateStatus !== "PASS"
  ) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
