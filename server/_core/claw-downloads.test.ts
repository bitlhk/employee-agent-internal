import { describe, expect, it } from "vitest";
import { inlinePreviewSecurityHeaders } from "./claw-downloads";

describe("inline preview response security", () => {
  it("locks generated SVG previews to passive same-origin images", () => {
    const headers = inlinePreviewSecurityHeaders("generated-chart.svg");

    expect(headers["Content-Security-Policy"]).toContain("script-src 'none'");
    expect(headers["Content-Security-Policy"]).toContain("connect-src 'none'");
    expect(headers["Content-Security-Policy"]).toContain("form-action 'none'");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
  });

  it("does not override the media policy for passive preview formats", () => {
    expect(inlinePreviewSecurityHeaders("report.pdf")).toEqual({});
    expect(inlinePreviewSecurityHeaders("diagram.png")).toEqual({});
  });
});
