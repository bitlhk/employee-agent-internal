import { describe, expect, it } from "vitest";
import { buildTrustedApprovalContinuation } from "./approval-continuation";

describe("trusted governance approval continuation", () => {
  it("builds a server-owned immediate execution instruction", () => {
    const context = buildTrustedApprovalContinuation("apr_00000000-0000-4000-8000-000000000001");
    expect(context).toContain('trusted="true"');
    expect(context).toContain("approval_status: approved");
    expect(context).toContain("不要再次询问确认");
    expect(context).toContain("completed Execution Receipt");
  });

  it("rejects malformed approval ids", () => {
    expect(buildTrustedApprovalContinuation("apr_user_supplied")).toBe("");
  });
});
