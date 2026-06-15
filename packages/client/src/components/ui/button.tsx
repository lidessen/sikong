import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex h-[26px] shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-transparent px-2 text-[13px] font-medium outline-none transition-[background-color,border-color,color,box-shadow,transform] active:translate-y-px disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-45 focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-offset-1 focus-visible:outline-ring",
  {
    variants: {
      variant: {
        default:
          "border-border-strong bg-surface-2 text-foreground hover:border-border-strong hover:bg-muted-2",
        primary:
          "border-transparent bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--primary)_88%,white)]",
        accent:
          "border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[var(--accent-soft)] text-primary hover:bg-[var(--accent-dim)]",
        destructive:
          "border-[color-mix(in_srgb,var(--err)_40%,transparent)] bg-[var(--err-soft)] text-err hover:bg-[color-mix(in_srgb,var(--err-soft)_70%,var(--err)_18%)]",
        outline:
          "border-input bg-surface text-foreground hover:border-border-strong hover:bg-hover",
        secondary: "border-border-soft bg-muted text-secondary-foreground hover:bg-muted-2",
        ghost: "border-transparent text-muted-foreground hover:bg-hover hover:text-foreground",
      },
      size: {
        default: "h-[26px] px-2",
        sm: "h-[22px] rounded-[var(--radius-sm)] px-1.5 text-[12px]",
        lg: "h-7 rounded-[var(--radius-md)] px-2.5",
        icon: "size-[26px] p-0",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
