import * as ConfirmPrimitive from "@radix-ui/react-alert-dialog";
import type { ComponentProps } from "react";
import { buttonVariants } from "@/components/ui/action-button";
import { cn } from "@/lib/utils";

export const AlertDialog = ConfirmPrimitive.Root;
export const AlertDialogTrigger = ConfirmPrimitive.Trigger;
export const AlertDialogPortal = ConfirmPrimitive.Portal;

export function AlertDialogOverlay({ className, ...rest }: ComponentProps<typeof ConfirmPrimitive.Overlay>) {
  return (
    <ConfirmPrimitive.Overlay
      data-ui="confirmation-backdrop"
      className={cn(
        "fixed inset-0 z-[110] bg-black/50",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...rest}
    />
  );
}

export function AlertDialogContent({ className, children, ...rest }: ComponentProps<typeof ConfirmPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <ConfirmPrimitive.Content
        data-ui="confirmation-dialog"
        className={cn(
          "fixed left-1/2 top-1/2 z-[111] grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4",
          "rounded-lg border bg-background p-6 shadow-lg sm:max-w-lg",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...rest}
      >
        {children}
      </ConfirmPrimitive.Content>
    </AlertDialogPortal>
  );
}

export function AlertDialogHeader({ className, ...rest }: ComponentProps<"div">) {
  return <div data-ui="confirmation-header" className={cn("flex flex-col gap-2 text-center sm:text-left", className)} {...rest} />;
}

export function AlertDialogFooter({ className, ...rest }: ComponentProps<"div">) {
  return <div data-ui="confirmation-actions" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...rest} />;
}

export function AlertDialogTitle({ className, ...rest }: ComponentProps<typeof ConfirmPrimitive.Title>) {
  return <ConfirmPrimitive.Title className={cn("text-lg font-semibold", className)} {...rest} />;
}

export function AlertDialogDescription({ className, ...rest }: ComponentProps<typeof ConfirmPrimitive.Description>) {
  return <ConfirmPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...rest} />;
}

export function AlertDialogAction({ className, ...rest }: ComponentProps<typeof ConfirmPrimitive.Action>) {
  return <ConfirmPrimitive.Action className={buttonVariants({ className })} {...rest} />;
}

export function AlertDialogCancel({ className, ...rest }: ComponentProps<typeof ConfirmPrimitive.Cancel>) {
  return <ConfirmPrimitive.Cancel className={buttonVariants({ variant: "outline", className })} {...rest} />;
}
