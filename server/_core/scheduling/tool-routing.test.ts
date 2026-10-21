import { describe, expect, it } from "vitest";
import { SCHEDULING_PLATFORM_TOOLS } from "./platform-tools";

describe("scheduling collaboration routing", () => {
  it("does not advertise legacy coordination that bypasses assistant consent and continuation", () => {
    const names = SCHEDULING_PLATFORM_TOOLS.map(tool => tool.name);
    expect(names).not.toContain("coordinate_meeting_times");
    expect(names).not.toContain("list_meeting_coordinations");
    expect(names).toContain("query_own_schedules");
    expect(names).toContain("prepare_meeting_reschedule");
    expect(names).toContain("prepare_meeting_invitation");
  });
});
