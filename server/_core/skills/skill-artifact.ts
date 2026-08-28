import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { skillInstaller } from "./skill-installer";
import { safeSkillStorePath, skillStorePath } from "./skill-store";
import {
  digestSkillSourceTree,
  type SkillArtifactDigest,
} from "./skill-artifact-digest";

export { digestSkillSourceTree, type SkillArtifactDigest };

export async function materializeImmutableSkillArtifact(input: {
  sourcePath: string;
  skillId: string;
  version: string;
}): Promise<SkillArtifactDigest & { artifactPath: string }> {
  const sourceDigest = digestSkillSourceTree(input.sourcePath);
  const artifactPath = safeSkillStorePath(
    skillStorePath(
      "marketplace",
      "artifacts",
      input.skillId,
      input.version,
      sourceDigest.sha256
    )
  );
  if (existsSync(artifactPath)) {
    const existing = digestSkillSourceTree(artifactPath);
    if (existing.sha256 !== sourceDigest.sha256) {
      throw new Error("immutable Skill artifact digest mismatch");
    }
    return { ...existing, artifactPath };
  }

  const temporaryPath = safeSkillStorePath(
    skillStorePath("marketplace", "artifacts", ".staging", randomUUID())
  );
  await mkdir(path.dirname(temporaryPath), { recursive: true });
  try {
    await skillInstaller.installFromSource(input.sourcePath, temporaryPath);
    const staged = digestSkillSourceTree(temporaryPath);
    if (staged.sha256 !== sourceDigest.sha256) {
      throw new Error("Skill artifact changed while it was being materialized");
    }
    await mkdir(path.dirname(artifactPath), { recursive: true });
    if (existsSync(artifactPath)) {
      await rm(temporaryPath, { recursive: true, force: true });
    } else {
      await rename(temporaryPath, artifactPath);
    }
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true }).catch(
      () => undefined
    );
    throw error;
  }
  return { ...sourceDigest, artifactPath };
}

export function verifyImmutableSkillArtifact(input: {
  artifactPath: string;
  artifactSha256: string;
}): SkillArtifactDigest {
  if (!existsSync(input.artifactPath))
    throw new Error("Skill artifact is missing");
  const digest = digestSkillSourceTree(input.artifactPath);
  if (digest.sha256 !== input.artifactSha256) {
    throw new Error(
      "Skill artifact digest does not match the approved release"
    );
  }
  return digest;
}
