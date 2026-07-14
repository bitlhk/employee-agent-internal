import type {
  ChannelBindHandle,
  ChannelBindStart,
  ChannelBindStatus,
  ChannelPayload,
  ChannelSendContext,
  Result,
  ScanChannelProvider,
  SyncBindChannelProvider,
} from "@shared/types/cron";
import { dingtalkCredentialsSchema, feishuCredentialsSchema, wechatCredentialsSchema, wecomCredentialsSchema } from "@shared/types/cron";
import {
  pollFeishuBindStatus,
  sendFeishuDeliveryMessage,
  startFeishuBindFlow,
  unbindFeishu,
} from "../claw-feishu";
import { sendWeixinMessage } from "../claw-weixin";

function notImplemented<T>(provider: string): Result<T> {
  return {
    ok: false,
    error: {
      kind: "not_implemented",
      detail: `${provider} channel provider is a Sprint 0 stub`,
    },
  };
}

export class WechatChannelProvider implements ScanChannelProvider {
  readonly id = "wechat";
  readonly displayName = "微信";
  readonly bindMode = "scan";
  readonly credentialsSchema = wechatCredentialsSchema;

  async startBindFlow(_ctx: ChannelSendContext): Promise<Result<ChannelBindStart>> {
    return notImplemented("wechat");
  }

  async pollBindStatus(_ctx: ChannelSendContext, _pollToken: string): Promise<Result<ChannelBindStatus>> {
    return notImplemented("wechat");
  }

  async test(_ctx: ChannelSendContext): Promise<Result<{ message: string }>> {
    const result = await sendWeixinMessage(
      _ctx.adoptId || "",
      _ctx.targetId || "",
      "岗位智能体频道测试\n\n微信频道已连接，后续定时任务可投递到这里。",
    );
    if (!result.ok) {
      return {
        ok: false,
        error: {
          kind: isWechatReactivationError(result.error) ? "auth_failed" : "channel_unreachable",
          detail: result.error || "wechat test send failed",
        },
      };
    }
    return { ok: true, value: { message: "微信测试消息已发送" } };
  }

  async unbind(_ctx: ChannelSendContext): Promise<Result<void>> {
    return notImplemented("wechat");
  }

  async send(_ctx: ChannelSendContext, _payload: ChannelPayload): Promise<Result<{ deliveredAt: string }>> {
    const result = await sendWeixinMessage(_ctx.adoptId || "", _ctx.targetId || "", formatChannelPayload(_payload));
    if (!result.ok) {
      return {
        ok: false,
        error: {
          kind: isWechatReactivationError(result.error) ? "auth_failed" : "channel_unreachable",
          detail: result.error || "wechat send failed",
        },
      };
    }
    return { ok: true, value: { deliveredAt: new Date().toISOString() } };
  }
}

export class FeishuChannelProvider implements ScanChannelProvider {
  readonly id = "feishu";
  readonly displayName = "飞书";
  readonly bindMode = "scan";
  readonly credentialsSchema = feishuCredentialsSchema;

  async startBindFlow(_ctx: ChannelSendContext): Promise<Result<ChannelBindStart>> {
    return await startFeishuBindFlow();
  }

  async pollBindStatus(_ctx: ChannelSendContext, _pollToken: string): Promise<Result<ChannelBindStatus>> {
    if (!_ctx.adoptId) {
      return { ok: false, error: { kind: "payload_rejected", detail: "adoptId required for feishu binding" } };
    }
    return await pollFeishuBindStatus(_ctx.adoptId, _ctx.userId, _pollToken);
  }

  async test(_ctx: ChannelSendContext): Promise<Result<{ message: string }>> {
    if (!_ctx.adoptId) {
      return { ok: false, error: { kind: "payload_rejected", detail: "adoptId required for feishu test" } };
    }
    const result = await sendFeishuDeliveryMessage(_ctx.adoptId, "岗位智能体频道测试\n\n飞书频道已连接，后续定时任务可投递到这里。");
    if (!result.ok) {
      return { ok: false, error: { kind: "channel_unreachable", detail: result.error || "feishu test failed" } };
    }
    return { ok: true, value: { message: "飞书测试消息已发送" } };
  }

  async unbind(_ctx: ChannelSendContext): Promise<Result<void>> {
    if (!_ctx.adoptId) {
      return { ok: false, error: { kind: "payload_rejected", detail: "adoptId required for feishu unbind" } };
    }
    await unbindFeishu(_ctx.adoptId);
    return { ok: true, value: undefined };
  }

  async send(_ctx: ChannelSendContext, _payload: ChannelPayload): Promise<Result<{ deliveredAt: string }>> {
    if (!_ctx.adoptId) {
      return { ok: false, error: { kind: "payload_rejected", detail: "adoptId required for feishu send" } };
    }
    const result = await sendFeishuDeliveryMessage(_ctx.adoptId, formatChannelPayload(_payload));
    if (!result.ok) {
      return { ok: false, error: { kind: "channel_unreachable", detail: result.error || "feishu send failed" } };
    }
    return { ok: true, value: { deliveredAt: new Date().toISOString() } };
  }
}

export class DingtalkChannelProvider implements ScanChannelProvider {
  readonly id = "dingtalk";
  readonly displayName = "钉钉";
  readonly bindMode = "scan";
  readonly credentialsSchema = dingtalkCredentialsSchema;

  async startBindFlow(_ctx: ChannelSendContext): Promise<Result<ChannelBindStart>> {
    return notImplemented("dingtalk");
  }

  async pollBindStatus(_ctx: ChannelSendContext, _pollToken: string): Promise<Result<ChannelBindStatus>> {
    return notImplemented("dingtalk");
  }

  async test(_ctx: ChannelSendContext): Promise<Result<{ message: string }>> {
    return notImplemented("dingtalk");
  }

  async unbind(_ctx: ChannelSendContext): Promise<Result<void>> {
    return notImplemented("dingtalk");
  }

  async send(_ctx: ChannelSendContext, _payload: ChannelPayload): Promise<Result<{ deliveredAt: string }>> {
    return notImplemented("dingtalk");
  }
}

export class WecomChannelProvider implements SyncBindChannelProvider {
  readonly id = "wecom";
  readonly displayName = "企业微信";
  readonly bindMode = "admin_config";
  readonly credentialsSchema = wecomCredentialsSchema;

  async bind(_ctx: ChannelSendContext, _credentials: unknown): Promise<Result<ChannelBindHandle>> {
    return notImplemented("wecom");
  }

  async test(_ctx: ChannelSendContext): Promise<Result<{ message: string }>> {
    return notImplemented("wecom");
  }

  async unbind(_ctx: ChannelSendContext): Promise<Result<void>> {
    return notImplemented("wecom");
  }

  async send(_ctx: ChannelSendContext, _payload: ChannelPayload): Promise<Result<{ deliveredAt: string }>> {
    return notImplemented("wecom");
  }
}

function formatChannelPayload(payload: ChannelPayload): string {
  const title = payload.title?.trim();
  const text = payload.text.trim();
  return title ? `${title}\n\n${text}` : text;
}

function isWechatReactivationError(error?: string): boolean {
  const msg = String(error || "").toLowerCase();
  return (
    msg.includes("context_token") ||
    msg.includes("context_expired") ||
    msg.includes("send a message to bot first") ||
    msg.includes("session timeout") ||
    msg.includes("errcode=-14")
  );
}
