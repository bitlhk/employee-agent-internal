import { describe, expect, it } from "vitest";
import { conversationConfirmation } from "./confirmation-receipt";
describe("conversational confirmation placement", () => {
  it("preserves stable operation identity while removing the legacy notification navigation hint", () => {
    expect(conversationConfirmation("draft", { draftId: "own-draft", confirmationUrl: "/calendar?tab=drafts" })).toEqual({ draftId: "own-draft", confirmation: { kind: "draft", placement: "conversation" } });
  });
});
