import type { ChannelId } from "@shared/types/cron";
import { getFeishuStatus } from "../claw-feishu";
import { getWeixinStatus } from "../claw-weixin";

export type BoundChannel = {
  channelId: ChannelId;
  label: string;
  targetLabel?: string;
};

export async function getBoundChannelsForAdopt(adoptId: string): Promise<BoundChannel[]> {
  const channels: BoundChannel[] = [];
  const isJiuwenAgent = adoptId.startsWith("lgj-");

  const wechat = isJiuwenAgent ? null : getWeixinStatus(adoptId);
  if (wechat?.bound && !wechat.needsReactivation) {
    channels.push({
      channelId: "wechat",
      label: "微信",
      targetLabel: wechat.targetLabel || "微信",
    });
  }

  const feishu = await getFeishuStatus(adoptId);
  if (feishu.deliveryReady) {
    channels.push({
      channelId: "feishu",
      label: "飞书",
      targetLabel: "已绑定",
    });
  }

  // DingTalk is supported by JiuwenSwarm, but EA binding is not wired yet.
  // WeCom is still a placeholder provider.
  return channels;
}

export async function getUserBoundChannels(_userId: number, adoptId?: string): Promise<ChannelId[]> {
  if (!adoptId) return [];
  const channels = await getBoundChannelsForAdopt(adoptId);
  return channels.map((channel) => channel.channelId);
}
