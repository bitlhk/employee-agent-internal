import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { BellRing, Building2, CheckCircle2, MessageCircle, MessagesSquare, Send, ShieldOff, Unlink } from "lucide-react";
import { PageContainer } from "@/components/console/PageContainer";

type ChannelKey = "feishu" | "dingtalk" | "wechat" | "wecom";

type ChannelCapability = {
  key: ChannelKey;
  label: string;
  configured: boolean;
  bound: boolean;
  routeReady: boolean;
  bindMode: string;
  routeMode: string;
  targetLabel?: string;
  boundAt?: string;
  reason?: string | null;
  capabilities: {
    inbound: boolean;
    outbound: boolean;
    dm: boolean;
    group: boolean;
    scheduleDelivery: boolean;
    coopNotify: boolean;
    files: boolean;
  };
};

type ChannelCapabilitiesResp = {
  adoptId: string;
  userId: number | null;
  routeModel: string;
  channels: Partial<Record<ChannelKey, ChannelCapability>>;
};

const CHANNELS: Array<{
  key: ChannelKey;
  label: string;
  desc: string;
  Icon: typeof MessageCircle;
  status: "ready" | "jiuwen-ready" | "unsupported";
}> = [
  { key: "feishu", label: "飞书", desc: "通过岗位智能体应用绑定当前岗位智能体", Icon: Send, status: "ready" },
  { key: "dingtalk", label: "钉钉", desc: "JiuwenSwarm 支持，EA 绑定接入中", Icon: BellRing, status: "jiuwen-ready" },
  { key: "wechat", label: "微信", desc: "等待 JiuwenSwarm 频道支持后适配", Icon: MessagesSquare, status: "unsupported" },
  { key: "wecom", label: "企业微信", desc: "等待 JiuwenSwarm 频道支持后适配", Icon: Building2, status: "unsupported" },
];

function channelStatusLabel(channel: (typeof CHANNELS)[number], cap?: ChannelCapability): string {
  if (!cap) {
    if (channel.status === "unsupported") return "适配中";
    return "未绑定";
  }
  if (cap.routeReady) return "已绑定";
  if (cap.bound && !cap.routeReady) return "路由待就绪";
  if (cap.reason === "not_bound") return "未绑定";
  if (cap.reason === "not_configured") return "未配置";
  if (cap.reason === "ea_adapter_pending") return "接入中";
  if (cap.reason === "waiting_jiuwenswarm_support") return "适配中";
  if (cap.configured) return "未绑定";
  return "未配置";
}

function channelPillClass(label: string): string {
  if (label === "已绑定") return "channel-pill channel-pill--ok";
  if (label === "未绑定" || label === "路由待就绪" || label === "未配置") return "channel-pill channel-pill--info";
  return "channel-pill";
}

export function ChannelsPage({ adoptId }: { adoptId?: string }) {
  const [active, setActive] = useState<ChannelKey>("feishu");
  const [channelCaps, setChannelCaps] = useState<ChannelCapabilitiesResp | null>(null);

  const refreshChannelCapabilities = async () => {
    if (!adoptId) {
      setChannelCaps(null);
      return;
    }
    try {
      const r = await fetch(`/api/claw/channels/capabilities?adoptId=${encodeURIComponent(adoptId)}`, { credentials: "include" });
      const d = await r.json().catch(() => ({}));
      setChannelCaps(r.ok ? d : null);
    } catch {
      setChannelCaps(null);
    }
  };

  useEffect(() => {
    void refreshChannelCapabilities();
  }, [adoptId]);

  return (
    <PageContainer title="频道" desc="管理岗位智能体与你的触达方式。日常对话、协作提醒和定时任务都可以复用这些频道。">
      <div className="channel-layout">
        <aside className="settings-card channel-list" aria-label="频道列表">
          {CHANNELS.map((channel) => {
            const ChannelIcon = channel.Icon;
            const activeChannel = active === channel.key;
            const cap = channelCaps?.channels?.[channel.key];
            const statusLabel = channelStatusLabel(channel, cap);
            return (
              <button
                key={channel.key}
                className="channel-list__item"
                data-active={activeChannel}
                aria-current={activeChannel ? "true" : undefined}
                type="button"
                onClick={() => setActive(channel.key)}
              >
                <span className="channel-brand" aria-hidden="true">
                  <ChannelIcon size={17} />
                </span>
                <span className="channel-list__copy">
                  <span className="channel-list__title">
                    {channel.label}
                    <span className={channelPillClass(statusLabel)}>{statusLabel}</span>
                  </span>
                  <span className="channel-list__desc">{cap ? channelDesc(channel, cap) : channel.desc}</span>
                </span>
              </button>
            );
          })}
        </aside>

        <section className="settings-card channel-detail">
          {active === "feishu" ? (
            <FeishuBridgePanel
              adoptId={adoptId}
              capability={channelCaps?.channels?.feishu}
              onChanged={() => void refreshChannelCapabilities()}
            />
          ) : active === "dingtalk" ? (
            <ComingSoonDetail
              icon={<MessageCircle size={22} />}
              title="钉钉频道接入中"
              desc="JiuwenSwarm 原生支持钉钉频道，EA 侧还需要补齐绑定、测试发送和任务投递配置。"
              points={["JiuwenSwarm 支持钉钉", "EA 绑定页面尚未接入", "接入完成后可作为任务通知频道"]}
              buttonText="接入中"
            />
          ) : (
            <UnsupportedChannelDetail channelLabel={active === "wechat" ? "微信" : "企业微信"} />
          )}
        </section>
      </div>
    </PageContainer>
  );
}

