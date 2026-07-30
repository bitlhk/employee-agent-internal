import type { ChannelId, ChannelProvider } from "@shared/types/cron";
import { DingtalkChannelProvider, FeishuChannelProvider, WecomChannelProvider } from "./channel-providers";

const providers = new Map<ChannelId, ChannelProvider>([
  ["feishu", new FeishuChannelProvider()],
  ["dingtalk", new DingtalkChannelProvider()],
  ["wecom", new WecomChannelProvider()],
]);

const CHANNEL_ALIASES: Record<string, ChannelId> = {
  web: "web",
  conversation: "web",
  weixin: "wechat",
  wechat: "wechat",
  feishu: "feishu",
  dingding: "dingtalk",
  dingtalk: "dingtalk",
  ding: "dingtalk",
  wecom: "wecom",
};

export function normalizeChannelId(channel: string): ChannelId | undefined {
  return CHANNEL_ALIASES[String(channel || "").trim().toLowerCase()];
}

export function getChannelProvider(channel: string): ChannelProvider | undefined {
  const channelId = normalizeChannelId(channel);
  return channelId ? providers.get(channelId) : undefined;
}

export function listChannelProviders(): ChannelProvider[] {
  return Array.from(providers.values());
}
