import { afterEach, describe, expect, it } from "vitest";
import { parseWebhookUrl, selectWebhookAddress } from "./safe-webhook";

afterEach(() => {
  delete process.env.NOTIFY_WEBHOOK_PRIVATE_HOST_ALLOWLIST;
});

describe("Webhook target policy", () => {
  it("requires HTTPS and blocks private IP literals", () => {
    expect(() => parseWebhookUrl("http://example.com/hook", "generic")).toThrow(/HTTPS/);
    expect(() => parseWebhookUrl("https://127.0.0.1/hook", "generic")).toThrow(/Private/);
    expect(() => parseWebhookUrl("https://[::ffff:7f00:1]/hook", "generic")).toThrow(/Private/);
    expect(parseWebhookUrl("https://hooks.example.com/notify", "generic").hostname).toBe("hooks.example.com");
  });

  it("restricts Feishu Webhooks to official robot endpoints", () => {
    expect(() => parseWebhookUrl("https://example.com/open-apis/bot/v2/hook/x", "feishu")).toThrow(/official/);
    expect(() => parseWebhookUrl("https://open.feishu.cn/other/x", "feishu")).toThrow(/path/);
    expect(parseWebhookUrl("https://open.feishu.cn/open-apis/bot/v2/hook/x", "feishu").hostname).toBe("open.feishu.cn");
    expect(parseWebhookUrl("https://open.larksuite.com/open-apis/bot/v2/hook/x", "feishu").hostname).toBe("open.larksuite.com");
  });

  it("rejects DNS answers containing private addresses unless explicitly allowlisted", () => {
    const mixed = [
      { address: "93.184.216.34", family: 4 as const },
      { address: "10.0.0.8", family: 4 as const },
    ];
    expect(() => selectWebhookAddress("hooks.example.com", mixed, new Set())).toThrow(/private/);
    expect(selectWebhookAddress("hooks.example.com", mixed, new Set(["hooks.example.com"]))).toEqual(mixed[0]);
  });
});
