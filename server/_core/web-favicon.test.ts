import { describe, expect, it } from "vitest";
import { detectFaviconContentType, resolveFaviconCandidates } from "./web-favicon";

describe("web favicon proxy", () => {
  it("prefers a declared icon and falls back to the source origin", () => {
    expect(resolveFaviconCandidates(
      "https://news.example.com/article/1",
      "https://cdn.example.com/icons/news.png",
    )).toEqual([
      "https://cdn.example.com/icons/news.png",
      "https://news.example.com/favicon.ico",
    ]);
  });

  it("rejects invalid source URLs and credential-bearing icon URLs", () => {
    expect(resolveFaviconCandidates("javascript:alert(1)")).toEqual([]);
    expect(resolveFaviconCandidates(
      "https://example.com/article",
      "https://user:secret@example.com/icon.png",
    )).toEqual(["https://example.com/favicon.ico"]);
  });

  it("accepts known raster favicon formats and rejects arbitrary bodies", () => {
    expect(detectFaviconContentType(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe("image/x-icon");
    expect(detectFaviconContentType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("image/png");
    expect(detectFaviconContentType(Buffer.from("<html>not an icon</html>"))).toBeNull();
  });
});
