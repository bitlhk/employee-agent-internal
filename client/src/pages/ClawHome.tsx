/**
 * ClawHome - public Workforce Agent homepage.
 * Keeps the existing adoption flow while presenting the product as a working Agent console.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  ArrowRight,
  Brain,
  CalendarClock,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  FolderOpen,
  Fingerprint,
  Loader2,
  LockKeyhole,
  LogIn,
  LogOut,
  MessageCircle,
  Network,
  PackageSearch,
  Settings,
  ShieldCheck,
  ScrollText,
  Sparkles,
  UsersRound,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { BrandIcon } from "@/components/BrandIcon";
import { RoleAdoptionDialog } from "@/components/RoleAdoptionDialog";
import { WorkforceAgentIcon } from "@/components/WorkforceAgentIcon";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useBrand } from "@/lib/useBrand";

function getRuntimeCardMeta(adoptId: unknown) {
  const id = String(adoptId || "");
  if (id.startsWith("lgj-")) {
    return {
      name: "JiuwenSwarm",
      badgeClass: "bg-emerald-100 text-emerald-700",
    };
  }
  if (id.startsWith("lgh-")) {
    return {
      name: "历史实例",
      badgeClass: "bg-gray-100 text-gray-500",
    };
  }
  return {
    name: "存量实例",
    badgeClass: "bg-amber-100 text-amber-700",
  };
}

function isArchivedRuntimeAdoption(adoption: any) {
  const adoptId = String(adoption?.adoptId || "");
  return (
    adoptId.startsWith("lgc-") ||
    adoptId.startsWith("lgh-") ||
    adoption?.actualRuntime === "legacy_archived"
  );
}

const features = [
  {
    icon: MessageCircle,
    title: "持续对话",
    desc: "理解上下文与岗位目标，在多轮任务中持续推进，而不是只回答单个问题。",
  },
  {
    icon: Zap,
    title: "技能扩展",
    desc: "按岗位安装和管理技能，把团队方法、流程与经验沉淀为可复用能力。",
  },
  {
    icon: Network,
    title: "MCP 工具",
    desc: "连接客户、产品与内部业务系统，让 Agent 能查询数据并执行实际工作。",
  },
  {
    icon: Brain,
    title: "上下文沉淀",
    desc: "保留必要的工作偏好和任务线索，减少重复说明，保持协作连续性。",
  },
  {
    icon: Cpu,
    title: "多模型支持",
    desc: "模型目录由运行时动态提供，可按任务选择模型，也可由平台自动调度。",
  },
  {
    icon: ShieldCheck,
    title: "企业安全",
    desc: "支持私有化部署、权限策略和审计记录，适配企业内部安全边界。",
  },
];

const steps = [
  {
    num: "01",
    title: "选择岗位",
    desc: "从岗位模板开始，自动装配对应的角色、技能和工具权限。",
  },
  {
    num: "02",
    title: "创建实例",
    desc: "生成独立工作空间与运行身份，初始化岗位所需的基础能力。",
  },
  {
    num: "03",
    title: "进入工作台",
    desc: "直接对话、调用技能和连接业务系统，让智能体开始处理工作。",
  },
];

const INSTALL_COMMAND = "curl -fsSL https://linggan.top/install.sh | bash";
const WEALTH_DEMO_RESPONSE =
  "已筛选出 4 位本周优先跟进客户，并按风险等级、资金到期时间完成产品匹配。建议先联系 2 位稳健型客户，重点沟通现金管理与固收类方案。";

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

type ToolDemoCardProps = {
  icon: typeof Database;
  title: string;
  detail: string;
  state: "running" | "done";
};

function ToolDemoCard({ icon: Icon, title, detail, state }: ToolDemoCardProps) {
  return (
    <motion.div
      className="claw-home-demo-tool"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      data-state={state}
    >
      <span className="claw-home-demo-tool__icon">
        <Icon aria-hidden="true" />
      </span>
      <span className="claw-home-demo-tool__body">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <span className="claw-home-demo-tool__state">
        {state === "done" ? (
          <CheckCircle2 aria-hidden="true" />
        ) : (
          <Loader2 className="animate-spin" aria-hidden="true" />
        )}
        {state === "done" ? "完成" : "调用中"}
      </span>
    </motion.div>
  );
}

function WealthWorkflowDemo() {
  const reduceMotion = useReducedMotion();
  const [stage, setStage] = useState(0);
  const [agentText, setAgentText] = useState("");

  useEffect(() => {
    if (reduceMotion) {
      setStage(5);
      setAgentText(WEALTH_DEMO_RESPONSE);
      return;
    }

    let cancelled = false;
    let typingTimer: number | null = null;
    const timers: number[] = [];
    const later = (delay: number, callback: () => void) => {
      const timer = window.setTimeout(() => {
        if (!cancelled) callback();
      }, delay);
      timers.push(timer);
    };

    const startCycle = () => {
      setStage(0);
      setAgentText("");
      later(450, () => setStage(1));
      later(1300, () => setStage(2));
      later(2550, () => setStage(3));
      later(3800, () => {
        setStage(4);
        let cursor = 0;
        typingTimer = window.setInterval(() => {
          cursor = Math.min(cursor + 2, WEALTH_DEMO_RESPONSE.length);
          setAgentText(WEALTH_DEMO_RESPONSE.slice(0, cursor));
          if (cursor >= WEALTH_DEMO_RESPONSE.length) {
            if (typingTimer !== null) window.clearInterval(typingTimer);
            typingTimer = null;
            setStage(5);
            later(4800, startCycle);
          }
        }, 42);
      });
    };

    startCycle();
    return () => {
      cancelled = true;
      timers.forEach(timer => window.clearTimeout(timer));
      if (typingTimer !== null) window.clearInterval(typingTimer);
    };
  }, [reduceMotion]);

  return (
    <div className="claw-home-demo" aria-label="财富经理智能体工具调用演示">
      <div className="claw-home-demo__windowbar">
        <span className="claw-home-demo__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>财富经理智能体 · 工作台</span>
        <span className="claw-home-demo__online">
          <i /> 在线
        </span>
      </div>

      <div className="claw-home-demo__workspace">
        <aside className="claw-home-demo__sidebar" aria-label="工作台导航演示">
          <div className="claw-home-demo__agent">
            <WorkforceAgentIcon size={30} animate={false} breathe={false} />
            <span>
              <strong>财富经理</strong>
              <small>JiuwenSwarm</small>
            </span>
          </div>
          <span className="claw-home-demo__nav is-active">
            <MessageCircle /> 对话
          </span>
          <span className="claw-home-demo__nav">
            <Zap /> 技能
          </span>
          <span className="claw-home-demo__nav">
            <CalendarClock /> 定时任务
          </span>
          <span className="claw-home-demo__nav">
            <FolderOpen /> 工作空间
          </span>
          <span className="claw-home-demo__nav">
            <Settings /> 设置
          </span>
        </aside>

        <div className="claw-home-demo__chat" aria-live="polite">
          <div className="claw-home-demo__chat-head">
            <span>
              <strong>客户经营分析</strong>
              <small>演示数据 · 不包含真实客户信息</small>
            </span>
            <span className="claw-home-demo__model">自动 · openPangu</span>
          </div>

          <div className="claw-home-demo__messages">
            <AnimatePresence>
              {stage >= 1 ? (
                <motion.div
                  key="user-message"
                  className="claw-home-demo__user-message"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  帮我筛选本周重点跟进客户，并推荐合适的财富产品。
                </motion.div>
              ) : null}
            </AnimatePresence>

            {stage >= 2 ? (
              <div className="claw-home-demo__tool-stack">
                <div className="claw-home-demo__trust-strip" aria-label="可信执行状态">
                  <span data-active="true">
                    <Fingerprint aria-hidden="true" /> 岗位身份已验证
                  </span>
                  <span data-active={stage >= 3 ? "true" : "false"}>
                    <LockKeyhole aria-hidden="true" /> 本人客户范围
                  </span>
                  <span data-active={stage >= 5 ? "true" : "false"}>
                    <ScrollText aria-hidden="true" /> 审计留痕
                  </span>
                </div>
                <div className="claw-home-demo__tool-label">
                  <Sparkles aria-hidden="true" /> 受控 MCP 工具调用
                </div>
                <ToolDemoCard
                  icon={UsersRound}
                  title="获取客户列表"
                  detail={
                    stage >= 3
                      ? "已读取 23 位客户 · 完成分层筛选"
                      : "正在读取客户分层与资金到期信息"
                  }
                  state={stage >= 3 ? "done" : "running"}
                />
                {stage >= 3 ? (
                  <ToolDemoCard
                    icon={PackageSearch}
                    title="推荐适配产品"
                    detail={
                      stage >= 4
                        ? "已匹配 6 款产品 · 完成风险适配"
                        : "正在匹配产品风险等级与客户偏好"
                    }
                    state={stage >= 4 ? "done" : "running"}
                  />
                ) : null}
              </div>
            ) : null}

            {stage >= 4 ? (
              <motion.div
                className="claw-home-demo__assistant-message"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                {agentText}
                {stage === 4 ? (
                  <span className="claw-home-demo__cursor">|</span>
                ) : null}
              </motion.div>
            ) : null}

            {stage >= 5 ? (
              <motion.div
                className="claw-home-demo__result-note"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                <ShieldCheck aria-hidden="true" /> 受控执行已完成 · 审计记录已保存
              </motion.div>
            ) : null}
          </div>

          <div className="claw-home-demo__composer">
            <span>输入消息，或选择技能与模型</span>
            <span className="claw-home-demo__composer-actions">
              <Zap aria-hidden="true" />
              <i>
                <ArrowRight aria-hidden="true" />
              </i>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ClawHome() {
  const brand = useBrand();
  const [, setLocation] = useLocation();
  const { user, logout } = useAuth();
  const [provisioning, setProvisioning] = useState(false);
  const [provisionStep, setProvisionStep] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
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

  useEffect(
    () => () => {
      if (installCopyTimer.current !== null) {
        window.clearTimeout(installCopyTimer.current);
      }
    },
    []
  );

  const {
    data: clawMe,
    refetch: refetchClawMe,
    isLoading,
  } = trpc.claw.me.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const { data: roleTemplates } = trpc.claw.roleTemplates.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });

  const selectableRoles = useMemo(() => {
    const roles = Array.isArray((roleTemplates as any)?.roles)
      ? (roleTemplates as any).roles
      : [];
    return roles
      .filter((role: any) => role?.status === "mvp")
      .sort(
        (a: any, b: any) =>
          Number(a.displayOrder || 0) - Number(b.displayOrder || 0)
      );
  }, [roleTemplates]);

  const selectedRole = useMemo(
    () => selectableRoles.find((role: any) => role.id === selectedRoleId) || null,
    [selectableRoles, selectedRoleId]
  );

  const trpcUtils = trpc.useUtils();
  const adoptMutation = trpc.claw.adopt.useMutation({
    retry: false,
    onError: (error: any) =>
      toast.error(error?.message || "创建失败，请稍后重试"),
  });

  const handleAdopt = async (
    options: { preferRuntime?: "jiuwenswarm" | "openclaw" } = {}
  ) => {
    if (!user) {
      setLocation("/login?redirect=/");
      return;
    }
    if (!selectedRole) {
      toast.info("请先选择岗位");
      setRolePickerOpen(true);
      return;
    }
    try {
      setProvisioning(true);
      setProvisionStep("正在初始化专属实例...");
      const result = await adoptMutation.mutateAsync({
        roleTemplate: selectedRole.id,
        preferRuntime: options.preferRuntime,
      });
      const adoptId = result?.adoption?.adoptId;
      if (!adoptId) throw new Error("未获取到实例信息");

      const currentStatus = result?.adoption?.status;
      if (currentStatus !== "active") {
        const startedAt = Date.now();
        let status: string | undefined = currentStatus;
        while (Date.now() - startedAt < 60_000) {
          const elapsed = Date.now() - startedAt;
          if (elapsed < 15_000) setProvisionStep("正在创建实例身份与路由...");
          else if (elapsed < 35_000)
            setProvisionStep("正在注入默认能力与安全配置...");
          else setProvisionStep("即将完成...");

          await new Promise(resolve => window.setTimeout(resolve, 1500));
          const latest = await trpcUtils.claw.getByAdoptId.fetch({ adoptId });
          status = latest?.status;
          if (status === "active") break;
          if (status === "failed") throw new Error("创建失败，请稍后重试");
        }
        if (status !== "active")
          throw new Error("创建时间较长，请刷新页面后重试");
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
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleCopyInstall = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      reportInstallCommandCopied();
      setInstallCopied(true);
      if (installCopyTimer.current !== null) {
        window.clearTimeout(installCopyTimer.current);
      }
      installCopyTimer.current = window.setTimeout(
        () => setInstallCopied(false),
        1600
      );
    } catch {
      toast.error("复制失败，请手动复制安装命令");
    }
  };

  const adoptions: any[] = Array.isArray((clawMe as any)?.adoptions)
    ? (clawMe as any).adoptions
    : (clawMe as any)?.adoption
      ? [(clawMe as any).adoption]
      : [];
  const visibleAdoptions = adoptions.filter(
    adoption => !isArchivedRuntimeAdoption(adoption)
  );
  const hasAnyClaw = visibleAdoptions.length > 0;
  const activeAdoption = visibleAdoptions.find(
    adoption => adoption?.status === "active"
  );
  const hasActiveAdoption = Boolean(activeAdoption);

  const roleName = (roleTemplate: unknown) => {
    const id = String(roleTemplate || "");
    return (
      selectableRoles.find((role: any) => role.id === id)?.name || "岗位智能体"
    );
  };

  const handleBottomCta = () => {
    if (!user) {
      setLocation("/login?redirect=/");
      return;
    }
    if (activeAdoption?.adoptId) {
      setLocation(`/claw/${activeAdoption.adoptId}`);
      return;
    }
    scrollToSection("agent-panel");
  };

  const openRolePicker = (roleId = "") => {
    setSelectedRoleId(roleId);
    setRolePickerOpen(true);
  };

  return (
    <div className="claw-home-shell claw-home-v2 min-h-screen bg-white">
      <header className="claw-home-v2__header sticky top-0 z-50 border-b">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-5 sm:px-8">
          <button
            type="button"
            className="flex items-center gap-2.5"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            aria-label="返回岗位智能体首页顶部"
          >
            <BrandIcon size={30} animate />
            <span className="text-base font-bold text-[#1a1a1a]">
              岗位智能体
            </span>
          </button>

          <nav className="hidden items-center gap-8 text-sm font-medium text-[#5d5b54] md:flex">
            <button type="button" onClick={() => scrollToSection("features")}>
              能力
            </button>
            <button type="button" onClick={() => scrollToSection("steps")}>
              流程
            </button>
            <button
              type="button"
              onClick={() => scrollToSection("agent-panel")}
            >
              开始使用
            </button>
          </nav>

          <div className="flex items-center gap-2">
            {user && (user as any)?.role === "admin" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocation("/admin")}
                className="lingxia-soft-action hidden gap-1.5 px-3 sm:inline-flex"
              >
                <Settings /> 管理
              </Button>
            ) : null}
            {user ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="lingxia-soft-action gap-2 px-2.5"
                  >
                    <Avatar className="h-6 w-6">
                      <AvatarFallback className="bg-primary/10 text-xs text-primary">
                        {((user as any)?.name || "U")[0].toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="hidden max-w-28 truncate sm:inline">
                      {(user as any)?.name || (user as any)?.email}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(user as any)?.role === "admin" ? (
                    <DropdownMenuItem
                      className="cursor-pointer sm:hidden"
                      onClick={() => setLocation("/admin")}
                    >
                      <Settings className="mr-2" /> 管理
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    onClick={handleLogout}
                    className="cursor-pointer text-destructive"
                  >
                    <LogOut className="mr-2" /> 退出登录
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                size="sm"
                onClick={() => setLocation("/login?redirect=/")}
              >
                <LogIn /> 登录
              </Button>
            )}
          </div>
        </div>
      </header>

      {user ? (
        <RoleAdoptionDialog
          open={rolePickerOpen}
          onOpenChange={setRolePickerOpen}
          roles={selectableRoles}
          selectedRoleId={selectedRoleId}
          onSelectRole={setSelectedRoleId}
          onAdopt={() => void handleAdopt()}
          canAdopt={!hasAnyClaw}
          provisioning={provisioning}
          provisionStep={provisionStep}
        />
      ) : null}

      <main>
        <section className="claw-home-v2__hero">
          <div className="claw-home-v2__hero-inner">
            <div className="claw-home-v2__copy">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3.5 py-1.5 text-xs font-semibold text-red-700">
                <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" />
                为岗位而生的 AI Agent · 开源 · 可私有化
              </div>
              <h1 className="m-0 text-4xl font-bold leading-[1.12] text-[#1a1a1a] sm:text-5xl xl:text-[52px]">
                为每个岗位
                <span className="mt-2 block text-primary">配一个智能体</span>
              </h1>
              <p className="mt-5 max-w-[560px] text-base leading-7 text-[#5d5b54] sm:text-lg">
                连接企业知识、专业技能与业务系统，让每个岗位拥有可落地、可扩展的 AI 工作能力。
              </p>
              <p className="mt-2 text-xs font-medium text-[#a4a097] sm:text-sm">
                Open-source · Self-hosted · Enterprise-ready
              </p>

              <div
                id="agent-panel"
                className="mt-7 w-full max-w-[460px] scroll-mt-24"
              >
                {!user ? (
                  <div className="flex flex-col justify-center gap-3 sm:flex-row">
                    <Button
                      size="lg"
                      className="claw-home-v2__primary-cta h-11 px-7"
                      onClick={() => setLocation("/login?redirect=/")}
                    >
                      <LogIn /> 登录开始
                    </Button>
                    <Button
                      size="lg"
                      variant="outline"
                      className="h-11 border-[#c8c4be] bg-white px-6 text-[#1a1a1a] hover:bg-[#fafaf9]"
                      onClick={() => scrollToSection("features")}
                    >
                      了解能力 <ArrowDown />
                    </Button>
                  </div>
                ) : null}

                {user && isLoading ? (
                  <div className="claw-home-v2__state-card flex min-h-32 items-center justify-center">
                    <Loader2 className="animate-spin text-gray-400" />
                  </div>
                ) : null}

                {user && !isLoading && hasAnyClaw ? (
                  <div className="claw-home-v2__state-card text-left">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold text-[#787671]">
                        我的岗位智能体
                      </span>
                      <span className="flex items-center gap-3">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#77736c] hover:text-[#1a1a1a]"
                          onClick={() => openRolePicker(String(activeAdoption?.roleTemplate || visibleAdoptions[0]?.roleTemplate || ""))}
                        >
                          <UsersRound className="h-3.5 w-3.5" /> 岗位一览
                        </button>
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                          <i className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse motion-reduce:animate-none" />
                          {hasActiveAdoption ? "在线" : "初始化中"}
                        </span>
                      </span>
                    </div>
                    <div className="max-h-[280px] divide-y divide-[#ede9e4] overflow-y-auto">
                      {visibleAdoptions.map((adoption: any) => {
                        const runtime = getRuntimeCardMeta(adoption.adoptId);
                        const adoptId = String(adoption.adoptId || "");
                        const active = adoption?.status === "active";
                        return (
                          <div
                            key={adoptId}
                            className="py-3 first:pt-1 last:pb-1"
                          >
                            <div className="flex items-center gap-3">
                              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-50">
                                <WorkforceAgentIcon
                                  size={36}
                                  animate={false}
                                  breathe={false}
                                />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex min-w-0 items-center gap-2">
                                  <strong className="truncate text-sm text-[#1a1a1a]">
                                    {roleName(adoption.roleTemplate)}
                                  </strong>
                                  <small
                                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${runtime.badgeClass}`}
                                  >
                                    {runtime.name}
                                  </small>
                                </span>
                                <small className="mt-0.5 block truncate font-mono text-[11px] text-[#a4a097]">
                                  {adoptId}
                                </small>
                              </span>
                              <Button
                                size="sm"
                                disabled={!active}
                                onClick={() => setLocation(`/claw/${adoptId}`)}
                              >
                                {active ? "进入" : "等待"} <ArrowRight />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {user && !isLoading && !hasAnyClaw ? (
                  <div className="claw-home-v2__state-card text-left">
                    <div className="role-adoption-launch">
                      <span className="role-adoption-launch__icon">
                        <UsersRound aria-hidden="true" />
                      </span>
                      <span className="role-adoption-launch__copy">
                        <strong>选择你的数字员工</strong>
                        <small>从 {selectableRoles.length || 6} 个岗位中选择，自动配置专业技能与业务工具。</small>
                      </span>
                    </div>
                    <Button
                      size="lg"
                      className="mt-4 h-11 w-full"
                      onClick={() => openRolePicker()}
                      disabled={provisioning || selectableRoles.length === 0}
                    >
                      选择岗位智能体 <ArrowRight />
                    </Button>
                  </div>
                ) : null}
              </div>

              <div id="install" className="claw-home-install mt-5 scroll-mt-24">
                <span className="claw-home-install__prompt" aria-hidden="true">
                  $
                </span>
                <code>{INSTALL_COMMAND}</code>
                <button
                  type="button"
                  onClick={handleCopyInstall}
                  aria-label={installCopied ? "安装命令已复制" : "复制安装命令"}
                  title={installCopied ? "已复制" : "复制安装命令"}
                >
                  {installCopied ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <Copy aria-hidden="true" />
                  )}
                </button>
              </div>
              <p className="mt-2 text-xs text-[#a4a097]">
                一条命令，让岗位智能体在你的服务器上开工
              </p>
            </div>

            <div className="claw-home-v2__showcase">
              <WealthWorkflowDemo />
            </div>
          </div>
        </section>

        <section
          id="features"
          className="claw-home-v2__features scroll-mt-16 border-b border-[#ede9e4] bg-white px-5 pb-20 pt-16 sm:px-8 sm:pb-24 sm:pt-20"
        >
          <div className="mx-auto max-w-[1120px]">
            <div className="mb-10 text-center sm:mb-12">
              <div className="mb-3 text-xs font-bold text-primary">
                能力一览
              </div>
              <h2 className="text-3xl font-bold text-[#1a1a1a] sm:text-4xl">
                每个实例，都是完整的 Agent
              </h2>
              <p className="mt-3 text-sm text-[#787671] sm:text-base">
                不止对话，还能调用技能、连接工具并持续完成岗位任务。
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {features.map(feature => (
                <article key={feature.title} className="claw-home-feature">
                  <span className="claw-home-feature__icon">
                    <feature.icon aria-hidden="true" />
                  </span>
                  <h3>{feature.title}</h3>
                  <p>{feature.desc}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section
          id="steps"
          className="scroll-mt-16 border-b border-[#ede9e4] bg-white px-5 py-20 sm:px-8 sm:py-24"
        >
          <div className="mx-auto max-w-[1120px]">
            <div className="mb-10 text-center sm:mb-12">
              <div className="mb-3 text-xs font-bold text-primary">
                三步开始
              </div>
              <h2 className="text-3xl font-bold text-[#1a1a1a] sm:text-4xl">
                从申请到上岗，不到一分钟
              </h2>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {steps.map(step => (
                <article key={step.num} className="claw-home-step">
                  <span>{step.num}</span>
                  <h3>{step.title}</h3>
                  <p>{step.desc}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="claw-home-v2__cta border-b border-[#ede9e4] bg-[#fafaf9] px-5 py-20 text-center sm:px-8 sm:py-24">
          <div className="mx-auto max-w-[720px]">
            <h2 className="text-3xl font-bold text-[#1a1a1a] sm:text-4xl">
              现在，为你的岗位申请一个智能体
            </h2>
            <p className="mt-4 text-sm leading-6 text-[#787671] sm:text-base">
              支持私有化部署、内部工具接入与企业安全策略。
            </p>
            <Button
              size="lg"
              className="mt-8 h-11 px-7"
              onClick={handleBottomCta}
            >
              {hasActiveAdoption
                ? "进入我的工作台"
                : user
                  ? "选择岗位"
                  : "登录开始"}
              <ArrowRight />
            </Button>
          </div>
        </section>
      </main>

      <footer className="bg-white px-5 py-8 sm:px-8">
        <div className="mx-auto flex max-w-[1120px] flex-col items-center justify-between gap-4 text-xs text-[#a4a097] sm:flex-row">
          <span>© 2026 岗位智能体</span>
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => scrollToSection("install")}
              className="hover:text-primary"
            >
              一键安装
            </button>
            <a
              href={brand.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-primary"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
