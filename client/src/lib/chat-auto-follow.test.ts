import { describe, expect, it } from "vitest";
import { shouldAutoFollowChat } from "./chat-auto-follow";

describe("shouldAutoFollowChat", () => {
  it("follows streaming output only while the reader remains near the bottom", () => {
    expect(shouldAutoFollowChat(false, true)).toBe(true);
    expect(shouldAutoFollowChat(false, false)).toBe(false);
  });

  it("keeps the viewport fixed after manual navigation", () => {
    expect(shouldAutoFollowChat(true, true)).toBe(false);
    expect(shouldAutoFollowChat(true, false)).toBe(false);
  });
});
