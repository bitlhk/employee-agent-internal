import ErrorBoundary from "@/components/ErrorBoundary";
import type { ReactNode } from "react";

type PanelErrorBoundaryProps = {
  children: ReactNode;
  title?: string;
  description?: string;
  resetKey?: string;
};

export function PanelErrorBoundary(props: PanelErrorBoundaryProps) {
  return <ErrorBoundary variant="panel" {...props} />;
}
