import type { CSSProperties } from "react";

// Match the workbench/coop palette when these shared panels are embedded.
export const schedulingTheme = {
  "--background": "var(--oc-bg, #ffffff)",
  "--foreground": "var(--oc-text-primary, #111827)",
  "--card": "var(--oc-bg-surface, #ffffff)",
  "--card-foreground": "var(--oc-text-primary, #111827)",
  "--muted": "var(--oc-bg-soft, #f3f4f6)",
  "--muted-foreground": "var(--oc-text-secondary, #6b7280)",
  "--border": "var(--oc-border, #e5e7eb)",
  "--input": "var(--oc-border, #e5e7eb)",
  "--primary": "var(--oc-accent, #e11d48)",
  "--primary-foreground": "var(--oc-text-on-accent, #ffffff)",
} as CSSProperties;
