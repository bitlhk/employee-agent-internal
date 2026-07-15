/**
 * ClawHome — 岗位智能体独立首页（路径模式）
 * 风格：白色主题，与平台首页一致
 * 功能：Hero + 功能介绍 + 创建/进入
 */

import { useMemo, useState, useEffect, useRef } from "react";
import { BrandIcon } from "@/components/BrandIcon";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  Loader2, LogIn, LogOut, Settings, ArrowRight,
  MessageCircle, Brain, Cpu, Zap, Shield, Network, Copy, Check,
} from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { useBrand } from "@/lib/useBrand";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

function getRuntimeCardMeta(adoptId: unknown) {
  const id = String(adoptId || "");
  if (id.startsWith("lgj-")) {
    return {
      name: "JiuwenSwarm",
      icon: "/images/workforce-agent.svg",
      badgeClass: "bg-emerald-100 text-emerald-700",
      buttonClass: "bg-emerald-600 hover:bg-emerald-700",
    };
  }
  if (id.startsWith("lgh-")) {
    return {
      name: "历史实例",
      icon: "/images/workforce-agent.svg",
      badgeClass: "bg-slate-100 text-slate-600",
      buttonClass: "bg-slate-300",
    };
  }
  return {
    name: "存量实例",
    icon: "/images/workforce-agent.svg",
    badgeClass: "bg-amber-100 text-amber-700",
    buttonClass: "bg-slate-300",
  };
}

function isArchivedRuntimeAdoption(adoption: any) {
  const adoptId = String(adoption?.adoptId || "");
  return adoptId.startsWith("lgc-") || adoptId.startsWith("lgh-") || adoption?.actualRuntime === "legacy_archived";
}

// ── 岗位智能体 SVG Logo 动画组件 ──
function AnimatedLogo({ size = 120 }: { size?: number }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      xmlns="http://www.w3.org/2000/svg"
      initial={reduceMotion ? false : "hidden"}
      animate="visible"
    >
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff5a5f" />
          <stop offset="100%" stopColor="#e11d48" />
        </linearGradient>
      </defs>
      {/* 背景方块 */}
      <motion.rect
        x="8" y="8" width="112" height="112" rx="24" fill="#fff5f5"
        variants={{ hidden: { opacity: 0, scale: 0.5 }, visible: { opacity: 1, scale: 1, transition: { duration: 0.4 } } }}
      />
      {/* 身体弧线 */}
      <motion.path
        d="M34 78c0-16 12-28 30-28s30 12 30 28"
        fill="none" stroke="url(#logo-g)" strokeWidth="10" strokeLinecap="round"
        variants={{ hidden: { pathLength: 0 }, visible: { pathLength: 1, transition: { duration: 0.8, delay: 0.3 } } }}
      />
      {/* 左眼 */}
      <motion.circle
        cx="50" cy="52" r="6" fill="#111827"
        variants={{ hidden: { opacity: 0, scale: 0 }, visible: { opacity: 1, scale: 1, transition: { duration: 0.3, delay: 0.8 } } }}
      />
      {/* 右眼 */}
      <motion.circle
        cx="78" cy="52" r="6" fill="#111827"
        variants={{ hidden: { opacity: 0, scale: 0 }, visible: { opacity: 1, scale: 1, transition: { duration: 0.3, delay: 0.9 } } }}
      />
      {/* 微笑 */}
      <motion.path
        d="M44 90c6 6 14 9 20 9s14-3 20-9"
        fill="none" stroke="#be123c" strokeWidth="6" strokeLinecap="round"
        variants={{ hidden: { pathLength: 0 }, visible: { pathLength: 1, transition: { duration: 0.5, delay: 1.0 } } }}
      />
      {/* 左触角 */}
      <motion.path
        d="M22 38l12 8"
        stroke="#fb7185" strokeWidth="6" strokeLinecap="round"
        variants={{ hidden: { pathLength: 0, opacity: 0 }, visible: { pathLength: 1, opacity: 1, transition: { duration: 0.3, delay: 1.2 } } }}
      />
      {/* 右触角 */}
      <motion.path
        d="M106 38l-12 8"
        stroke="#fb7185" strokeWidth="6" strokeLinecap="round"
        variants={{ hidden: { pathLength: 0, opacity: 0 }, visible: { pathLength: 1, opacity: 1, transition: { duration: 0.3, delay: 1.3 } } }}
      />
    </motion.svg>
  );
}

