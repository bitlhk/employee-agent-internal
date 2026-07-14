import { describe, expect, it } from "vitest";
import type { CronProviderCapabilities } from "@shared/types/cron";
import {
  resolveCronCapabilities,
  unavailableDeliveryChannelError,
} from "./channel-capabilities";

const BASE: CronProviderCapabilities = {
  scheduleKinds: ["once", "interval", "cron"],
  promptRequired: true,
  supportsTimezone: true,
  supportsWakeOffset: true,
  supportsPreview: true,
  supportsRunNow: true,
  supportedChannels: ["web", "feishu", "dingtalk"],
};

describe("resolveCronCapabilities", () => {
  it("keeps the task record and only exposes bound runtime-supported channels", async () => {
    const result = await resolveCronCapabilities("lgj-test", BASE, async () => [
      { channelId: "feishu", label: "飞书", targetLabel: "已绑定" },
      { channelId: "wechat", label: "微信" },
    ]);

    expect(result.availableDeliveryChannels).toEqual([
      { channelId: "web", label: "定时任务记录" },
      { channelId: "feishu", label: "飞书", targetLabel: "已绑定" },
    ]);
  });

  it("rejects supported but unbound external channels", async () => {
    const result = await resolveCronCapabilities("lgj-test", BASE, async () => []);

    expect(unavailableDeliveryChannelError("web", result)).toBeNull();
    expect(unavailableDeliveryChannelError("feishu", result)).toBe("飞书尚未绑定或暂不可用");
    expect(unavailableDeliveryChannelError("wechat", result)).toContain("运行时不支持");
  });
});
