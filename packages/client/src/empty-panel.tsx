import type React from "react";

export function EmptyPanel(props: {
  title: string;
  description: string;
  icon?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[var(--radius-lg)] border border-dashed bg-card/55 ${props.compact ? "p-3" : "p-4"} ${props.className ?? ""}`}
    >
      {props.icon ? (
        <div
          className={`mb-3 flex ${props.className?.includes("text-center") ? "mx-auto" : ""} size-8 items-center justify-center rounded-[var(--radius-lg)] border bg-background text-primary`}
        >
          {props.icon}
        </div>
      ) : null}
      <p className="text-sm font-semibold tracking-[-0.01em]">{props.title}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.description}</p>
    </div>
  );
}