// ── 功能特性 ──
const features = [
  {
    icon: MessageCircle,
    title: "智能对话",
    desc: "支持多轮对话、上下文记忆，理解你的需求并持续学习",
  },
  {
    icon: Zap,
    title: "技能扩展",
    desc: "可安装和管理技能插件，按需扩展 Agent 的能力边界",
  },
  {
    icon: Brain,
    title: "长期记忆",
    desc: "自动积累交互记忆，越用越懂你，打造个性化 AI 助手",
  },
  {
    icon: Shield,
    title: "权限控制",
    desc: "按工作空间和工具策略约束智能体能力，降低误操作风险",
  },
  {
    icon: Cpu,
    title: "多模型支持",
    desc: "灵活切换底层大模型，选择最适合场景的 AI 引擎",
  },
  {
    icon: Network,
    title: "企业级部署",
    desc: "支持私有化部署，数据不出内网，满足合规要求",
  },
];

const industryLabel: Record<string, string> = {
  general: "通用",
  banking: "银行",
  insurance: "保险",
  securities: "证券",
};

const INSTALL_COMMAND = "curl -fsSL https://linggan.top/install.sh | bash";

function reportInstallCommandCopied(): void {
  const installId = window.crypto.randomUUID();
  void fetch("/api/public/install-events", {
    method: "POST",
    credentials: "omit",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      installId,
      eventType: "command_copied",
      stage: "homepage",
      source: "homepage",
    }),
  }).catch(() => undefined);
}

