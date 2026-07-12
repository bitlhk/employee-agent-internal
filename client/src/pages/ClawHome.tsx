/**
 * ClawHome — 岗位智能体独立首页（路径模式）
 * 风格：白色主题，与平台首页一致
 * 功能：Hero + 功能介绍 + 创建/进入
 */

import { useMemo, useState, useEffect } from "react";
import { BrandIcon } from "@/components/BrandIcon";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  Loader2, LogIn, LogOut, Settings, ArrowRight,
  MessageCircle, Brain, Cpu, Zap, Shield, Network,
} from "lucide-react";
import { motion, type Variants } from "framer-motion";
import { toast } from "sonner";
import { useBrand } from "@/lib/useBrand";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

// ── 动画变体（2026-04-18: 加 Variants 类型，避免 framer-motion v11 ease 字符串被推断为 string 而非具体 Easing 枚举）──
const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
};
const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1 } },
};
const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.8 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.6, ease: "easeOut" } },
};

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
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      xmlns="http://www.w3.org/2000/svg"
      initial="hidden"
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

export default function ClawHome() {
  const brand = useBrand();
  const [, setLocation] = useLocation();
  const { user, logout } = useAuth();
  const [provisioning, setProvisioning] = useState(false);
  const [provisionStep, setProvisionStep] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState("general-assistant");

  useEffect(() => {
    const previous = document.body.getAttribute("data-home-light");
    document.body.setAttribute("data-home-light", "true");
    return () => {
      if (previous === null) document.body.removeAttribute("data-home-light");
      else document.body.setAttribute("data-home-light", previous);
    };
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

  // 向后兼容：若服务端尚未升级，回退到单张 adoption
  const adoptions: any[] = Array.isArray((clawMe as any)?.adoptions)
    ? (clawMe as any).adoptions
    : (clawMe as any)?.adoption
      ? [(clawMe as any).adoption]
      : [];
  const hasAnyClaw = adoptions.length > 0;
  const hasOnlyArchivedAdoptions = hasAnyClaw && adoptions.every(isArchivedRuntimeAdoption);

  const rolePicker = (
    <div className="rounded-xl border border-border/60 bg-white/85 p-3 text-left shadow-sm">
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
    <div className="claw-home-shell min-h-screen bg-gradient-to-b from-white to-gray-50/80">
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

      {/* ── Hero Section ── */}
      <section className="relative pt-16 pb-12 overflow-hidden">
        {/* 装饰背景 */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-20 left-1/4 w-72 h-72 bg-primary/5 rounded-full blur-3xl" />
          <div className="absolute top-40 right-1/4 w-96 h-96 bg-rose-500/5 rounded-full blur-3xl" />
        </div>

        <div className="container px-6 relative">
          <motion.div
            initial="hidden"
            animate="visible"
            variants={staggerContainer}
            className="flex flex-col items-center text-center"
          >
            {/* Logo 动画 */}
            <motion.div variants={scaleIn} className="mb-6">
              <AnimatedLogo size={120} />
            </motion.div>

            <motion.div variants={fadeInUp} className="mb-3">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/10 rounded-full">
                <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
                <span className="text-xs font-medium text-primary">你的专属 AI Agent</span>
              </div>
            </motion.div>

            <motion.h1 variants={fadeInUp} className="text-3xl md:text-5xl font-bold leading-tight mb-4">
              <span className="text-gray-900">申请一个</span>
              <span className="text-primary">岗位智能体</span>
            </motion.h1>

            <motion.p variants={fadeInUp} className="text-base text-muted-foreground mb-2 max-w-lg">
              具备对话、技能、记忆与权限控制的 AI Agent 助手
            </motion.p>
            <motion.p variants={fadeInUp} className="text-sm text-muted-foreground/70 mb-8">
              Open-source &middot; Self-hosted &middot; Enterprise-ready
            </motion.p>

            {/* CTA 区域 */}
            <motion.div variants={fadeInUp} className="w-full max-w-sm space-y-3">
              {user && isLoading && (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              )}

              {/* 已有岗位智能体：JiuwenSwarm 可进入，历史实例仅保留归档提示 */}
              {user && !isLoading && hasAnyClaw && (
                <div className="space-y-3">
                  {adoptions.map((a: any) => {
                    const runtime = getRuntimeCardMeta(a.adoptId);
                    const adoptId = String(a.adoptId || "");
                    const isArchivedRuntime = isArchivedRuntimeAdoption(a);
                    return (
                      <Card key={a.adoptId} className="border-border/50 bg-white/80 backdrop-blur-sm overflow-hidden">
                        <div className="p-5">
                          <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-white border border-border/60 shadow-sm flex items-center justify-center overflow-hidden shrink-0">
                              <img src={runtime.icon} alt={runtime.name} className="w-8 h-8 object-contain" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 mb-0.5">
                                <p className="text-sm font-semibold text-gray-900">岗位智能体</p>
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${runtime.badgeClass}`}
                                >
                                  {runtime.name}
                                </span>
                              </div>
                              <p className="text-xs font-mono text-muted-foreground truncate">{a.adoptId}</p>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className={`w-2 h-2 rounded-full ${a.status === "active" ? "bg-green-500 animate-pulse" : "bg-yellow-500"}`} />
                              <span className={`text-xs font-medium ${a.status === "active" ? "text-green-600" : "text-yellow-600"}`}>
                                {a.status === "active" ? "在线" : a.status}
                              </span>
                            </div>
                          </div>
                          {isArchivedRuntime ? (
                            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-left">
                              <p className="text-sm font-medium text-amber-900">存量实例已归档</p>
                              <p className="mt-1 text-xs leading-5 text-amber-800">
                                该实例保留历史记录，不再进入工作台，也不再提供迁移入口。请按当前岗位重新申请岗位智能体。
                              </p>
                            </div>
                          ) : null}
                          <Button
                            className={`w-full text-white ${runtime.buttonClass}`}
                            disabled={isArchivedRuntime}
                            onClick={() => {
                              if (isArchivedRuntime) return;
                              setLocation(`/claw/${adoptId}`);
                            }}
                          >
                            {isArchivedRuntime ? "已归档，请重新申请" : "进入工作台"}
                            {!isArchivedRuntime ? <ArrowRight className="w-4 h-4 ml-2" /> : null}
                          </Button>
                        </div>
                      </Card>
                    );
                  })}
                  {hasOnlyArchivedAdoptions ? (
                    <div className="space-y-3">
                      {rolePicker}
                      <Button
                        className="w-full bg-primary text-white hover:bg-primary/90"
                        onClick={() => handleAdopt()}
                        disabled={provisioning}
                      >
                        {provisioning ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            {provisionStep}
                          </>
                        ) : (
                          <>
                            申请新的岗位智能体
                            <ArrowRight className="ml-2 h-4 w-4" />
                          </>
                        )}
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}

              {/* 没有智能体 → 按岗位创建 */}
              {user && !isLoading && !hasAnyClaw && (
                <div className="space-y-3">
                  {rolePicker}
                  <Button
                    size="lg"
                    className="w-full bg-primary hover:bg-primary/90 text-white h-12 text-base"
                    onClick={() => handleAdopt()}
                    disabled={provisioning}
                  >
                    {provisioning ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        {provisionStep}
                      </>
                    ) : (
                      <>
                        申请岗位智能体
                        <ArrowRight className="w-4 h-4 ml-2" />
                      </>
                    )}
                  </Button>
                </div>
              )}

              {/* 未登录 */}
              {!user && (
                <Button
                  size="lg"
                  className="w-full bg-primary hover:bg-primary/90 text-white h-12 text-base"
                  onClick={() => setLocation("/login?redirect=/")}
                >
                  <LogIn className="w-4 h-4 mr-2" />
                  登录开始
                </Button>
              )}
            </motion.div>

            {/* 装饰分隔 */}
            <motion.div variants={fadeInUp} className="flex items-center gap-3 mt-10">
              <div className="h-px w-16 bg-gradient-to-r from-transparent to-primary/30" />
              <div className="flex items-center gap-1.5">
                <Brain className="w-4 h-4 text-primary/50" />
                <Cpu className="w-4 h-4 text-primary/40" />
                <Network className="w-4 h-4 text-primary/30" />
              </div>
              <div className="h-px w-16 bg-gradient-to-l from-transparent to-primary/30" />
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="py-16">
        <div className="container px-6">
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-50px" }}
            variants={staggerContainer}
            className="text-center mb-10"
          >
            <motion.h2 variants={fadeInUp} className="text-2xl font-bold text-gray-900 mb-2">
              能力一览
            </motion.h2>
            <motion.p variants={fadeInUp} className="text-sm text-muted-foreground">
              每个岗位智能体都是一个独立的 AI Agent 实例
            </motion.p>
          </motion.div>

          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-50px" }}
            variants={staggerContainer}
            className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto"
          >
            {features.map((f) => (
              <motion.div key={f.title} variants={fadeInUp}>
                <Card className="h-full border-border/50 bg-white/80 backdrop-blur-sm p-5 hover:shadow-md hover:border-primary/20 transition-all duration-200">
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary/10 to-rose-500/10 border border-primary/20 flex items-center justify-center shrink-0">
                      <f.icon className="w-4.5 h-4.5 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-1">{f.title}</h3>
                      <p className="text-xs text-muted-foreground leading-relaxed">{f.desc}</p>
                    </div>
                  </div>
                </Card>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

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
