import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Redirect } from "wouter";
import { lazy, Suspense, useEffect } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import { AdminRoute } from "./components/ProtectedRoute";
import { Loader2 } from "lucide-react";
import { loadSettings, applySettings } from "./lib/settings";

// 路由懒加载
const Home = lazy(() => import("./pages/Home"));
const ClawHome = lazy(() => import("./pages/ClawHome"));
const ClawAdmin = lazy(() => import("./pages/ClawAdmin"));
const CoopSession = lazy(() => import("./pages/CoopSession"));
const CoopNew = lazy(() => import("./pages/CoopNew"));
const Login = lazy(() => import("./pages/Login"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const NotFound = lazy(() => import("./pages/NotFound"));

// 加载中组件
const LoadingFallback = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="flex flex-col items-center gap-4">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
      <p className="text-muted-foreground">加载中...</p>
    </div>
  </div>
);

function Router() {
  // Apply persisted UI settings on boot without forcing a theme mode.
  useEffect(() => {
    loadSettings();
    applySettings({});
  }, []);

  return (
    <Suspense fallback={<LoadingFallback />}>
      <Switch>
        {/* ── 首页 ── */}
        <Route path={"/"}>
          <ClawHome />
        </Route>

        {/* ── 管理控制台 ── */}
        <Route path={"/admin"}>
          <AdminRoute>
            <ClawAdmin />
          </AdminRoute>
        </Route>
        <Route path={"/claw-admin"}>
          <Redirect to="/admin" />
        </Route>

        {/* ── 智能体工作台 ── */}
        <Route path={"/claw/:adoptId"}>
          <Home />
        </Route>

        {/* ── 协作 session 窗口（V2）── */}
        <Route path={"/coop/new"}>
          <CoopNew />
        </Route>
        <Route path={"/coop/:sessionId"}>
          <CoopSession />
        </Route>

        {/* /scenarios 重定向到首页 */}
        <Route path={"/scenarios"}>
          <Redirect to="/" />
        </Route>
        <Route path={"/login"}>
          <Login />
        </Route>
        <Route path={"/reset-password"}>
          <ResetPassword />
        </Route>
        <Route path={"/404"}>
          <NotFound />
        </Route>
        <Route>
          <NotFound />
        </Route>
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
