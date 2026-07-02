import express from "express";
import { isAuthorizedInternalRequest, requireClawOwner } from "./helpers";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";

const APP_ROOT = process.env.APP_ROOT || process.cwd();
const NOTIFY_CONFIG_PATH = `${APP_ROOT}/data/claw-notify-configs.json`;

function loadConfigs(): Record<string, any> {
  try {
    if (existsSync(NOTIFY_CONFIG_PATH)) return JSON.parse(readFileSync(NOTIFY_CONFIG_PATH, "utf-8"));
  } catch {}
  return {};
}
function saveConfigs(data: Record<string, any>) {
  try { mkdirSync(`${APP_ROOT}/data`, { recursive: true }); } catch {}
  writeFileSync(NOTIFY_CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// 企业微信发消息
async function sendWechatWork(config: any, text: string, title?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // 1. 获取 access_token
    const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(config.corpId)}&corpsecret=${encodeURIComponent(config.secret)}`;
    const tokenResp = await fetch(tokenUrl);
    const tokenData = await tokenResp.json() as any;
    if (tokenData.errcode !== 0) return { ok: false, error: `获取token失败: ${tokenData.errmsg}` };

    // 2. 发消息
    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tokenData.access_token}`;
    const body = {
      touser: config.userId || "@all",
      agentid: parseInt(config.agentId || "1000002"),
      msgtype: "markdown",
      markdown: { content: title ? `### ${title}\n${text}` : text },
    };
    const sendResp = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sendData = await sendResp.json() as any;
    if (sendData.errcode !== 0) return { ok: false, error: `发送失败: ${sendData.errmsg}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// 飞书 Webhook 发消息
async function sendFeishu(config: any, text: string, title?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const webhook = config.webhook;
    if (!webhook) return { ok: false, error: "缺少飞书 Webhook URL" };
    const body = {
      msg_type: "interactive",
      card: {
        header: { title: { tag: "plain_text", content: title || "员工智能体通知" } },
        elements: [{ tag: "markdown", content: text }],
      },
    };
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json() as any;
    if (data.code !== 0 && data.StatusCode !== 0) return { ok: false, error: `发送失败: ${JSON.stringify(data)}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// 通用 Webhook
async function sendWebhook(config: any, text: string, title?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = config.webhook;
    if (!url) return { ok: false, error: "缺少 Webhook URL" };
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title || "员工智能体通知", text, timestamp: Date.now() }),
    });
    return { ok: resp.ok };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// 统一发送入口
export async function sendNotification(adoptId: string, text: string, title?: string, channel?: string): Promise<{ ok: boolean; error?: string }> {
  const configs = loadConfigs();
  const cfg = configs[adoptId];
  if (!cfg || cfg.type === "none" || !cfg.type) return { ok: true };
  // channel 参数可覆盖 cfg.type（内部调用指定渠道时使用）
  const sendType = channel || cfg.type;
  // 统一别名：wecom → wechat_work
  const t = sendType === "wecom" ? "wechat_work" : sendType;
  if (t === "wechat_work") return sendWechatWork(cfg, text, title);
  if (t === "feishu") return sendFeishu(cfg, text, title);
  if (t === "webhook") return sendWebhook(cfg, text, title);
  return { ok: false, error: "unknown notify type: " + sendType };
}

export function registerNotifyRoutes(app: express.Express) {
  app.get("/api/claw/notify/config", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      let claw: any;
      if (isAuthorizedInternalRequest(req)) {
        const { getClawByAdoptId } = await import("../db");
        claw = await getClawByAdoptId(adoptId);
        if (!claw) return res.status(404).json({ error: "NOT_FOUND" });
      } else {
        claw = await requireClawOwner(req, res, adoptId);
        if (!claw) return;
      }
      const configs = loadConfigs();
      const cfg = configs[adoptId] || { type: "none" };
      // 不返回 secret 明文
      const safe = { ...cfg };
      if (safe.secret) safe.secret = "••••" + safe.secret.slice(-4);
      res.json({ config: safe });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 保存通知配置
  app.post("/api/claw/notify/config", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const configs = loadConfigs();
      configs[adoptId] = {
        type: String(req.body.type || "none"),
        // 企业微信
        corpId: String(req.body.corpId || "").trim(),
        agentId: String(req.body.agentId || "").trim(),
        secret: String(req.body.secret || "").trim() || configs[adoptId]?.secret || "",
        userId: String(req.body.userId || "@all").trim(),
        // 飞书 / 通用 Webhook
        webhook: String(req.body.webhook || "").trim(),
      };
      saveConfigs(configs);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 通知发送（支持测试 + 内部调用）
  app.post("/api/claw/notify/test", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });

      // 支持内部调用（X-Internal-Key）和用户调用（requireClawOwner）
      if (!isAuthorizedInternalRequest(req)) {
        const claw = await requireClawOwner(req, res, adoptId);
        if (!claw) return;
      }

      // 使用请求体中的 message，没有则用默认测试文案
      const message = String(req.body?.message || "").trim()
        || "\u{1F99E} \u8fd9\u662f\u4e00\u6761\u6d4b\u8bd5\u6d88\u606f\n\n\u5982\u679c\u4f60\u770b\u5230\u4e86\uff0c\u8bf4\u660e\u7075\u867e\u901a\u77e5\u914d\u7f6e\u6210\u529f\uff01";
      const title = String(req.body?.title || "\u7075\u867e\u901a\u77e5").trim();
      const channel = String(req.body?.channel || "").trim();

      const result = await sendNotification(adoptId, message, title, channel || undefined);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
