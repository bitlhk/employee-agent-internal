import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { skillInstaller } from "./skill-installer";
import { safeSkillStorePath, skillStorePath } from "./skill-store";

export type SkillArtifactDigest = {
  sha256: string;
  size: number;
};

export function digestSkillSourceTree(sourcePath: string): SkillArtifactDigest {
  const hash = createHash("sha256");
  const root = realpathSync(sourcePath);
  let size = 0;

  function visit(current: string, relative: string): void {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`symbolic link is not digestible: ${relative || "."}`);
    }
    if (stat.isDirectory()) {
      hash.update(`D\0${relative}\0`);
      for (const name of readdirSync(current).sort()) {
        visit(path.join(current, name), path.join(relative, name));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`unsupported artifact entry: ${relative || "."}`);
    }
    const content = readFileSync(current);
    size += content.length;
    hash.update(`F\0${relative}\0${content.length}\0`);
    hash.update(content);
    hash.update("\0");
  }

  visit(root, "");
  return { sha256: hash.digest("hex"), size };
}

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
