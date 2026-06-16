import type React from "react";
import { Badge } from "./components/ui/badge";

export function DetailSection(props: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius-lg)] border bg-card/92 p-3">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] border bg-background text-primary">
            {props.icon}
          </span>
          <h3 className="truncate text-[13px] font-semibold">{props.title}</h3>
        </div>
        {props.count !== undefined ? <Badge variant="outline">{props.count}</Badge> : null}
      </div>
      {props.children}
    </section>
  );
}

export function EmptyInline(props: { text: string }) {
  return (
    <p className="rounded-[var(--radius-md)] border border-dashed bg-background p-2.5 text-[12px] text-muted-foreground">
      {props.text}
    </p>
  );
}

export function Metric(props: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border bg-background p-2">
      <dt className="mb-1 flex items-center gap-1 text-muted-foreground">
        {props.icon}
        {props.label}
      </dt>
      <dd className="font-medium">{props.value}</dd>
    </div>
  );
}

export function FactRow(props: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-2 text-xs">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="truncate text-foreground">{props.value}</span>
    </div>
  );
}
