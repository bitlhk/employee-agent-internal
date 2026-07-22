import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ChannelId } from "@shared/types/cron";

export type ChannelBindingStatus = "idle" | "loading" | "scanning" | "bound" | "unsupported";

export type ChannelBindingState = {
  channelId: ChannelId;
  status: ChannelBindingStatus;
  qrCode?: string;
  verificationUri?: string;
  userCode?: string;
  pollIntervalMs?: number;
  targetLabel?: string;
  testing: boolean;
  startBind: () => Promise<void>;
  unbind: () => Promise<void>;
  test: () => Promise<void>;
};

type InitialStatus = {
  status: Exclude<ChannelBindingStatus, "loading" | "scanning">;
  targetLabel?: string;
};

type BindStart = {
  qrCode: string;
  pollToken: string;
  expiresAt?: string;
  verificationUri?: string;
  userCode?: string;
  pollIntervalMs?: number;
};

type BindPollResult =
  | { status: "pending"; pollToken?: string }
  | { status: "scanned"; pollToken?: string }
  | { status: "confirmed"; targetLabel?: string }
  | { status: "expired" };

type ChannelBindingAdapter = {
  idleStatus: ChannelBindingStatus;
  bindErrorMessage: string;
  fetchInitialStatus(adoptId: string): Promise<InitialStatus>;
  startBind(adoptId: string): Promise<BindStart>;
  pollBindStatus(adoptId: string, pollToken: string): Promise<BindPollResult>;
  unbind(adoptId: string): Promise<void>;
  test(adoptId: string): Promise<{ ok: boolean; error?: string }>;
};

type WechatStatusResponse = {
  bound?: boolean;
  userId?: string;
  targetLabel?: string;
  setupRequired?: boolean;
  setupHint?: string;
  error?: string;
};

type WechatQrResponse = {
  qrcode?: string;
  qrcodeUrl?: string;
  message?: string;
  error?: string;
};

type WechatQrStatusResponse = {
  status?: string;
  baseUrl?: string;
  userId?: string;
};

type FeishuStatusResponse = {
  bound?: boolean;
  targetLabel?: string;
  domain?: string;
};

type FeishuBindStartResponse = BindStart & {
  error?: string;
};

type FeishuPollResponse = BindPollResult & {
  error?: string;
};

const WECHAT_POLL_INTERVAL_MS = 2000;

function encodeWechatPollToken(qrcode: string, baseUrl = "") {
  return JSON.stringify({ qrcode, baseUrl });
}

function decodeWechatPollToken(token: string) {
  try {
    const parsed = JSON.parse(token) as { qrcode?: string; baseUrl?: string };
    return { qrcode: parsed.qrcode || "", baseUrl: parsed.baseUrl || "" };
  } catch {
    return { qrcode: token, baseUrl: "" };
  }
}

const wechatAdapter: ChannelBindingAdapter = {
  idleStatus: "idle",
  bindErrorMessage: "获取微信二维码失败",

  async fetchInitialStatus(adoptId) {
    const r = await fetch(`/api/claw/weixin/status?adoptId=${encodeURIComponent(adoptId)}`, { credentials: "include" });
    const d = (await r.json()) as WechatStatusResponse;
    if (d.bound) return { status: "bound", targetLabel: d.targetLabel || d.userId || "" };
    return { status: "idle", targetLabel: "" };
  },

  async startBind(adoptId) {
    const r = await fetch("/api/claw/weixin/qrcode", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId }),
    });
    const d = (await r.json()) as WechatQrResponse;
    if (!r.ok || d.error) throw new Error(d.message || d.error || "openclaw_weixin_qrcode_failed");
    if (!d.qrcode || !d.qrcodeUrl) throw new Error("missing_wechat_qrcode");
    return {
      qrCode: d.qrcodeUrl,
      pollToken: encodeWechatPollToken(d.qrcode),
      pollIntervalMs: WECHAT_POLL_INTERVAL_MS,
    };
  },

  async pollBindStatus(adoptId, pollToken) {
    const { qrcode, baseUrl } = decodeWechatPollToken(pollToken);
    const r = await fetch(
      `/api/claw/weixin/qrstatus?adoptId=${encodeURIComponent(adoptId)}&qrcode=${encodeURIComponent(qrcode)}${baseUrl ? "&baseUrl=" + encodeURIComponent(baseUrl) : ""}`,
      { credentials: "include" },
    );
    const d = (await r.json()) as WechatQrStatusResponse;
    if (d.status === "confirmed") {
      return { status: "confirmed", targetLabel: d.userId || "" };
    }
    if (d.status === "scaned_but_redirect" && d.baseUrl) {
      return { status: "scanned", pollToken: encodeWechatPollToken(qrcode, d.baseUrl) };
    }
    if (d.status === "expired") {
      return { status: "expired" };
    }
    return { status: "pending" };
  },

  async unbind(adoptId) {
    await fetch("/api/claw/weixin/unbind", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId }),
    });
  },

  async test(adoptId) {
    const r = await fetch("/api/claw/weixin/test", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId }),
    });
    const d = await r.json();
    return { ok: !!d.ok, error: d.error };
  },
};

