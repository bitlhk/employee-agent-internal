import { useAuth } from "@/_core/hooks/useAuth";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";

export type RouteAccessDecision =
  | { status: "checking" }
  | { status: "granted" }
  | { status: "redirect"; destination: string };

type RouteAccessInput = {
  loading: boolean;
  authenticated: boolean;
  role?: string | null;
  adminOnly: boolean;
  requestedPath: string;
};

export function decideRouteAccess(input: RouteAccessInput): RouteAccessDecision {
  if (input.loading) return { status: "checking" };
  if (!input.authenticated) {
    return {
      status: "redirect",
      destination: `/login?redirect=${encodeURIComponent(input.requestedPath)}`,
    };
  }
  if (input.adminOnly && input.role !== "admin") {
    return { status: "redirect", destination: "/" };
  }
  return { status: "granted" };
}

function RouteAccessPending() {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        <span className="text-muted-foreground">正在验证访问权限...</span>
      </div>
    </div>
  );
}

type AccessGateProps = {
  children: ReactNode;
  requireAdmin?: boolean;
};

export function ProtectedRoute(properties: AccessGateProps) {
  const { user, loading, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const adminOnly = properties.requireAdmin === true;
  const requestedPath = `${window.location.pathname}${window.location.search}`;
  const decision = decideRouteAccess({
    loading,
    authenticated: isAuthenticated,
    role: user?.role,
    adminOnly,
    requestedPath,
  });
  const redirectDestination = decision.status === "redirect" ? decision.destination : null;

  useEffect(() => {
    if (redirectDestination) navigate(redirectDestination);
  }, [navigate, redirectDestination]);

  if (decision.status === "checking") return <RouteAccessPending />;
  if (decision.status === "redirect") return null;
  return <>{properties.children}</>;
}

export function AdminRoute({ children }: { children: ReactNode }) {
  return <ProtectedRoute requireAdmin>{children}</ProtectedRoute>;
}
