import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import type React from "react";
import { Badge } from "./components/ui/badge";

export function DetailSection(props: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const hasContent = props.count === undefined || props.count > 0;
  const [open, setOpen] = useState(props.defaultOpen ?? hasContent);

  if (!hasContent) {
    return (
      <section className="rounded-[var(--radius-lg)] border border-dashed border-border-soft bg-card/45 p-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border-soft bg-background/60 opacity-60">
            {props.icon}
          </span>
          <h3 className="truncate text-[13px] font-medium">{props.title}</h3>
          <Badge variant="outline" className="ml-auto">
            0
          </Badge>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-[var(--radius-lg)] border bg-card/92">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left outline-none transition-colors hover:bg-hover/40 focus-visible:bg-hover/40"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] border bg-background text-primary">
          {props.icon}
        </span>
        <h3 className="min-w-0 truncate text-[13px] font-semibold">{props.title}</h3>
        {props.count !== undefined ? (
          <Badge variant="outline" className="ml-auto shrink-0">
            {props.count}
          </Badge>
        ) : null}
      </button>
      {open ? <div className="border-t border-divider px-3 pb-3 pt-2">{props.children}</div> : null}
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
    <div className="rounded-[var(--radius-md)] border bg-background p-2 transition-colors hover:border-border-strong">
      <dt className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
        {props.icon}
        {props.label}
      </dt>
      <dd className="truncate text-[12px] font-medium leading-5">{props.value}</dd>
    </div>
  );
}

export function FactRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-2 text-xs">
      <span className="text-muted-foreground">{props.label}</span>
      <span className={`truncate text-foreground ${props.mono ? "font-mono text-[11px]" : ""}`}>
        {props.value}
      </span>
    </div>
  );
}

export function CollapsibleMarkdown(props: {
  title: string;
  text: string;
  previewLines?: number;
  children: ReactNode;
}) {
  const lines = props.text.trim().split(/\r?\n/);
  const long = props.text.length > 480 || lines.length > (props.previewLines ?? 6);
  if (!long) {
    return (
      <div className="rounded-[var(--radius-md)] border border-border-soft bg-background/70 p-3">
        {props.title ? (
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {props.title}
          </p>
        ) : null}
        {props.children}
      </div>
    );
  }

  return (
    <details className="group rounded-[var(--radius-md)] border border-border-soft bg-background/70">
      <summary className="cursor-pointer list-none px-3 py-2.5 marker:content-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
            <span className="truncate text-[13px] font-medium">{props.title}</span>
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground group-open:hidden">
            Show full request
          </span>
        </div>
        <p className="mt-2 line-clamp-3 text-[12px] leading-5 text-muted-foreground group-open:hidden">
          {lines.slice(0, 3).join(" ")}
        </p>
      </summary>
      <div className="border-t border-border-soft px-3 py-3">{props.children}</div>
    </details>
  );
}