export default function ClawHome() {
  const brand = useBrand();
  const [, setLocation] = useLocation();
  const { user, logout } = useAuth();
  const [provisioning, setProvisioning] = useState(false);
  const [provisionStep, setProvisionStep] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState("general-assistant");
  const [installCopied, setInstallCopied] = useState(false);
  const installCopyTimer = useRef<number | null>(null);

  useEffect(() => {
    const previous = document.body.getAttribute("data-home-light");
    document.body.setAttribute("data-home-light", "true");
    return () => {
      if (previous === null) document.body.removeAttribute("data-home-light");
      else document.body.setAttribute("data-home-light", previous);
    };
  }, []);

  useEffect(() => () => {
    if (installCopyTimer.current !== null) window.clearTimeout(installCopyTimer.current);
  }, []);

  const { data: clawMe, refetch: refetchClawMe, isLoading } = trpc.claw.me.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const { data: roleTemplates } = trpc.claw.roleTemplates.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });

  const selectableRoles = useMemo(() => {
    const roles = Array.isArray((roleTemplates as any)?.roles) ? (roleTemplates as any).roles : [];
    return roles
      .filter((role: any) => role?.status === "mvp")
      .sort((a: any, b: any) => Number(a.displayOrder || 0) - Number(b.displayOrder || 0));
  }, [roleTemplates]);

  const selectedRole = useMemo(
    () => selectableRoles.find((role: any) => role.id === selectedRoleId) || selectableRoles[0],
    [selectableRoles, selectedRoleId],
  );

  const trpcUtils = trpc.useUtils();

  const adoptMutation = trpc.claw.adopt.useMutation({
    retry: false,
    onError: (e: any) => toast.error(e?.message || "创建失败，请稍后重试"),
  });

  const handleAdopt = async (options: { preferRuntime?: "jiuwenswarm" | "openclaw" } = {}) => {
    if (!user) {
      setLocation("/login?redirect=/");
      return;
    }
    try {
      setProvisioning(true);
      setProvisionStep("正在初始化专属实例…");

      const result = await adoptMutation.mutateAsync({
        roleTemplate: selectedRole?.id || selectedRoleId,
        preferRuntime: options.preferRuntime,
      });
      const adoptId = result?.adoption?.adoptId;
      if (!adoptId) throw new Error("未获取到实例信息");

      const currentStatus = result?.adoption?.status;
      if (currentStatus !== "active") {
        const startedAt = Date.now();
        // 2026-04-18: 显式 string 类型避免 TS narrow 掉 "active"（poll 中会等到 active）
        let status: string | undefined = currentStatus;
        while (Date.now() - startedAt < 60000) {
          const elapsed = Date.now() - startedAt;
          if (elapsed < 15000) setProvisionStep("正在创建实例身份与路由…");
          else if (elapsed < 35000) setProvisionStep("正在注入默认能力与安全配置…");
          else setProvisionStep("即将完成…");

          await new Promise((r) => setTimeout(r, 1500));
          const latest = await trpcUtils.claw.getByAdoptId.fetch({ adoptId });
          status = latest?.status;
          if (status === "active") break;
          if (status === "failed") throw new Error("创建失败，请稍后重试");
        }
        if (status !== "active") throw new Error("创建时间较长，请刷新页面后重试");
      }

      toast.success(result.reused ? "已为你打开智能体工作台" : "申请成功！");
      await refetchClawMe();
      setLocation(`/claw/${adoptId}`);
    } catch (error: any) {
      toast.error(error?.message || "创建失败，请稍后重试");
    } finally {
      setProvisioning(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    window.location.reload();
  };

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handlePrimaryCta = () => {
    if (!user) {
      setLocation("/login?redirect=/");
      return;
    }
    scrollToSection("agent-panel");
  };

  const handleCopyInstall = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      reportInstallCommandCopied();
      setInstallCopied(true);
      if (installCopyTimer.current !== null) window.clearTimeout(installCopyTimer.current);
      installCopyTimer.current = window.setTimeout(() => setInstallCopied(false), 1600);
    } catch {
      toast.error("复制失败，请手动复制安装命令");
    }
  };

  // 向后兼容：若服务端尚未升级，回退到单张 adoption
  const adoptions: any[] = Array.isArray((clawMe as any)?.adoptions)
    ? (clawMe as any).adoptions
    : (clawMe as any)?.adoption
      ? [(clawMe as any).adoption]
      : [];
  const visibleAdoptions = adoptions.filter((adoption) => !isArchivedRuntimeAdoption(adoption));
  const hasAnyClaw = visibleAdoptions.length > 0;
  const hasActiveAdoption = visibleAdoptions.some((adoption) => adoption?.status === "active");
  const primaryCtaLabel = !user
    ? "登录开始"
    : hasActiveAdoption
      ? "查看我的智能体"
      : "选择岗位";

  const roleName = (roleTemplate: unknown) => {
    const id = String(roleTemplate || "");
    return selectableRoles.find((role: any) => role.id === id)?.name || "岗位智能体";
  };

  const rolePicker = (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-left">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">岗位身份</span>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          {industryLabel[String(selectedRole?.industry || "general")] || "通用"}
        </span>
      </div>
      <Select value={selectedRole?.id || selectedRoleId} onValueChange={setSelectedRoleId} disabled={provisioning || selectableRoles.length === 0}>
        <SelectTrigger className="h-10 bg-white text-sm">
          <SelectValue placeholder="选择岗位" />
        </SelectTrigger>
        <SelectContent>
          {selectableRoles.map((role: any) => (
            <SelectItem key={role.id} value={role.id}>
              {role.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selectedRole?.description ? (
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{selectedRole.description}</p>
      ) : null}
    </div>
  );

  return (
    <div className="claw-home-shell min-h-screen bg-[#fafaf9]">
      {/* ── Header ── */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-border/50">
        <div className="container flex items-center justify-between h-14 px-6">
          <div className="flex items-center gap-2.5">
            <BrandIcon size={32} />
            <span className="text-base font-bold text-gray-900">{brand.name}</span>
            <span className="text-xs text-muted-foreground hidden sm:inline">{brand.nameEn}</span>
          </div>
          <div className="flex items-center gap-2">
            {user && (user as any)?.role === "admin" && (
              <Button variant="ghost" size="sm" onClick={() => setLocation("/admin")} className="lingxia-soft-action gap-1.5 px-3">
                <Settings className="w-4 h-4 mr-1.5" />
                管理
              </Button>
            )}
            {user ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="gap-2 lingxia-soft-action px-2.5">
                    <Avatar className="w-6 h-6">
                      <AvatarFallback className="text-xs bg-primary/10 text-primary">
                        {((user as any)?.name || "U")[0].toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="hidden sm:inline">{(user as any)?.name || (user as any)?.email}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleLogout} className="text-destructive cursor-pointer">
                    <LogOut className="w-4 h-4 mr-2" />
                    退出登录
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button size="sm" onClick={() => setLocation("/login?redirect=/")} className="bg-primary hover:bg-primary/90 text-white">
                <LogIn className="w-4 h-4 mr-1.5" />
                登录
              </Button>
            )}
          </div>
        </div>
      </header>

      <main>
        {/* ── Hero Section ── */}
        <section className="claw-home-hero relative overflow-hidden py-14 lg:py-20">
          <div className="relative mx-auto grid max-w-[1120px] grid-cols-1 items-center gap-10 px-6 lg:grid-cols-[1fr_420px] lg:gap-16">
            <div className="max-w-[620px] text-left">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1.5 shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" />
                <span className="text-xs font-semibold text-gray-700">你的专属 AI Agent</span>
              </div>

              <h1 className="mb-5 text-4xl font-black leading-tight text-gray-900 sm:text-5xl">
                <span className="block">申请一个</span>
                <span className="block text-primary">岗位智能体</span>
              </h1>

              <p className="mb-3 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
                具备对话、技能、记忆与权限控制的 AI Agent 助手，让专业能力沉淀为可持续工作的数字同事。
              </p>
              <p className="mb-8 text-sm font-medium text-gray-400">
                Open-source &middot; Self-hosted &middot; Enterprise-ready
              </p>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  size="lg"
                  className="h-11 w-full bg-primary px-6 text-white hover:bg-primary/90 sm:w-auto"
                  onClick={handlePrimaryCta}
                >
                  {primaryCtaLabel}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="h-11 w-full border-gray-200 bg-white px-6 text-gray-700 hover:border-gray-300 hover:bg-gray-50 sm:w-auto"
                  onClick={() => scrollToSection("install")}
                >
                  一键安装
                </Button>
              </div>
            </div>

            <div id="agent-panel" className="scroll-mt-24">
              <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-[0_20px_50px_rgba(28,28,30,0.07)] sm:p-7">
                <div className="mb-6 flex items-center justify-between gap-4">
                  <span className="text-xs font-bold uppercase text-gray-500">岗位智能体</span>
                  <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${hasActiveAdoption ? "text-emerald-600" : "text-gray-400"}`}>
                    <span className={`h-2 w-2 rounded-full ${hasActiveAdoption ? "bg-emerald-500 animate-pulse motion-reduce:animate-none" : "bg-gray-300"}`} />
                    {isLoading ? "读取中" : hasActiveAdoption ? "在线" : "待申请"}
                  </span>
                </div>

                {user && isLoading ? (
                  <div className="flex min-h-52 items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                  </div>
                ) : null}

                {!user ? (
                  <div>
                    <div className="mb-5 flex items-center gap-4">
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-red-100 bg-red-50">
                        <AnimatedLogo size={56} />
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-lg font-bold text-gray-900">你的岗位智能体</h2>
                        <p className="mt-1 truncate font-mono text-xs text-gray-400">登录后创建专属实例</p>
                      </div>
                    </div>
                    <div className="mb-6 flex flex-wrap gap-2">
                      {["对话", "技能", "记忆", "沙箱"].map((capability) => (
                        <span key={capability} className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">{capability}</span>
                      ))}
                    </div>
                    <Button className="h-11 w-full bg-primary text-white hover:bg-primary/90" onClick={() => setLocation("/login?redirect=/")}>
                      登录后申请
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </div>
                ) : null}

                {user && !isLoading && hasAnyClaw ? (
                  <div>
                    <div className="divide-y divide-gray-100">
                      {visibleAdoptions.map((adoption: any, index) => {
                        const runtime = getRuntimeCardMeta(adoption.adoptId);
                        const adoptId = String(adoption.adoptId || "");
                        return (
                          <div key={adoption.adoptId} className={index === 0 ? "pb-6" : "py-6 last:pb-0"}>
                            <div className="mb-5 flex items-center gap-4">
                              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-red-100 bg-red-50">
                                {index === 0 ? <AnimatedLogo size={56} /> : <img src={runtime.icon} alt="" className="h-10 w-10 object-contain" />}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="mb-1 flex min-w-0 items-center gap-2">
                                  <h2 className="truncate text-lg font-bold text-gray-900">{roleName(adoption.roleTemplate)}</h2>
                                  <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${runtime.badgeClass}`}>{runtime.name}</span>
                                </div>
                                <p className="truncate font-mono text-xs text-gray-400">{adoptId}</p>
                              </div>
                            </div>

                            <div className="mb-6 flex flex-wrap gap-2">
                              {["对话", "技能", "记忆", "沙箱"].map((capability) => (
                                <span key={capability} className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">{capability}</span>
                              ))}
                            </div>

                            <Button
                              className="h-11 w-full bg-emerald-600 text-white hover:bg-emerald-700"
                              onClick={() => setLocation(`/claw/${adoptId}`)}
                            >
                              进入工作台
                              <ArrowRight className="ml-2 h-4 w-4" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>

                  </div>
                ) : null}

                {user && !isLoading && !hasAnyClaw ? (
                  <div>
                    <div className="mb-5 flex items-center gap-4">
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-red-100 bg-red-50">
                        <AnimatedLogo size={56} />
                      </div>
                      <div className="min-w-0">
                        <h2 className="truncate text-lg font-bold text-gray-900">{selectedRole?.name || "岗位智能体"}</h2>
                        <p className="mt-1 truncate font-mono text-xs text-gray-400">等待创建专属实例</p>
                      </div>
                    </div>
                    <div className="mb-5 flex flex-wrap gap-2">
                      {["对话", "技能", "记忆", "沙箱"].map((capability) => (
                        <span key={capability} className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">{capability}</span>
                      ))}
                    </div>
                    <div className="space-y-3">
                      {rolePicker}
                      <Button size="lg" className="h-11 w-full bg-primary text-white hover:bg-primary/90" onClick={() => handleAdopt()} disabled={provisioning}>
                        {provisioning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {provisioning ? provisionStep : "申请岗位智能体"}
                        {!provisioning ? <ArrowRight className="ml-2 h-4 w-4" /> : null}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        {/* ── Install ── */}
        <section id="install" className="scroll-mt-20 px-6 pb-16">
          <div className="mx-auto flex max-w-[1120px] flex-col gap-6 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-md">
              <h2 className="text-2xl font-black text-gray-900">一键安装</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">一行命令，在你的服务器上私有化部署</p>
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-red-100 bg-red-50 px-4 py-3 lg:max-w-[600px]">
              <span className="shrink-0 font-mono text-sm font-bold text-primary">$</span>
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-gray-700">{INSTALL_COMMAND}</code>
              <button
                type="button"
                onClick={handleCopyInstall}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 text-xs font-semibold text-primary transition-colors hover:border-red-300 hover:bg-red-50"
                aria-label="复制安装命令"
              >
                {installCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {installCopied ? "已复制" : "复制"}
              </button>
            </div>
          </div>
        </section>

        {/* ── Features ── */}
        <section className="py-16">
          <div className="mx-auto max-w-[1120px] px-6">
            <div className="mb-10 text-center">
              <h2 className="text-3xl font-black text-gray-900">能力一览</h2>
              <p className="mt-3 text-base text-muted-foreground">每个岗位智能体都是一个独立的 AI Agent 实例</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((feature) => (
                <article key={feature.title} className="rounded-xl border border-gray-200 bg-white p-6 transition-[border-color,box-shadow] duration-200 hover:border-gray-300 hover:shadow-sm">
                  <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg bg-red-50">
                    <feature.icon className="h-4 w-4 text-primary" />
                  </div>
                  <h3 className="text-base font-bold text-gray-900">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{feature.desc}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="py-6 border-t border-border/50">
        <div className="container px-6 flex items-center justify-between text-xs text-muted-foreground">
          <span>{`Powered by ${brand.nameEn}`}</span>
          <a
            href={brand.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-primary transition-colors"
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
