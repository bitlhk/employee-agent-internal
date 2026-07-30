import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSafeSandboxOutputFiles } from "./sandbox";
import {
  buildSandboxDockerRunArgs,
  resolveSandboxContainerIdentity,
  sandboxCommandBlockReason,
} from "./sandbox-policy";

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

  it("keeps the container isolated and drops invalid environment names", () => {
    const args = buildSandboxDockerRunArgs({
      containerName: "sb-test",
      identity: { uid: 2000, gid: 3000, value: "2000:3000" },
      image: "python:3.11-slim",
      memory: "256m",
      cpus: "0.5",
      pidsLimit: 50,
      tmpfsSize: "50m",
      env: {
        SAFE_VALUE: "ok",
        "INVALID-NAME": "ignored",
      },
      outputMount: "/tmp/output",
    });

    expect(args).toEqual(expect.arrayContaining([
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=2000:3000",
      "--env=HOME=/tmp",
      "--env=SAFE_VALUE=ok",
      "-v",
      "/tmp/output:/output",
    ]));
    expect(args.some((arg) => arg.includes("INVALID-NAME"))).toBe(false);
    expect(args.slice(-4)).toEqual(["python:3.11-slim", "sh", "-c", "sleep 30"]);
  });

  it("blocks commands that attempt privilege or namespace changes", () => {
    expect(sandboxCommandBlockReason("python report.py")).toBeNull();
    expect(sandboxCommandBlockReason("sudo cat /etc/shadow")).toContain("sudo");
    expect(sandboxCommandBlockReason("nsenter --target 1 --mount")).toContain("nsenter");
    expect(sandboxCommandBlockReason("chmod u+s helper")).toContain("chmod");
  });
});
