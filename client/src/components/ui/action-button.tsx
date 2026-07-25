import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
type ButtonSize = "default" | "sm" | "lg" | "icon" | "icon-sm" | "icon-lg";

const appearance: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  destructive: "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
  outline: "border bg-transparent shadow-xs hover:bg-[var(--oc-bg-hover)] hover:text-[var(--oc-text-primary)] dark:border-input dark:bg-transparent",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-[var(--oc-bg-hover)] hover:text-[var(--oc-text-primary)]",
  link: "text-primary underline-offset-4 hover:underline",
};

const dimensions: Record<ButtonSize, string> = {
  default: "h-9 px-4 py-2 has-[>svg]:px-3",
  sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
  lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
  icon: "size-9",
  "icon-sm": "size-8",
  "icon-lg": "size-10",
};

const sharedButtonClasses = [
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md",
  "text-sm font-medium outline-none transition-colors",
  "disabled:pointer-events-none disabled:opacity-50",
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
  "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
].join(" ");

export type ButtonStyleOptions = {
  variant?: ButtonVariant | null;
  size?: ButtonSize | null;
  className?: string;
};

export function buttonVariants(options: ButtonStyleOptions = {}): string {
  const variant = options.variant || "default";
  const size = options.size || "default";
  return cn(sharedButtonClasses, appearance[variant], dimensions[size], options.className);
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & ButtonStyleOptions & {
  asChild?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function ActionButton(
  { asChild = false, className, variant, size, ...elementProps },
  ref,
) {
  const Element = asChild ? Slot : "button";
  return (
    <Element
      ref={ref}
      data-ui="action-button"
      className={buttonVariants({ variant, size, className })}
      {...elementProps}
    />
  );
});
