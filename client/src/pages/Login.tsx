/**
 * 登录页面
 * 支持邮箱密码登录和注册
 */

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Loader2, LogIn, UserPlus, AlertCircle } from "lucide-react";
import { motion } from "framer-motion";

// 登录表单验证
const loginSchema = z.object({
  email: z.string().email("请输入有效的邮箱地址"),
  password: z.string().min(1, "请输入密码"),
});

// 注册表单验证
const registerSchema = z.object({
  name: z.string().min(1, "姓名不能为空"),
  company: z.string().min(1, "公司名不能为空"),
  partnerType: z.enum(["financial_institution", "isv_partner"]).optional(),
  email: z.string().email("请输入有效的邮箱地址"),
  password: z.string().min(6, "密码至少需要6个字符"),
  confirmPassword: z.string().min(6, "请确认密码"),
}).refine((data) => data.password === data.confirmPassword, {
  message: "两次输入的密码不一致",
  path: ["confirmPassword"],
});

type LoginFormData = z.infer<typeof loginSchema>;
type RegisterFormData = z.infer<typeof registerSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<"login" | "register">("login");
  const [error, setError] = useState<string | null>(null);
  const { refresh } = useAuth();

  useEffect(() => {
    const previous = document.body.getAttribute("data-auth-light");
    document.body.setAttribute("data-auth-light", "true");
    return () => {
      if (previous === null) {
        document.body.removeAttribute("data-auth-light");
      } else {
        document.body.setAttribute("data-auth-light", previous);
      }
    };
  }, []);

  const loginMutation = trpc.auth.login.useMutation({
    retry: false, // 登录失败不重试
    onSuccess: async () => {
      // 刷新用户状态并等待完成
      await refresh();
      // 等待一下确保状态已更新
      await new Promise(resolve => setTimeout(resolve, 100));
      // 检查是否是重定向到管理员页面
      const params = new URLSearchParams(window.location.search);
      const redirect = params.get("redirect");
      // 如果有指定重定向，使用指定的；否则跳转到体验页面
      setLocation(redirect || "/scenarios");
    },
    onError: (error) => {
      setError(error.message || "登录失败，请检查邮箱和密码");
    },
  });

  const registerMutation = trpc.auth.register.useMutation({
    retry: false, // 注册失败不重试
    onSuccess: async () => {
      await refresh();
      // 注册成功后已自动登录，跳转到首页
      setError(null);
      setLocation("/");
    },
    onError: (error) => {
      setError(error.message || "注册失败，请重试");
    },
  });

  const loginForm = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  });

  const registerForm = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
  });

  const onLoginSubmit = (data: LoginFormData) => {
    setError(null);
    loginMutation.mutate(data);
  };

  const onRegisterSubmit = (data: RegisterFormData) => {
    setError(null);
    registerMutation.mutate({
      name: data.name,
      company: data.company,
      partnerType: data.partnerType, verificationCode: "",
      email: data.email,
      password: data.password,
    });
  };

  return (
    <div className="login-shell min-h-screen bg-gradient-to-br from-gray-50 via-white to-gray-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <Card className="border-border/50 shadow-lg">
          <CardHeader className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold">登录岗位智能体</CardTitle>
            <CardDescription>
              请输入您的账号信息
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Tabs value={activeTab} onValueChange={(v) => {
              setActiveTab(v as "login" | "register");
              setError(null);
              loginForm.reset();
              registerForm.reset();
            }}>
              <TabsList className="grid w-full grid-cols-2 mb-6">
                <TabsTrigger value="login" className="gap-2">
                  <LogIn className="w-4 h-4" />
                  登录
                </TabsTrigger>
                <TabsTrigger value="register" className="gap-2">
                  <UserPlus className="w-4 h-4" />
                  注册
                </TabsTrigger>
              </TabsList>

              {/* 登录表单 */}
              <TabsContent value="login">
                <form onSubmit={loginForm.handleSubmit(onLoginSubmit)} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="login-email">邮箱</Label>
                    <Input
                      id="login-email"
                      type="email"
                      placeholder="your@email.com"
                      {...loginForm.register("email")}
                      disabled={loginMutation.isPending}
                    />
                    {loginForm.formState.errors.email && (
                      <p className="text-sm text-destructive">
                        {loginForm.formState.errors.email.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="login-password">密码</Label>
                    <Input
                      id="login-password"
                      type="password"
                      placeholder="请输入密码"
                      {...loginForm.register("password")}
                      disabled={loginMutation.isPending}
                    />
                    {loginForm.formState.errors.password && (
                      <p className="text-sm text-destructive">
                        {loginForm.formState.errors.password.message}
                      </p>
                    )}
                  </div>

                  <Button
                    type="submit"
                    className="w-full"
                    disabled={loginMutation.isPending}
                  >
                    {loginMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        登录中...
                      </>
                    ) : (
                      <>
                        <LogIn className="mr-2 h-4 w-4" />
                        登录
                      </>
                    )}
                  </Button>
                </form>
              </TabsContent>

              {/* 注册表单 */}
              <TabsContent value="register">
                <form onSubmit={registerForm.handleSubmit(onRegisterSubmit)} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="register-name">姓名</Label>
                      <Input
                        id="register-name"
                        type="text"
                        placeholder="请输入您的姓名"
                        {...registerForm.register("name")}
                        disabled={registerMutation.isPending}
                      />
                      {registerForm.formState.errors.name && (
                        <p className="text-sm text-destructive">
                          {registerForm.formState.errors.name.message}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="register-company">公司名</Label>
                      <Input
                        id="register-company"
                        type="text"
                        placeholder="请输入公司名称"
                        {...registerForm.register("company")}
                        disabled={registerMutation.isPending}
                      />
                      {registerForm.formState.errors.company && (
                        <p className="text-sm text-destructive">
                          {registerForm.formState.errors.company.message}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-partnerType">合作伙伴类型</Label>
                    <Select
                      value={registerForm.watch("partnerType") || ""}
                      onValueChange={(v) => registerForm.setValue("partnerType", v as "financial_institution" | "isv_partner")}
                      disabled={registerMutation.isPending}
                    >
                      <SelectTrigger id="register-partnerType">
                        <SelectValue placeholder="请选择合作伙伴类型（选填）" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="financial_institution">金融机构</SelectItem>
                        <SelectItem value="isv_partner">ISV 伙伴</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-email">邮箱</Label>
                    <Input
                      id="register-email"
                      type="email"
                      placeholder="your@email.com"
                      {...registerForm.register("email")}
                      disabled={registerMutation.isPending}
                    />
                    {registerForm.formState.errors.email && (
                      <p className="text-sm text-destructive">
                        {registerForm.formState.errors.email.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-password">密码</Label>
                    <Input
                      id="register-password"
                      type="password"
                      placeholder="至少6个字符"
                      {...registerForm.register("password")}
                      disabled={registerMutation.isPending}
                    />
                    {registerForm.formState.errors.password && (
                      <p className="text-sm text-destructive">
                        {registerForm.formState.errors.password.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-confirm-password">确认密码</Label>
                    <Input
                      id="register-confirm-password"
                      type="password"
                      placeholder="请再次输入密码"
                      {...registerForm.register("confirmPassword")}
                      disabled={registerMutation.isPending}
                    />
                    {registerForm.formState.errors.confirmPassword && (
                      <p className="text-sm text-destructive">
                        {registerForm.formState.errors.confirmPassword.message}
                      </p>
                    )}
                  </div>

                  <Button
                    type="submit"
                    className="w-full"
                    disabled={registerMutation.isPending}
                  >
                    {registerMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        注册中...
                      </>
                    ) : (
                      <>
                        <UserPlus className="mr-2 h-4 w-4" />
                        注册
                      </>
                    )}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>

            <div className="mt-6 text-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocation("/")}
                className="text-muted-foreground"
              >
                返回首页
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
