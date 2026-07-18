import { useState } from "react";
import { Check, Copy, KeyRound, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SetupData = { secret: string; qrCodeDataUrl: string };

export function AdminMfaCard() {
  const [dialog, setDialog] = useState<"setup" | "refresh" | "disable" | null>(null);
  const [setup, setSetup] = useState<SetupData | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const status = trpc.auth.adminMfaStatus.useQuery(undefined, { retry: false });

  const resetDialog = () => {
    setDialog(null);
    setSetup(null);
    setCode("");
    setPassword("");
    setRecoveryCodes([]);
    setCopied(false);
  };

  const begin = trpc.auth.beginAdminMfaSetup.useMutation({
    onSuccess: (data) => {
      setSetup(data);
      setDialog("setup");
    },
    onError: (error) => toast.error(error.message),
  });
  const confirm = trpc.auth.confirmAdminMfaSetup.useMutation({
    onSuccess: async (data) => {
      setRecoveryCodes(data.recoveryCodes);
      await status.refetch();
      toast.success("管理员二次验证已启用");
    },
    onError: (error) => toast.error(error.message),
  });
  const refresh = trpc.auth.refreshAdminMfa.useMutation({
    onSuccess: async () => {
      await status.refetch();
      toast.success("管理员身份验证已刷新");
      resetDialog();
    },
    onError: (error) => toast.error(error.message),
  });
  const disable = trpc.auth.disableAdminMfa.useMutation({
    onSuccess: async () => {
      await status.refetch();
      toast.success("管理员二次验证已关闭");
      resetDialog();
    },
    onError: (error) => toast.error(error.message),
  });

  const pending = begin.isPending || confirm.isPending || refresh.isPending || disable.isPending;
  const enabled = Boolean(status.data?.enabled);
  const fresh = Boolean(status.data?.sessionFresh);

  return (
    <>
      <Card className="admin-panel-card p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${enabled ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
              {enabled ? <ShieldCheck className="h-5 w-5" /> : <ShieldOff className="h-5 w-5" />}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-gray-900">管理员二次验证</h2>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${enabled ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"}`}>
                  {enabled ? "已启用" : "未启用"}
                </span>
                {enabled && !fresh && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">需要重新验证</span>}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                管理员登录和敏感写操作使用 TOTP 验证；恢复码仅在启用时展示一次。
              </p>
              {enabled && <p className="mt-1 text-[11px] text-gray-400">剩余恢复码 {status.data?.recoveryCodesRemaining ?? 0} 个</p>}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {enabled && !fresh && <Button size="sm" onClick={() => setDialog("refresh")}><KeyRound className="mr-1.5 h-3.5 w-3.5" />重新验证</Button>}
            {enabled ? (
              <Button size="sm" variant="outline" className="admin-secondary-action" onClick={() => setDialog("disable")}>关闭</Button>
            ) : (
              <Button size="sm" onClick={() => begin.mutate()} disabled={begin.isPending}>
                {begin.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />}
                启用
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Dialog open={dialog === "setup"} onOpenChange={(open) => { if (!open && recoveryCodes.length === 0) resetDialog(); }}>
        <DialogContent className="sm:max-w-md" showCloseButton={recoveryCodes.length === 0}>
          <DialogHeader>
            <DialogTitle>{recoveryCodes.length > 0 ? "保存恢复码" : "绑定身份验证器"}</DialogTitle>
            <DialogDescription>
              {recoveryCodes.length > 0 ? "每个恢复码只能使用一次，关闭后不会再次显示。" : "使用身份验证器扫描二维码，然后输入 6 位验证码完成启用。"}
            </DialogDescription>
          </DialogHeader>
          {recoveryCodes.length > 0 ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 rounded-lg border bg-gray-50 p-3 font-mono text-sm">
                {recoveryCodes.map((item) => <span key={item}>{item}</span>)}
              </div>
              <Button type="button" variant="outline" className="w-full" onClick={async () => {
                await navigator.clipboard.writeText(recoveryCodes.join("\n"));
                setCopied(true);
              }}>
                {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                {copied ? "已复制" : "复制恢复码"}
              </Button>
            </div>
          ) : setup ? (
            <div className="space-y-4">
              <img src={setup.qrCodeDataUrl} alt="管理员二次验证二维码" className="mx-auto h-48 w-48 rounded-lg border bg-white p-2" />
              <div className="rounded-lg bg-gray-50 px-3 py-2 text-center font-mono text-xs text-gray-700 break-all">{setup.secret}</div>
              <div className="space-y-2">
                <Label htmlFor="mfa-current-password">当前密码</Label>
                <Input id="mfa-current-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mfa-setup-code">6 位验证码</Label>
                <Input id="mfa-setup-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} className="text-center font-mono tracking-[0.2em]" placeholder="000000" />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            {recoveryCodes.length > 0 ? (
              <Button type="button" onClick={resetDialog}>我已妥善保存</Button>
            ) : (
              <Button type="button" onClick={() => confirm.mutate({ code, currentPassword: password || undefined })} disabled={code.trim().length < 6 || pending}>
                {confirm.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                验证并启用
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "refresh" || dialog === "disable"} onOpenChange={(open) => { if (!open) resetDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog === "disable" ? "关闭管理员二次验证" : "重新验证管理员身份"}</DialogTitle>
            <DialogDescription>{dialog === "disable" ? "关闭后管理员登录不再要求动态验证码。" : "验证成功后，敏感写操作将在当前会话中恢复。"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {dialog === "disable" && <div className="space-y-2"><Label htmlFor="mfa-disable-password">当前密码</Label><Input id="mfa-disable-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div>}
            <div className="space-y-2"><Label htmlFor="mfa-action-code">验证码或恢复码</Label><Input id="mfa-action-code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" className="text-center font-mono tracking-[0.2em]" /></div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={resetDialog}>取消</Button>
            <Button type="button" variant={dialog === "disable" ? "destructive" : "default"} disabled={code.trim().length < 6 || pending} onClick={() => {
              if (dialog === "disable") disable.mutate({ code, currentPassword: password || undefined });
              else refresh.mutate({ code });
            }}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {dialog === "disable" ? "确认关闭" : "验证"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
