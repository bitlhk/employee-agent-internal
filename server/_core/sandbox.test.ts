import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSafeSandboxOutputFiles, resolveSandboxContainerIdentity } from "./sandbox";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("sandbox isolation", () => {
  it("never chooses a root container identity", () => {
    expect(resolveSandboxContainerIdentity(undefined, 1000, 1001)).toEqual({ uid: 1000, gid: 1001, value: "1000:1001" });
    expect(resolveSandboxContainerIdentity(undefined, 0, 0)).toEqual({ uid: 65534, gid: 65534, value: "65534:65534" });
    expect(resolveSandboxContainerIdentity("0:0", 1000, 1001)).toEqual({ uid: 1000, gid: 1001, value: "1000:1001" });
    expect(resolveSandboxContainerIdentity("2000:3000", 1000, 1001)).toEqual({ uid: 2000, gid: 3000, value: "2000:3000" });
  });

  it("reports regular output files and rejects links or directories", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ea-sandbox-output-"));
    roots.push(root);
    writeFileSync(path.join(root, "result.txt"), "safe");
    mkdirSync(path.join(root, "nested"));
    symlinkSync("/etc/passwd", path.join(root, "host-file.txt"));
    symlinkSync(path.join(root, "result.txt"), path.join(root, "result-link.txt"));

    expect(collectSafeSandboxOutputFiles(root)).toEqual([{ name: "result.txt", size: 4 }]);
  });
});
