import * as DrawerPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Sheet = DrawerPrimitive.Root;
export const SheetTrigger = DrawerPrimitive.Trigger;
export const SheetClose = DrawerPrimitive.Close;
export const SheetPortal = DrawerPrimitive.Portal;

export const SheetOverlay = forwardRef<
  ElementRef<typeof DrawerPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Overlay>
>(function DrawerBackdrop({ className, ...rest }, ref) {
  return (
    <DrawerPrimitive.Overlay
      ref={ref}
      data-ui="drawer-backdrop"
      className={cn(
        "fixed inset-0 z-50 bg-black/50",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...rest}
    />
  );
});

type DrawerSide = "top" | "right" | "bottom" | "left";

const drawerPlacement: Record<DrawerSide, string> = {
  top: "inset-x-0 top-0 border-b data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top",
  right: "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
  bottom: "inset-x-0 bottom-0 border-t data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
  left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
};

type SheetContentProps = ComponentPropsWithoutRef<typeof DrawerPrimitive.Content> & {
  side?: DrawerSide;
};

export const SheetContent = forwardRef<
  ElementRef<typeof DrawerPrimitive.Content>,
  SheetContentProps
>(function DrawerPanel({ side = "right", className, children, ...rest }, ref) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DrawerPrimitive.Content
        ref={ref}
        data-ui="drawer-panel"
        className={cn(
          "fixed z-50 gap-4 bg-background p-6 shadow-lg outline-none",
          "transition data-[state=open]:animate-in data-[state=open]:duration-500",
          "data-[state=closed]:animate-out data-[state=closed]:duration-300",
          drawerPlacement[side],
          className,
        )}
        {...rest}
      >
        {children}
        <DrawerPrimitive.Close
          className="absolute right-4 top-4 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-[var(--oc-bg-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">关闭</span>
        </DrawerPrimitive.Close>
      </DrawerPrimitive.Content>
    </SheetPortal>
  );
});

export function SheetHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-ui="drawer-header" className={cn("flex flex-col space-y-2 text-center sm:text-left", className)} {...rest} />;
}

export function SheetFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-ui="drawer-footer" className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...rest} />;
}

export const SheetTitle = forwardRef<
  ElementRef<typeof DrawerPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Title>
>(function DrawerTitle({ className, ...rest }, ref) {
  return <DrawerPrimitive.Title ref={ref} className={cn("text-lg font-semibold text-foreground", className)} {...rest} />;
});

export const SheetDescription = forwardRef<
  ElementRef<typeof DrawerPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Description>
>(function DrawerDescription({ className, ...rest }, ref) {
  return <DrawerPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...rest} />;
});
