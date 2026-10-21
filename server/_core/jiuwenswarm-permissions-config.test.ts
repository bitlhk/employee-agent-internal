import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
const state = vi.hoisted(() => ({ home: "" }));
vi.mock("./helpers", () => ({
  get JIUWENCLAW_HOME() {
    return state.home;
  },
}));
import { ensureJiuwenSwarmWorkspacePermission } from "./jiuwenswarm-permissions";
beforeEach(() => {
  state.home = mkdtempSync(path.join(os.tmpdir(), "ea-permission-config-"));
  mkdirSync(path.join(state.home, "config"));
});
afterEach(() => rmSync(state.home, { recursive: true, force: true }));
describe("workspace permissions retain the existing global policy", () => {
  it.each(["\n", "\r\n"])(
    "handles %j without duplicating the permissions section",
    newline => {
      const config = path.join(state.home, "config", "config.yaml");
      writeFileSync(
        config,
        [
          "permissions:",
          "  enabled: false",
          "  schema: tiered_policy",
          "  defaults:",
          "    '*': deny",
          "  tools:",
          "    bash: ask",
          "models:",
          "  defaults: []",
          "",
        ].join(newline)
      );
      const workspace = path.join(state.home, "workspace");
      ensureJiuwenSwarmWorkspacePermission(workspace);
      const saved = readFileSync(config, "utf8");
      expect(saved.match(/^permissions:/gm)).toHaveLength(1);
      expect(saved).toContain("  enabled: false");
      expect(saved).toContain("    '*': deny");
      expect(saved).toContain("    bash: ask");
      expect(saved).toContain("models:");
      expect(saved).toContain(workspace.replace(/\\/g, "/"));
      expect(ensureJiuwenSwarmWorkspacePermission(workspace).changed).toBe(
        false
      );
      expect(readFileSync(config, "utf8")).toBe(saved);
    }
  );
});
