import * as React from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";

type RootProps = React.ComponentProps<typeof RadixSelect.Root>;
type TriggerProps = React.ComponentProps<typeof RadixSelect.Trigger> & {
  size?: "sm" | "default";
  showIcon?: boolean;
};
type ContentProps = React.ComponentProps<typeof RadixSelect.Content>;

const triggerStyle =
  "flex w-fit items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-colors hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50 data-[placeholder]:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-8 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const menuStyle =
  "relative z-50 max-h-[var(--radix-select-content-available-height)] min-w-32 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95";

function Select(props: RootProps) {
  return <RadixSelect.Root {...props} />;
}

function SelectGroup(props: React.ComponentProps<typeof RadixSelect.Group>) {
  return <RadixSelect.Group {...props} />;
}

function SelectValue(props: React.ComponentProps<typeof RadixSelect.Value>) {
  return <RadixSelect.Value {...props} />;
}

function SelectTrigger({
  className,
  children,
  size = "default",
  showIcon = true,
  ...props
}: TriggerProps) {
  return (
    <RadixSelect.Trigger
      {...props}
      data-slot="select-trigger"
      data-size={size}
      className={cn(triggerStyle, className)}
    >
      {children}
      {showIcon ? (
        <RadixSelect.Icon className="ml-auto text-muted-foreground">
          <ChevronDown aria-hidden="true" className="size-4" />
        </RadixSelect.Icon>
      ) : null}
    </RadixSelect.Trigger>
  );
}

type ScrollControlProps = {
  direction: "up" | "down";
  className?: string;
} & Omit<React.ComponentProps<typeof RadixSelect.ScrollUpButton>, "className">;

function SelectScrollControl({
  direction,
  className,
  ...props
}: ScrollControlProps) {
  const Control =
    direction === "up"
      ? RadixSelect.ScrollUpButton
      : RadixSelect.ScrollDownButton;
  const Icon = direction === "up" ? ChevronUp : ChevronDown;

  return (
    <Control
      {...props}
      className={cn(
        "flex h-7 cursor-default items-center justify-center",
        className
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
    </Control>
  );
}

function SelectScrollUpButton(
  props: React.ComponentProps<typeof RadixSelect.ScrollUpButton>
) {
  return <SelectScrollControl direction="up" {...props} />;
}

function SelectScrollDownButton(
  props: React.ComponentProps<typeof RadixSelect.ScrollDownButton>
) {
  return <SelectScrollControl direction="down" {...props} />;
}

function SelectMenuBody({
  children,
  matchTriggerWidth,
}: {
  children: React.ReactNode;
  matchTriggerWidth: boolean;
}) {
  const viewportClass = matchTriggerWidth
    ? "min-w-[var(--radix-select-trigger-width)] scroll-my-1"
    : undefined;
  return (
    <>
      <SelectScrollUpButton />
      <RadixSelect.Viewport className={cn("p-1", viewportClass)}>
        {children}
      </RadixSelect.Viewport>
      <SelectScrollDownButton />
    </>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  align = "center",
  ...props
}: ContentProps) {
  const popper = position === "popper";
  const placementClass = popper
    ? "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1"
    : undefined;
  const contentClass = cn(menuStyle, placementClass, className);

  return (
    <RadixSelect.Portal>
      <RadixSelect.Content
        {...props}
        data-slot="select-content"
        align={align}
        position={position}
        className={contentClass}
      >
        <SelectMenuBody matchTriggerWidth={popper}>{children}</SelectMenuBody>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof RadixSelect.Label>) {
  const labelClass = cn("px-2 py-1.5 text-xs text-muted-foreground", className);
  return React.createElement(RadixSelect.Label, {
    ...props,
    className: labelClass,
  });
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadixSelect.Item>) {
  return (
    <RadixSelect.Item
      {...props}
      data-slot="select-item"
      className={cn(
        "relative flex min-h-8 w-full cursor-default select-none items-center rounded-md py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
        className
      )}
    >
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
      <RadixSelect.ItemIndicator className="select-item-indicator absolute right-2 inline-flex size-4 items-center justify-center">
        <Check aria-hidden="true" className="size-4" />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof RadixSelect.Separator>) {
  return (
    <RadixSelect.Separator
      {...props}
      className={cn("mx-1 my-1 h-px bg-border", className)}
    />
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
