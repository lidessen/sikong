import type * as React from "react";
import { cn } from "../../lib/utils";

export function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-7 w-full rounded-[var(--radius-md)] border border-input bg-bg-elev px-2 py-1 text-[13px] outline-none transition-[background-color,border-color,color] placeholder:text-[var(--fg-4)] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:border-ring",
        className,
      )}
      {...props}
    />
  );
}
