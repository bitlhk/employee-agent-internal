/**
 * 密码重置页面
 * 通过邮件中的重置链接访问
 */

import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, CheckCircle2, AlertCircle, ArrowLeft } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const [token, setToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    const previous = document.body.getAttribute("data-auth-light");
    document.body.setAttribute("data-auth-light", "true");

    // 从URL参数获取token
    const urlParams = new URLSearchParams(window.location.search);
    const tokenParam = urlParams.get("token");
    if (tokenParam) {
      setToken(tokenParam);
    }

    return () => {
      if (previous === null) {
        document.body.removeAttribute("data-auth-light");
      } else {
        document.body.setAttribute("data-auth-light", previous);
      }
    };
  }, []);

  const resetPasswordMutation = trpc.auth.resetPassword.useMutation({
    retry: false,
    onSuccess: () => {
      toast.success("密码重置成功！");
      setTimeout(() => {
        setLocation("/");
      }, 2000);
    },
    onError: (error) => {
      toast.error(error.message || "密码重置失败");
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!token) {
      toast.error("重置链接无效");
      return;
    }

    if (newPassword.length < 6) {
      toast.error("密码至少需要6个字符");
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("两次输入的密码不一致");
      return;
    }

    await resetPasswordMutation.mutateAsync({
      token,
      newPassword,
    });
  };

  if (!token) {
    return (
      <div className="login-shell min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 via-white to-gray-50 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-destructive" />
              重置链接无效
            </CardTitle>
            <CardDescription>
              请检查重置链接是否正确，或重新申请密码重置
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setLocation("/")}
            >
              <ArrowLeft className="mr-2 w-4 h-4" />
              返回首页
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (resetPasswordMutation.isSuccess) {
    return (
      <div className="login-shell min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 via-white to-gray-50 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              密码重置成功
            </CardTitle>
            <CardDescription>
              您的密码已成功重置，即将跳转到首页...
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full"
              onClick={() => setLocation("/")}
            >
              返回首页
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="login-shell min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 via-white to-gray-50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>重置密码</CardTitle>
          <CardDescription>
            请输入您的新密码
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-password">新密码</Label>
              <Input
                id="new-password"
                type="password"
                placeholder="至少6个字符"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={resetPasswordMutation.isPending}
                minLength={6}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">确认密码</Label>
              <Input
                id="confirm-password"
                type="password"
                placeholder="请再次输入密码"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={resetPasswordMutation.isPending}
                minLength={6}
              />
            </div>
            {newPassword && confirmPassword && newPassword !== confirmPassword && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>两次输入的密码不一致</AlertDescription>
              </Alert>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={resetPasswordMutation.isPending || !newPassword || !confirmPassword || newPassword !== confirmPassword}
            >
              {resetPasswordMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  重置中...
                </>
              ) : (
                "重置密码"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
