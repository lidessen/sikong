import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex h-[18px] w-fit shrink-0 items-center rounded-[var(--radius-sm)] border px-1.5 text-[10px] font-medium whitespace-nowrap tabular-nums",
  {
    variants: {
      variant: {
        default: "border-border-strong bg-muted text-foreground",
        secondary: "border-border-soft bg-surface-2 text-muted-foreground",
        outline: "border-border bg-transparent text-muted-foreground",
        destructive:
          "border-[color-mix(in_srgb,var(--err)_35%,transparent)] bg-[var(--err-soft)] text-err",
        ok: "border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-[var(--ok-soft)] text-ok",
        warn: "border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[var(--warn-soft)] text-warn",
        err: "border-[color-mix(in_srgb,var(--err)_35%,transparent)] bg-[var(--err-soft)] text-err",
        info: "border-[color-mix(in_srgb,var(--info)_35%,transparent)] bg-[var(--info-soft)] text-info",
        neutral: "border-border bg-muted text-neutral",
        accent:
          "border-[color-mix(in_srgb,var(--accent)_38%,transparent)] bg-[var(--accent-soft)] text-primary",
      },
    },
    defaultVariants: {
      variant: "secondary",
    },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}