const feishuAdapter: ChannelBindingAdapter = {
  idleStatus: "idle",
  bindErrorMessage: "获取飞书授权二维码失败",

  async fetchInitialStatus(adoptId) {
    const r = await fetch(`/api/claw/feishu/status?adoptId=${encodeURIComponent(adoptId)}`, { credentials: "include" });
    const d = (await r.json()) as FeishuStatusResponse;
    if (d.bound) return { status: "bound", targetLabel: d.targetLabel || d.domain || "已绑定" };
    return { status: "idle", targetLabel: "" };
  },

  async startBind(adoptId) {
    const r = await fetch("/api/claw/feishu/begin", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId }),
    });
    const d = (await r.json()) as FeishuBindStartResponse;
    if (!r.ok || !d.qrCode || !d.pollToken) throw new Error(d.error || "missing_feishu_qrcode");
    return {
      qrCode: d.qrCode,
      pollToken: d.pollToken,
      verificationUri: d.verificationUri,
      userCode: d.userCode,
      pollIntervalMs: d.pollIntervalMs,
      expiresAt: d.expiresAt,
    };
  },

  async pollBindStatus(adoptId, pollToken) {
    const r = await fetch("/api/claw/feishu/poll", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId, pollToken }),
    });
    const d = (await r.json()) as FeishuPollResponse;
    if (!r.ok || d.error) throw new Error(d.error || "feishu_poll_failed");
    return d;
  },

  async unbind(adoptId) {
    await fetch("/api/claw/feishu/unbind", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId }),
    });
  },

  async test(adoptId) {
    const r = await fetch("/api/claw/feishu/test", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId }),
    });
    const d = await r.json();
    return { ok: !!d.ok, error: d.error };
  },
};

const unsupportedAdapter: ChannelBindingAdapter = {
  idleStatus: "unsupported",
  bindErrorMessage: "该频道暂未上线",

  async fetchInitialStatus() {
    return { status: "unsupported" };
  },
  async startBind() {
    throw new Error("channel_unsupported");
  },
  async pollBindStatus() {
    return { status: "expired" };
  },
  async unbind() {},
  async test() {
    return { ok: false, error: "该频道暂未上线" };
  },
};

const CHANNEL_ADAPTERS: Record<Exclude<ChannelId, "web">, ChannelBindingAdapter> = {
  wechat: wechatAdapter,
  feishu: feishuAdapter,
  dingtalk: unsupportedAdapter,
  wecom: unsupportedAdapter,
};

export function useChannelBinding(channelId: ChannelId, adoptId?: string): ChannelBindingState {
  const adapter = useMemo(
    () => channelId === "web" ? unsupportedAdapter : CHANNEL_ADAPTERS[channelId],
    [channelId],
  );
  const [status, setStatus] = useState<ChannelBindingStatus>("idle");
  const [qrCode, setQrCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [userCode, setUserCode] = useState("");
  const [pollIntervalMs, setPollIntervalMs] = useState<number | undefined>();
  const [targetLabel, setTargetLabel] = useState("");
  const [testing, setTesting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTokenRef = useRef("");

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    pollTokenRef.current = "";
  };

  useEffect(() => {
    stopPolling();
    setQrCode("");
    setVerificationUri("");
    setUserCode("");
    setPollIntervalMs(undefined);

    if (!adoptId) {
      setStatus("idle");
      setTargetLabel("");
      return;
    }

    adapter
      .fetchInitialStatus(adoptId)
      .then((next) => {
        setStatus(next.status);
        setTargetLabel(next.targetLabel || "");
      })
      .catch(() => {
        setStatus("idle");
        setTargetLabel("");
      });

    return stopPolling;
  }, [adapter, adoptId]);

  const startBind = async () => {
    if (!adoptId) return;
    stopPolling();
    setStatus("loading");
    try {
      const started = await adapter.startBind(adoptId);
      setQrCode(started.qrCode);
      setVerificationUri(started.verificationUri || "");
      setUserCode(started.userCode || "");
      setPollIntervalMs(started.pollIntervalMs);
      pollTokenRef.current = started.pollToken;
      setStatus("scanning");

      const intervalMs = started.pollIntervalMs || WECHAT_POLL_INTERVAL_MS;
      pollRef.current = setInterval(async () => {
        try {
          const polled = await adapter.pollBindStatus(adoptId, pollTokenRef.current);
          if ("pollToken" in polled && polled.pollToken) pollTokenRef.current = polled.pollToken;
          if (polled.status === "confirmed") {
            stopPolling();
            setStatus("bound");
            setTargetLabel(polled.targetLabel || "");
            toast.success("频道绑定成功");
          } else if (polled.status === "expired") {
            stopPolling();
            toast.error("二维码已过期，请重新获取");
            setStatus("idle");
          }
        } catch {}
      }, intervalMs);
    } catch {
      toast.error(adapter.bindErrorMessage);
      setStatus(adapter.idleStatus);
    }
  };

  const unbind = async () => {
    if (!adoptId) return;
    stopPolling();
    await adapter.unbind(adoptId);
    setStatus(adapter.idleStatus);
    setTargetLabel("");
    setQrCode("");
    setVerificationUri("");
    setUserCode("");
    toast.success(channelId === "feishu" ? "已解绑飞书" : "已解绑频道");
  };

  const test = async () => {
    if (!adoptId) return;
    setTesting(true);
    try {
      const result = await adapter.test(adoptId);
      if (result.ok) toast.success("测试消息已发送");
      else toast.error(result.error || "发送失败");
    } catch {
      toast.error("发送失败");
    } finally {
      setTesting(false);
    }
  };

  return {
    channelId,
    status,
    qrCode,
    verificationUri,
    userCode,
    pollIntervalMs,
    targetLabel,
    testing,
    startBind,
    unbind,
    test,
  };
}
