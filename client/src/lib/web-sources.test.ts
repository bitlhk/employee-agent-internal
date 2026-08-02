import { describe, expect, it } from "vitest";
import { extractChatWebSources } from "./web-sources";

describe("extractChatWebSources", () => {
  it("extracts a fetched webpage with a real public URL", () => {
    const sources = extractChatWebSources([{
      name: "fetch_webpage",
      status: "done",
      result: "URL: https://example.com/research/one\nStatus: 200\nTitle: 一篇研究报告\nContent:\n正文",
    }]);

    expect(sources).toEqual([expect.objectContaining({
      title: "一篇研究报告",
      url: "https://example.com/research/one",
      domain: "example.com",
    })]);
  });

  it("extracts structured MCP sources and keeps missing Wind URLs transparent", () => {
    const result = `{\'result\': '{"data":{"items":[{"content":"正文","date":"2026-06-26","title":"股东大会实录","url":""},{"content":"正文","date":"2026-06-25","title":"官方公告","url":"https://example.com/notice"}]}}'}`;
    const sources = extractChatWebSources([{
      name: "mcp_wind_financial_docs_get_financial_news",
      status: "done",
      result,
    }]);

    expect(sources).toEqual([
      expect.objectContaining({ title: "官方公告", url: "https://example.com/notice" }),
      expect.objectContaining({ title: "股东大会实录", provider: "Wind金融终端", publishedAt: "2026-06-26" }),
    ]);
    expect(sources[1].url).toBeUndefined();
  });

  it("rejects unsafe links and ignores unrelated non-search tool output", () => {
    const sources = extractChatWebSources([
      {
        name: "fetch_webpage",
        status: "done",
        result: "URL: http://127.0.0.1:5180/admin\nStatus: 200\nTitle: 内部页面\nContent:\nsecret",
      },
      {
        name: "mcp_customer_lookup",
        status: "done",
        result: JSON.stringify({ title: "客户详情", url: "" }),
      },
    ]);

    expect(sources).toEqual([]);
  });

  it("deduplicates repeated URLs", () => {
    const sources = extractChatWebSources([
      { name: "web_search", status: "done", result: JSON.stringify({ title: "结果一", url: "https://example.com/a" }) },
      { name: "fetch_webpage", status: "done", result: "URL: https://example.com/a\nTitle: 结果一" },
    ]);

    expect(sources).toHaveLength(1);
  });

  it("preserves a public provider favicon for the same-origin proxy", () => {
    const sources = extractChatWebSources([{
      name: "web_search",
      status: "done",
      result: JSON.stringify({
        title: "结果一",
        url: "https://example.com/a",
        favicon: "https://cdn.example.com/favicon.png",
      }),
    }]);

    expect(sources[0].faviconUrl).toBe("https://cdn.example.com/favicon.png");
  });
});
