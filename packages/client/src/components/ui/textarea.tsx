import type * as React from "react";
import { cn } from "../../lib/utils";

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex min-h-14 w-full resize-none rounded-[var(--radius-md)] border border-input bg-bg-elev px-2 py-1.5 text-[13px] leading-5 shadow-none outline-none transition-[background-color,border-color,color] placeholder:text-[var(--fg-4)] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:border-ring",
        className,
      )}
      {...props}
    />
  );
}
