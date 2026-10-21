import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

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
        // Artifact identities use portable package paths, not host separators.
        visit(path.join(current, name), path.posix.join(relative, name));
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
