import type { ChannelId, CronProviderCapabilities } from "@shared/types/cron";
import {
  getBoundChannelsForAdopt,
  type BoundChannel,
} from "./channel-binding-query";

export type AvailableDeliveryChannel = {
  channelId: ChannelId;
  label: string;
  targetLabel?: string;
};

export type CronCapabilitiesWithAvailability = CronProviderCapabilities & {
  availableDeliveryChannels: AvailableDeliveryChannel[];
};

type BoundChannelResolver = (adoptId: string) => Promise<BoundChannel[]>;

export async function resolveCronCapabilities(
  adoptId: string,
  capabilities: CronProviderCapabilities,
  resolveBoundChannels: BoundChannelResolver = getBoundChannelsForAdopt,
): Promise<CronCapabilitiesWithAvailability> {
  const supported = new Set(capabilities.supportedChannels);
  const available: AvailableDeliveryChannel[] = [];

  if (supported.has("web")) {
    available.push({ channelId: "web", label: "定时任务记录" });
  }

  const boundChannels = await resolveBoundChannels(adoptId);
  for (const channel of boundChannels) {
    if (!supported.has(channel.channelId)) continue;
    if (available.some((item) => item.channelId === channel.channelId)) continue;
    available.push({
      channelId: channel.channelId,
      label: channel.label,
      targetLabel: channel.targetLabel,
    });
  }

  return {
    ...capabilities,
    availableDeliveryChannels: available,
  };
}

export function unavailableDeliveryChannelError(
  channelId: ChannelId,
  capabilities: CronCapabilitiesWithAvailability,
): string | null {
  if (!capabilities.supportedChannels.includes(channelId)) {
    return `当前智能体运行时不支持${channelId}投递`;
  }
  if (!capabilities.availableDeliveryChannels.some((item) => item.channelId === channelId)) {
    const labels: Partial<Record<ChannelId, string>> = {
      web: "定时任务记录",
      wechat: "微信",
      feishu: "飞书",
      dingtalk: "钉钉",
      wecom: "企业微信",
    };
    return `${labels[channelId] || channelId}尚未绑定或暂不可用`;
  }
  return null;
}
