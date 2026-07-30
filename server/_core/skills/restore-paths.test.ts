import { describe, expect, it } from "vitest";
import { parseRestorePathMaps, remapRestoredPath } from "./restore-paths";

describe("restore path mappings", () => {
  it("remaps an absolute path under an explicitly declared root", () => {
    const mappings = parseRestorePathMaps(["--path-map=/root/employee-agent=/srv/employee-agent"]);
    expect(remapRestoredPath("/root/employee-agent/data/skills/a", mappings))
      .toBe("/srv/employee-agent/data/skills/a");
    expect(remapRestoredPath("/root/other/data", mappings)).toBe("/root/other/data");
  });

  it("rejects malformed and filesystem-root mappings", () => {
    expect(() => parseRestorePathMaps(["--path-map=/root/employee-agent"])).toThrow("invalid restore path mapping");
    expect(() => parseRestorePathMaps(["--path-map=/=/srv/root"])).toThrow("filesystem root");
  });
});
