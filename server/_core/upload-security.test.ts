import { describe, expect, it } from "vitest";
import { decodeBase64Strict, validateUploadContent } from "./upload-security";

describe("upload content validation", () => {
  it("rejects malformed base64", () => {
    expect(decodeBase64Strict("%%%not-base64%%%" )).toBeNull();
    expect(decodeBase64Strict(Buffer.from("ok").toString("base64"))?.toString()).toBe("ok");
  });
  it("rejects extension spoofing", () => {
    expect(validateUploadContent("png", Buffer.from("not an image"))).toEqual({ ok: false, error: "invalid PNG signature" });
    expect(validateUploadContent("pdf", Buffer.from("plain text"))).toEqual({ ok: false, error: "invalid PDF signature" });
  });

  it("accepts matching signatures", () => {
    expect(validateUploadContent("png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]))).toEqual({ ok: true });
    expect(validateUploadContent("pdf", Buffer.from("%PDF-1.7\n"))).toEqual({ ok: true });
  });

  it("rejects active HTML and SVG content", () => {
    expect(validateUploadContent("html", Buffer.from("<script>alert(1)</script>"))).toEqual({ ok: false, error: "active scriptable markup is not allowed" });
    expect(validateUploadContent("svg", Buffer.from("<svg><image href=\"https://evil.example/x\"/></svg>"))).toEqual({ ok: false, error: "SVG external content is not allowed" });
  });
});