function channelDesc(channel: (typeof CHANNELS)[number], cap: ChannelCapability): string {
  if (cap.routeReady) {
    if (channel.key === "feishu") return "已路由到当前岗位智能体，支持私聊对话和协作提醒";
    return "已绑定";
  }
  if (cap.reason === "not_configured") return "平台飞书应用未配置，配置后即可绑定到岗位智能体";
  if (cap.reason === "ea_adapter_pending") return "JiuwenSwarm 支持该频道，EA 绑定和投递能力接入中";
  if (cap.reason === "waiting_jiuwenswarm_support") return channel.desc;
  if (cap.reason === "not_bound") return "平台已配置，当前岗位智能体尚未绑定";
  return channel.desc;
}

function FeishuBridgePanel({
  adoptId,
  capability,
  onChanged,
}: {
  adoptId?: string;
  capability?: ChannelCapability;
  onChanged?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState("");
  const [instruction, setInstruction] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const bound = !!capability?.bound;
  const routeReady = !!capability?.routeReady;
  const targetLabel = String(capability?.targetLabel || "");

  useEffect(() => {
    if (!adoptId || !code || bound) return;
    const timer = setInterval(() => { onChanged?.(); }, 2500);
    return () => clearInterval(timer);
  }, [adoptId, code, bound, onChanged]);

  const begin = async () => {
    if (!adoptId) return;
    setLoading(true);
    try {
      const r = await fetch("/api/claw/feishu/bidirectional/begin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || "begin failed");
      setCode(String(d.code || ""));
      setInstruction(String(d.instruction || ""));
      setExpiresAt(String(d.expiresAt || ""));
      onChanged?.();
    } finally {
      setLoading(false);
    }
  };

  const unbind = async () => {
    if (!adoptId) return;
    setLoading(true);
    try {
      await fetch("/api/claw/feishu/bidirectional/unbind", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId }),
      });
      setCode("");
      setInstruction("");
      setExpiresAt("");
      onChanged?.();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="channel-detail__body">
      <div className={routeReady ? "channel-status-icon channel-status-icon--ok" : "channel-status-icon"}>
        <MessageCircle size={26} />
      </div>
      <h2 className="channel-detail__title">飞书绑定</h2>
      <p className="channel-detail__desc">
        将飞书账号绑定到当前岗位智能体后，可以在飞书里直接对话，后续也可复用到定时任务和协作提醒。
      </p>
      <div className="channel-bullets">
        <span><CheckCircle2 size={14} /> 联系管理员加入企业组织</span>
        <span><CheckCircle2 size={14} /> 在飞书中添加岗位智能体应用</span>
        <span><CheckCircle2 size={14} /> 点击按钮获取绑定码，并在智能体私聊中输入完成绑定</span>
      </div>
      {routeReady ? (
        <div className="channel-meta">
          <span>路由状态</span>
          <strong>{targetLabel ? `已路由 ${targetLabel} → 当前岗位智能体` : "已绑定飞书双向交互"}</strong>
        </div>
      ) : null}
      {code && !routeReady ? (
        <div className="channel-bind-code">
          <span>{code}</span>
          <p>{instruction || `请在飞书 Bot 私聊发送：绑定 ${code}`}</p>
          {expiresAt ? <small>有效期至 {new Date(expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small> : null}
        </div>
      ) : null}
      <div className="channel-actions">
        {bound ? (
          <button className="skills-btn" onClick={unbind} disabled={loading}>
            <Unlink size={14} /> 解绑双向
          </button>
        ) : (
          <button className="page-primary-action" onClick={begin} disabled={loading || !adoptId}>
            <MessageCircle size={14} /> {loading ? "生成中..." : "获取绑定码"}
          </button>
        )}
        {!bound && code ? (
          <button className="skills-btn" onClick={() => onChanged?.()} disabled={loading}>
            检查状态
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ComingSoonDetail({
  icon,
  title,
  desc,
  points,
  buttonText = "即将上线",
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  points: string[];
  buttonText?: string;
}) {
  return (
    <div className="channel-detail__body">
      <div className="channel-status-icon channel-status-icon--muted">{icon}</div>
      <h2 className="channel-detail__title">{title}</h2>
      <p className="channel-detail__desc">{desc}</p>
      <div className="channel-bullets">
        {points.map((point) => (
          <span key={point}><CheckCircle2 size={14} /> {point}</span>
        ))}
      </div>
      <button className="skills-btn" disabled>
        {buttonText}
      </button>
    </div>
  );
}

function UnsupportedChannelDetail({ channelLabel }: { channelLabel: string }) {
  return (
    <div className="channel-detail__body">
      <div className="channel-status-icon channel-status-icon--muted"><ShieldOff size={26} /></div>
      <h2 className="channel-detail__title">{channelLabel}适配中</h2>
      <p className="channel-detail__desc">
        当前 EA 按 JiuwenSwarm 频道能力接入。{channelLabel}会等 JiuwenSwarm 侧提供稳定频道能力后再适配，暂时不开放绑定入口。
      </p>
      <div className="channel-bullets">
        <span><ShieldOff size={14} /> 暂不展示绑定入口</span>
        <span><CheckCircle2 size={14} /> 暂不作为定时任务渠道</span>
        <span><MessageCircle size={14} /> 待 JiuwenSwarm 支持后接入</span>
      </div>
      <button className="skills-btn" disabled>
        适配中
      </button>
    </div>
  );
}
