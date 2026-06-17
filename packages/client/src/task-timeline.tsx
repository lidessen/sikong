import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { MarkdownMessage } from "./markdown-message";
import { taskRequestPreview } from "./task-request";
import type { ConsoleBadgeVariant } from "./task-labels";
import { formatTime } from "./task-detail-utils";
import type { TaskTraceEntry } from "./types";

const PAGE_SIZE = 20;

const TIMELINE_FILTERS = [
  { id: "all", label: "All" },
  { id: "errors", label: "Errors" },
  { id: "workers", label: "Workers" },
  { id: "plan", label: "Plan" },
  { id: "runtime", label: "Runtime" },
] as const;

type TimelineFilter = (typeof TIMELINE_FILTERS)[number]["id"];

export function TaskTimeline(props: { entries: TaskTraceEntry[] }) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const sorted = useMemo(
    () => [...props.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [props.entries],
  );

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return sorted.filter((entry) => {
      if (filter !== "all" && timelineCategory(entry.type) !== filter) return false;
      if (!normalized) return true;
      const haystack =
        `${traceEventLabel(entry.type)} ${entry.summary} ${entry.type}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [filter, query, sorted]);

  const visible = filtered.slice(0, visibleCount);
  const hiddenCount = filtered.length - visible.length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-7 pl-7 pr-7"
            placeholder="Filter events…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
          />
          {query ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-0.5 top-1/2 size-6 -translate-y-1/2 text-muted-foreground"
              aria-label="Clear filter"
              onClick={() => {
                setQuery("");
                setVisibleCount(PAGE_SIZE);
              }}
            >
              <X className="size-3" />
            </Button>
          ) : null}
        </div>
        <p className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {filtered.length} / {sorted.length}
        </p>
      </div>

      <div className="flex flex-wrap gap-1">
        {TIMELINE_FILTERS.map((item) => (
          <Button
            key={item.id}
            type="button"
            size="sm"
            variant={filter === item.id ? "accent" : "outline"}
            className="h-6 px-2 text-[11px]"
            onClick={() => {
              setFilter(item.id);
              setVisibleCount(PAGE_SIZE);
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-[var(--radius-md)] border border-dashed bg-background p-2.5 text-[12px] text-muted-foreground">
          No timeline events match this filter.
        </p>
      ) : (
        <div className="flex max-h-[520px] flex-col gap-1.5 overflow-auto pr-1">
          {visible.map((entry) => (
            <TimelineEntry key={entry.eventId} entry={entry} />
          ))}
        </div>
      )}

      {hiddenCount > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
        >
          Show {Math.min(hiddenCount, PAGE_SIZE)} more ({hiddenCount} remaining)
        </Button>
      ) : null}
    </div>
  );
}

function TimelineEntry(props: { entry: TaskTraceEntry }) {
  const expandable = isExpandableTimelineSummary(props.entry.summary);
  const preview = taskRequestPreview(props.entry.summary, 120);
  const header = (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant={traceEventBadgeVariant(props.entry.type)}>
        {traceEventLabel(props.entry.type)}
      </Badge>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
        {formatTime(props.entry.createdAt)}
      </span>
    </div>
  );

  if (expandable) {
    return (
      <details className="group rounded-[var(--radius-md)] border bg-background">
        <summary className="cursor-pointer list-none px-2.5 py-2 marker:content-none [&::-webkit-details-marker]:hidden">
          <div className="flex flex-col gap-1.5">
            {header}
            <p className="line-clamp-2 text-[12px] leading-5 text-muted-foreground">{preview}</p>
            <span className="text-[11px] text-primary group-open:hidden">Show full content</span>
          </div>
        </summary>
        <div className="border-t border-border-soft px-2.5 py-2 text-muted-foreground">
          <MarkdownMessage compact text={props.entry.summary} />
        </div>
      </details>
    );
  }

  return (
    <div className="rounded-[var(--radius-md)] border bg-background p-2.5">
      <div className="mb-1.5">{header}</div>
      <div className="text-muted-foreground">
        <MarkdownMessage compact text={props.entry.summary} />
      </div>
    </div>
  );
}

function timelineCategory(type: string): TimelineFilter {
  if (
    type === "task.rejected" ||
    type === "plan.rejected" ||
    type === "stage.review.rejected" ||
    type === "worker_run.failed" ||
    type === "worker_run.budget_exceeded"
  ) {
    return "errors";
  }
  if (type.startsWith("worker_run.")) return "workers";
  if (
    type.startsWith("plan.") ||
    type.startsWith("stage.") ||
    type.startsWith("final.") ||
    type === "task.accepted" ||
    type === "task.completed" ||
    type === "requirement_spec.submitted"
  ) {
    return "plan";
  }
  if (type.startsWith("runtime_process.")) return "runtime";
  return "all";
}

function isExpandableTimelineSummary(summary: string): boolean {
  const trimmed = summary.trim();
  if (!trimmed) return false;
  if (trimmed.length > 220) return true;
  if (trimmed.split(/\r?\n/).length > 3) return true;
  return /^#{1,6}\s/m.test(trimmed);
}

function traceEventLabel(type: string): string {
  switch (type) {
    case "task.created":
      return "Task created";
    case "requirement_spec.submitted":
      return "Requirement spec";
    case "plan.requested":
      return "Plan requested";
    case "plan.submitted":
      return "Plan submitted";
    case "plan.accepted":
      return "Plan accepted";
    case "plan.rejected":
      return "Plan rejected";
    case "runtime_process.started":
      return "Process queued";
    case "runtime_process.running":
      return "Process running";
    case "runtime_process.finished":
      return "Process finished";
    case "stage.started":
      return "Stage started";
    case "stage_round.planned":
      return "Round planned";
    case "stage_round.completed":
      return "Round completed";
    case "worker_run.started":
      return "Worker started";
    case "worker_run.completed":
      return "Worker completed";
    case "worker_run.failed":
      return "Worker failed";
    case "worker_run.budget_exceeded":
      return "Worker budget exceeded";
    case "stage.review.started":
      return "Stage review started";
    case "stage.review.accepted":
      return "Stage accepted";
    case "stage.review.rejected":
      return "Stage rejected";
    case "stage.advanced":
      return "Stage advanced";
    case "final.review.started":
      return "Final review started";
    case "final.review.recommended":
      return "Final review";
    case "task.accepted":
      return "Task accepted";
    case "task.rejected":
      return "Task rejected";
    case "task.completed":
      return "Task completed";
    default:
      return type.replaceAll(".", " · ").replaceAll("_", " ");
  }
}

function traceEventBadgeVariant(type: string): ConsoleBadgeVariant {
  if (type === "task.accepted" || type === "plan.accepted" || type === "stage.review.accepted") {
    return "ok";
  }
  if (
    type === "task.rejected" ||
    type === "plan.rejected" ||
    type === "stage.review.rejected" ||
    type === "worker_run.failed" ||
    type === "worker_run.budget_exceeded"
  ) {
    return "err";
  }
  if (type.startsWith("worker_run.") || type.startsWith("stage_round.")) return "info";
  if (type.startsWith("runtime_process.")) return "neutral";
  if (type.startsWith("plan.") || type.startsWith("final.review")) return "warn";
  return "outline";
}
