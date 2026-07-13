import { cn } from "@/lib/utils";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export function isDynamicImportError(error: Error | null): boolean {
  if (!error) return false;
  const detail = `${error.name || ""} ${error.message || ""}`;
  return /ChunkLoadError|Loading chunk .* failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(detail);
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      const dynamicImportFailed = isDynamicImportError(this.state.error);
      return (
        <div className="flex items-center justify-center min-h-screen p-8 bg-background">
          <div className="flex flex-col items-center w-full max-w-2xl p-8">
            <AlertTriangle
              size={48}
              className="text-destructive mb-6 flex-shrink-0"
            />

            <h2 className="text-xl mb-2">{dynamicImportFailed ? "页面资源加载失败" : "页面暂时无法显示"}</h2>
            <p className="mb-6 text-sm text-muted-foreground">
              {dynamicImportFailed ? "网络中断或版本更新可能导致资源加载失败，刷新后即可重新获取。" : "请重试；如果问题持续存在，请刷新页面。"}
            </p>

            {import.meta.env.DEV ? <div className="p-4 w-full rounded bg-muted overflow-auto mb-6">
              <pre className="text-sm text-muted-foreground whitespace-break-spaces">
                {this.state.error?.stack}
              </pre>
            </div> : null}

            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => {
                  if (dynamicImportFailed) window.location.reload();
                  else this.setState({ hasError: false, error: null });
                }}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg",
                  "bg-primary text-primary-foreground",
                  "hover:opacity-90 cursor-pointer"
                )}
              >
                {dynamicImportFailed ? <RefreshCw size={16} /> : <RotateCcw size={16} />}
                {dynamicImportFailed ? "刷新页面" : "重试"}
              </button>
              {!dynamicImportFailed ? <button
                onClick={() => window.location.reload()}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg",
                  "border border-border bg-background text-foreground",
                  "hover:bg-muted cursor-pointer"
                )}
              >
                <RefreshCw size={16} />
                刷新页面
              </button> : null}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
