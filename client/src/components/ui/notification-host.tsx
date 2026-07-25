import { useTheme } from "next-themes";
import { Toaster as SonnerHost, type ToasterProps } from "sonner";

const notificationColors = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
} as React.CSSProperties;

export function Toaster(props: ToasterProps) {
  const { resolvedTheme, theme } = useTheme();
  const activeTheme = resolvedTheme || theme || "system";
  return (
    <SonnerHost
      {...props}
      theme={activeTheme as ToasterProps["theme"]}
      className={cnClassName(props.className)}
      style={{ ...notificationColors, ...props.style }}
    />
  );
}

function cnClassName(className?: string) {
  return ["employee-agent-notifications", className].filter(Boolean).join(" ");
}
