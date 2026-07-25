import { cn } from "@/lib/utils";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { Component, type ReactNode } from "react";

type BoundaryVariant = "page" | "panel";

type ErrorBoundaryProps = {
  children: ReactNode;
  variant?: BoundaryVariant;
  title?: string;
  description?: string;
  resetKey?: string;
};

type ErrorBoundaryState = {
  failure: Error | null;
};

export function isDynamicImportError(error: Error | null): boolean {
  if (!error) return false;
  const detail = `${error.name || ""} ${error.message || ""}`;
  return /ChunkLoadError|Loading chunk .* failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(detail);
}

function PanelFailureIcon() {
  return (
    <div className="panel-error-boundary__icon">
      <AlertTriangle size={18} aria-hidden="true" />
    </div>
  );
}

function PanelFailureDetails({ failure }: { failure: Error }) {
  return (
    <details className="panel-error-boundary__details">
      <summary>错误详情</summary>
      <pre>{failure.stack || failure.message || "unknown error"}</pre>
    </details>
  );
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failure: null };

  static getDerivedStateFromError(failure: Error): ErrorBoundaryState {
    return { failure };
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.failure && previous.resetKey !== this.props.resetKey) {
      this.setState({ failure: null });
    }
  }

  private retry = () => this.setState({ failure: null });

  private renderPanelFailure(failure: Error) {
    const heading = this.props.title || "当前页面暂时不可用";
    const guidance = this.props.description || "组件渲染时出现异常，其他工作台区域不受影响。可以重试当前页面，或切换到其他功能。";
    return (
      <div className="panel-error-boundary">
        <div className="panel-error-boundary__card">
          <PanelFailureIcon />
          <div className="panel-error-boundary__body">
            <h2>{heading}</h2>
            <p>{guidance}</p>
            <PanelFailureDetails failure={failure} />
            <button type="button" className="panel-error-boundary__action" onClick={this.retry}>
              <RotateCcw size={14} aria-hidden="true" />
              重试当前页面
            </button>
          </div>
        </div>
      </div>
    );
  }

  private renderPageFailure(failure: Error) {
    const reloadRequired = isDynamicImportError(failure);
    const primaryAction = reloadRequired ? () => window.location.reload() : this.retry;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-8">
        <div className="flex w-full max-w-2xl flex-col items-center p-8">
          <AlertTriangle size={48} className="mb-6 flex-shrink-0 text-destructive" aria-hidden="true" />
          <h2 className="mb-2 text-xl">{reloadRequired ? "页面资源加载失败" : "页面暂时无法显示"}</h2>
          <p className="mb-6 text-sm text-muted-foreground">
            {reloadRequired ? "网络中断或版本更新可能导致资源加载失败，刷新后即可重新获取。" : "请重试；如果问题持续存在，请刷新页面。"}
          </p>
          {import.meta.env.DEV ? (
            <div className="mb-6 w-full overflow-auto rounded bg-muted p-4">
              <pre className="whitespace-break-spaces text-sm text-muted-foreground">{failure.stack}</pre>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={primaryAction}
              className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-4 py-2", "bg-primary text-primary-foreground hover:opacity-90")}
            >
              {reloadRequired ? <RefreshCw size={16} /> : <RotateCcw size={16} />}
              {reloadRequired ? "刷新页面" : "重试"}
            </button>
            {!reloadRequired ? (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-4 py-2", "border border-border bg-background text-foreground hover:bg-muted")}
              >
                <RefreshCw size={16} />
                刷新页面
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  render() {
    const failure = this.state.failure;
    if (!failure) return this.props.children;
    return this.props.variant === "panel"
      ? this.renderPanelFailure(failure)
      : this.renderPageFailure(failure);
  }
}

export default ErrorBoundary;
