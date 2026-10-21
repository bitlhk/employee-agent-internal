import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SkillEvalSuiteV1 } from "../../shared/skill-quality-evaluation";
import { governanceFingerprint } from "./governance/contracts";
import { skillEvalSuiteFingerprint } from "./skill-quality-evaluation";
import type {
  ApprovedSkillInventory,
  PilotManifest,
} from "./skill-quality-evaluation-contracts";
import { digestSkillSourceTree } from "./skills/skill-artifact-digest";

/** Synthetic approved inventory for unit tests; never writes the user's Skill Store. */
export function createSkillQualityTestFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ea-quality-unit-"));
  const skillStoreRoot = path.join(root, "skill-store");
  const base = "examples/skill-quality-evaluation-v1";
  const copy = (relative: string) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    cpSync(path.resolve(relative), path.join(root, relative), {
      recursive: true,
    });
  };
  copy(base);
  copy("examples/wealth-manager-reference-role-pack/eval");
  copy("docs/wealth-manager-skill-v2-release-record.md");
  const read = <T>(relative: string): T =>
    JSON.parse(readFileSync(path.join(root, relative), "utf8"));
  const write = (relative: string, data: unknown) =>
    writeFileSync(path.join(root, relative), JSON.stringify(data, null, 2));
  const inventory = read<ApprovedSkillInventory>(
    `${base}/approved-skill-inventory.v1.json`
  );
  const replacements = new Map<string, string>();
  for (const record of inventory.records) {
    const staging = path.join(root, `${record.skillId}-${record.version}`);
    mkdirSync(staging);
    writeFileSync(
      path.join(staging, "SKILL.md"),
      `---\nname: ${record.skillId}\nversion: ${record.version}\n---\n# ${record.skillId}\n\nSynthetic unit-test fixture.\n`
    );
    const digest = digestSkillSourceTree(staging);
    replacements.set(record.artifactSha256, digest.sha256);
    record.artifactSha256 = digest.sha256;
    record.artifactSize = digest.size;
    record.artifactRelativePath = `marketplace/artifacts/${record.skillId}/${record.version}/${digest.sha256}`;
    const target = path.join(skillStoreRoot, record.artifactRelativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(staging, target, { recursive: true });
  }
  const { inventoryFingerprint: _inventoryFingerprint, ...inventoryBody } =
    inventory;
  inventory.inventoryFingerprint = governanceFingerprint(inventoryBody);
  write(`${base}/approved-skill-inventory.v1.json`, inventory);
  const manifest = read<PilotManifest>(`${base}/pilot-baselines.v1.json`);
  for (const pilot of manifest.pilots) {
    for (const ref of [pilot.target, ...pilot.baselines])
      if (ref.artifactSha256)
        ref.artifactSha256 =
          replacements.get(ref.artifactSha256) || ref.artifactSha256;
    const suite = read<SkillEvalSuiteV1>(pilot.suitePath);
    suite.targetArtifactSha256 = pilot.target.artifactSha256;
    for (const ref of suite.sourceReferences)
      if (ref.sourceType !== "approved_skill_artifact") copy(ref.reference);
    for (const ref of suite.sourceReferences)
      if (ref.sourceType === "approved_skill_artifact") {
        const digest = replacements.get(ref.contentSha256);
        if (digest) {
          ref.reference = ref.reference.replace(ref.contentSha256, digest);
          ref.contentSha256 = digest;
        }
      }
    suite.suiteFingerprint = skillEvalSuiteFingerprint(suite);
    write(pilot.suitePath, suite);
  }
  const { manifestFingerprint: _manifestFingerprint, ...manifestBody } =
    manifest;
  manifest.manifestFingerprint = governanceFingerprint(manifestBody);
  write(`${base}/pilot-baselines.v1.json`, manifest);
  return { root, skillStoreRoot };
}
