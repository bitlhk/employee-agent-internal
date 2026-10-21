import { describe, expect, it } from "vitest";
import { schedulingConfirmations } from "./scheduling-confirmations";
const id = "00000000-0000-4000-8000-000000000001";
const receipt = (name: string, data: unknown) => ({
  name,
  status: "done",
  result: JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(data) }],
  }),
});
describe("conversation scheduling confirmations", () => {
  it("accepts the installed runtime's prefixed name and Python result wrapper without evaluating it", () => {
    expect(
      schedulingConfirmations([
        {
          name: "mcp_platform_tools_prepare_personal_schedule_write",
          status: "done",
          result: `{'result': '${JSON.stringify({ data: { draftId: id } })}'}`,
        },
      ])
    ).toEqual([{ kind: "draft", id }]);
    expect(
      schedulingConfirmations([
        {
          name: "mcp_platform_tools_prepare_personal_schedule_write",
          status: "done",
          result: "__import__('os').system('not executed')",
        },
      ])
    ).toEqual([]);
  });
  it("recognizes typed tool receipts for personal writes, invitations, reschedules and cascades", () => {
    expect(
      schedulingConfirmations([
        receipt("prepare_personal_schedule_write", { data: { draftId: id } }),
        receipt("mcp__platform_tools__prepare_meeting_invitation", {
          meetingId: id,
        }),
        receipt("prepare_meeting_reschedule", { draftId: id }),
        receipt("prepare_schedule_cascade", { id }),
      ])
    ).toEqual(
      ["draft", "meeting", "reschedule", "cascade"].map(kind => ({ kind, id }))
    );
  });
  it("never derives actions from model prose, unknown tools or failed and suppressed results", () => {
    expect(
      schedulingConfirmations([
        receipt("unknown", { draftId: id }),
        {
          ...receipt("prepare_personal_schedule_write", { draftId: id }),
          status: "error",
        },
        {
          ...receipt("prepare_personal_schedule_write", { draftId: id }),
          suppressedOriginalResult: true,
        },
        receipt("prepare_personal_schedule_write", {
          isError: true,
          draftId: id,
        }),
        receipt("prepare_personal_schedule_write", { draftId: "bad-id" }),
        {
          name: "prepare_personal_schedule_write",
          status: "done",
          result: `Confirm /calendar?draftId=${id}`,
        },
      ])
    ).toEqual([]);
  });
  it("deduplicates replayed receipts and rejects excessive wrapper nesting", () => {
    const tool = receipt("prepare_personal_schedule_write", { draftId: id });
    expect(schedulingConfirmations([tool, tool])).toEqual([
      { kind: "draft", id },
    ]);
    let data: unknown = { draftId: id };
    for (let i = 0; i < 9; i++) data = { data };
    expect(
      schedulingConfirmations([
        receipt("prepare_personal_schedule_write", data),
      ])
    ).toEqual([]);
  });
});
