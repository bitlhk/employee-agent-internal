import { useState, useEffect, useRef } from "react";
import { MessageCircle, QrCode, Send, Unlink } from "lucide-react";
import { toast } from "sonner";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import QRCode from "qrcode";

export function WeixinPage({ adoptId }: { adoptId?: string }) {
  const [status, setStatus] = useState<"idle"|"loading"|"scanning"|"bound">("idle");
  const [qrcodeDataUrl, setQrcodeDataUrl] = useState("");
  const [qrcode, setQrcode] = useState("");
  const [userId, setUserId] = useState("");
  const [testing, setTesting] = useState(false);
  const pollRef = useRef<any>(null);
  const { confirm, dialog } = useConfirmDialog();

  useEffect(() => {
    if (!adoptId) return;
    fetch(`/api/claw/weixin/status?adoptId=${encodeURIComponent(adoptId)}`, { credentials: "include" })
      .then(r => r.json()).then(d => { if (d.bound) { setStatus("bound"); setUserId(d.userId || ""); } }).catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [adoptId]);

  const startBind = async () => {
    if (!adoptId) return;
    setStatus("loading");
    try {
      const r = await fetch("/api/claw/weixin/qrcode", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adoptId }) });
      const d = await r.json();
      if (!d.qrcodeUrl) { toast.error("获取二维码失败"); setStatus("idle"); return; }
      const dataUrl = await QRCode.toDataURL(d.qrcodeUrl, { width: 200, margin: 1 });
      setQrcodeDataUrl(dataUrl);
      setQrcode(d.qrcode);
      setStatus("scanning");
      let baseUrl = "";
      pollRef.current = setInterval(async () => {
        try {
          const sr = await fetch(`/api/claw/weixin/qrstatus?adoptId=${encodeURIComponent(adoptId)}&qrcode=${encodeURIComponent(d.qrcode)}${baseUrl ? "&baseUrl=" + encodeURIComponent(baseUrl) : ""}`, { credentials: "include" });
          const sd = await sr.json();
          if (sd.status === "confirmed") { clearInterval(pollRef.current); setStatus("bound"); setUserId(sd.userId || ""); toast.success("微信绑定成功！"); }
          else if (sd.status === "scaned_but_redirect" && sd.baseUrl) { baseUrl = sd.baseUrl; }
          else if (sd.status === "expired") { clearInterval(pollRef.current); toast.error("二维码已过期"); setStatus("idle"); }
        } catch {}
      }, 2000);
    } catch { toast.error("获取二维码失败"); setStatus("idle"); setQrcodeDataUrl(""); }
  };

  const unbind = async () => {
    if (!adoptId) return;
    const ok = await confirm({
      title: "解绑微信？",
      description: "解绑后将无法通过微信接收通知和对话。",
      confirmText: "解绑",
      variant: "danger",
    });
    if (!ok) return;
    await fetch("/api/claw/weixin/unbind", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adoptId }) });
    setStatus("idle"); setUserId(""); setQrcodeDataUrl(""); toast.success("已解绑");
  };

  const testSend = async () => {
    if (!adoptId) return;
    setTesting(true);
    try {
      const r = await fetch("/api/claw/weixin/test", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adoptId }) });
      const d = await r.json();
      if (d.ok) toast.success("测试消息已发送！"); else toast.error(d.error || "发送失败");
    } catch { toast.error("发送失败"); }
    finally { setTesting(false); }
  };

  return (
    <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {dialog}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 stealth-scrollbar">
        <div style={{ maxWidth: 480, margin: "0 auto" }}>

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
            <MessageCircle size={20} style={{ color: "var(--oc-accent)" }} />
            <div>
              <h1 className="text-lg" style={{ fontWeight: "var(--oc-weight-bold)", color: "var(--oc-text-primary)" }}>微信连接</h1>
              <p className="text-xs" style={{ color: "var(--oc-text-secondary)", marginTop: 2 }}>绑定个人微信，直接在微信里与你的虾对话。每只虾独立绑定，互不影响</p>
            </div>
          </div>

          {status === "bound" ? (
            <div className="settings-card" style={{ padding: 24, textAlign: "center" }}>
              <div style={{ width: 48, height: 48, borderRadius: "var(--oc-radius-lg)", background: "rgba(34,197,94,0.1)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                <MessageCircle size={24} style={{ color: "var(--oc-success)" }} />
              </div>
              <div className="text-sm" style={{ fontWeight: "var(--oc-weight-semibold)", color: "var(--oc-text-primary)", marginBottom: 4 }}>微信已连接</div>
              <div className="text-xs" style={{ color: "var(--oc-text-secondary)", marginBottom: 20 }}>
                你可以直接在微信里发消息给岗位智能体，也会收到定时任务等通知推送
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                <button className="btn-primary-soft" onClick={testSend} disabled={testing} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Send size={13} />{testing ? "发送中..." : "测试发送"}
                </button>
                <button className="skills-btn" onClick={unbind} style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--oc-danger)" }}>
                  <Unlink size={13} />解绑
                </button>
              </div>
            </div>
          ) : status === "scanning" ? (
            <div className="settings-card" style={{ padding: 24, textAlign: "center" }}>
              <div className="text-sm" style={{ color: "var(--oc-text-primary)", fontWeight: "var(--oc-weight-medium)", marginBottom: 12 }}>请用微信扫描二维码</div>
              {qrcodeDataUrl && <img src={qrcodeDataUrl} alt="WeChat QR" style={{ width: 200, height: 200, margin: "0 auto", borderRadius: "var(--oc-radius-md)", background: "#fff" }} />}
              <div className="text-xs" style={{ color: "var(--oc-text-secondary)", marginTop: 12 }}>扫码后请在微信中确认授权</div>
            </div>
          ) : (
            <div className="settings-card" style={{ padding: 24, textAlign: "center" }}>
              <div style={{ width: 48, height: 48, borderRadius: "var(--oc-radius-lg)", background: "var(--accent-subtle, rgba(255,92,92,0.08))", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                <QrCode size={24} style={{ color: "var(--oc-accent)" }} />
              </div>
              <div className="text-sm" style={{ fontWeight: "var(--oc-weight-semibold)", color: "var(--oc-text-primary)", marginBottom: 4 }}>连接你的微信</div>
              <div className="text-xs" style={{ color: "var(--oc-text-secondary)", marginBottom: 20, lineHeight: 1.6 }}>
                绑定后你可以：<br/>
                在微信里直接与岗位智能体对话<br/>
                接收定时任务完成通知<br/>
                接收协作请求提醒
              </div>
              <button className="btn-primary-soft" onClick={startBind} disabled={status === "loading"} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <QrCode size={13} />{status === "loading" ? "获取二维码..." : "扫码绑定微信"}
              </button>
            </div>
          )}

          <div className="settings-card" style={{ padding: 16, marginTop: 16 }}>
            <div className="text-xs" style={{ color: "var(--oc-text-secondary)", lineHeight: 1.6 }}>
              其他通知渠道（企业微信、飞书、自定义 Webhook）请访问<br/>
              <strong style={{ color: "var(--oc-text-primary)" }}>设置 → 通知</strong> 进行配置
            </div>
          </div>

        </div>
      </div>
    </main>
  );
}
