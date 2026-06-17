import { Gauge } from "lucide-react";
import { MarkdownMessage } from "./markdown-message";
import { formatTime } from "./task-detail-utils";
import type { WorkerRunObservation } from "./types";

export type ObservationDisplayItem =
  | { kind: "single"; observation: WorkerRunObservation }
  | { kind: "usage_group"; id: string; observations: WorkerRunObservation[] };

export function groupObservationsForDisplay(
  observations: WorkerRunObservation[],
): ObservationDisplayItem[] {
  const items: ObservationDisplayItem[] = [];
  let usageBatch: WorkerRunObservation[] = [];

  function flushUsage() {
    if (usageBatch.length === 0) return;
    items.push({
      kind: "usage_group",
      id: `usage_${usageBatch.map((item) => item.id).join("_")}`,
      observations: usageBatch,
    });
    usageBatch = [];
  }

  for (const observation of observations) {
    if (observation.kind === "usage") {
      usageBatch.push(observation);
      continue;
    }
    flushUsage();
    items.push({ kind: "single", observation });
  }
  flushUsage();
  return items;
}

export function formatToolName(name?: string): string {
  if (!name) return "tool";
  const stripped = name.replace(/^mcp__[^_]+__/, "").replace(/^mcp__/, "");
  return stripped || name;
}

export function ObservationView(props: { observation: WorkerRunObservation }) {
  const { observation } = props;

  if (observation.kind === "usage") {
    return null;
  }

  if (observation.kind === "tool_call") {
    return <ToolCallBody observation={observation} />;
  }

  if (observation.kind === "round_end") {
    return <RoundEndBody summary={observation.summary} />;
  }

  if (observation.kind === "step") {
    return <p className="text-[12px] leading-5 text-muted-foreground">{observation.summary}</p>;
  }

  return <ObservationMarkdown text={observation.summary} />;
}

export function UsageObservationGroup(props: { observations: WorkerRunObservation[] }) {
  const snapshots = props.observations.map((observation) => ({
    id: observation.id,
    at: observation.at,
    total: observation.usage?.totalTokens ?? parseTokensFromSummary(observation.summary) ?? 0,
    input: observation.usage?.inputTokens,
    output: observation.usage?.outputTokens,
  }));
  const totalTokens = snapshots.reduce((sum, item) => sum + item.total, 0);
  const latest = snapshots[0];
  const earliest = snapshots.at(-1);
  const multi = snapshots.length > 1;

  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-dashed border-border-soft bg-background/35 px-2 py-1.5">
      <Gauge className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            {multi ? `${snapshots.length} token snapshots` : "Token usage"}
          </span>
          <span className="font-mono text-[12px] font-medium tabular-nums text-foreground">
            {formatTokenCount(totalTokens)}
            {multi ? " total" : ""}
          </span>
        </div>
        {multi ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {snapshots.map((snapshot) => (
              <span
                key={snapshot.id}
                className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-muted/80 px-1.5 py-px font-mono text-[10px] tabular-nums text-muted-foreground"
                title={formatTime(snapshot.at)}
              >
                {formatTokenCount(snapshot.total)}
                {snapshot.input !== undefined && snapshot.output !== undefined ? (
                  <span className="text-[9px] opacity-75">
                    {formatTokenCount(snapshot.input)} in · {formatTokenCount(snapshot.output)} out
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        ) : latest && latest.input !== undefined && latest.output !== undefined ? (
          <p className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
            {formatTokenCount(latest.input)} in · {formatTokenCount(latest.output)} out
          </p>
        ) : null}
      </div>
      <span
        className="shrink-0 font-mono text-[10px] leading-4 text-muted-foreground tabular-nums"
        title={
          earliest && latest && earliest.at !== latest.at
            ? `${formatTime(earliest.at)} – ${formatTime(latest.at)}`
            : undefined
        }
      >
        {latest ? formatTime(latest.at) : null}
        {multi && earliest && latest && earliest.at !== latest.at ? (
          <>
            <br />
            {formatTime(earliest.at)}
          </>
        ) : null}
      </span>
    </div>
  );
}

function ToolCallBody(props: { observation: WorkerRunObservation }) {
  const args = parseJsonRecord(props.observation.argsSummary);
  const result = parseJsonRecord(props.observation.resultSummary);
  const reportFromArgs = stringField(args, "report") ?? extractReportFromBrokenJson(props.observation.argsSummary);
  const showSummary = !isRedundantToolSummary(props.observation.summary, props.observation.toolName);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {showSummary ? (
        <p className="text-[12px] leading-5 text-muted-foreground">{props.observation.summary}</p>
      ) : null}

      {props.observation.status === "started" ? (
        <>
          {reportFromArgs ? (
            <div className="rounded-[var(--radius-sm)] border border-border-soft bg-background/60 px-2 py-1.5">
              <MarkdownMessage compact text={reportFromArgs} />
            </div>
          ) : null}
          {args ? (
            <JsonFields
              record={args}
              omit={reportFromArgs ? new Set(["report"]) : undefined}
              label="Arguments"
            />
          ) : props.observation.argsSummary ? (
            <RawPayload label="Arguments" text={props.observation.argsSummary} />
          ) : null}
        </>
      ) : null}

      {props.observation.status !== "started" ? (
        <>
          {result ? (
            <JsonFields record={result} label="Result" />
          ) : props.observation.resultSummary ? (
            looksLikeMarkdown(props.observation.resultSummary) ? (
              <ObservationMarkdown text={props.observation.resultSummary} />
            ) : (
              <RawPayload label="Result" text={props.observation.resultSummary} />
            )
          ) : null}
          {props.observation.durationMs !== undefined ? (
            <p className="text-[11px] text-muted-foreground">
              Duration {formatDurationMs(props.observation.durationMs)}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function RoundEndBody(props: { summary: string }) {
  const split = splitRoundEndSummary(props.summary);
  if (!split) {
    return <ObservationMarkdown text={props.summary} />;
  }
  return (
    <div className="min-w-0">
      <p className="text-[12px] font-medium leading-5 text-foreground">{split.lead}</p>
      <div className="mt-1.5 text-muted-foreground">
        <MarkdownMessage compact text={split.report} />
      </div>
    </div>
  );
}

function ObservationMarkdown(props: { text: string }) {
  if (!props.text.trim()) return null;
  if (looksLikeMarkdown(props.text)) {
    return (
      <div className="min-w-0 text-muted-foreground">
        <MarkdownMessage compact text={props.text} />
      </div>
    );
  }
  return <p className="text-[12px] leading-5 text-foreground/90">{props.text}</p>;
}

function JsonFields(props: {
  record: Record<string, unknown>;
  label: string;
  omit?: Set<string>;
}) {
  const entries = Object.entries(props.record).filter(([key]) => !props.omit?.has(key));
  if (entries.length === 0) return null;
  return (
    <details className="group rounded-[var(--radius-sm)] border border-border-soft bg-background/50">
      <summary className="cursor-pointer px-2 py-1.5 text-[11px] text-muted-foreground marker:text-muted-foreground hover:text-foreground">
        {props.label}
        <span className="ml-1 text-primary group-open:hidden">({entries.length} fields)</span>
      </summary>
      <dl className="space-y-1 border-t border-border-soft px-2 py-1.5 text-[11px]">
        {entries.map(([key, value]) => (
          <div key={key} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
            <dt className="truncate text-muted-foreground">{key}</dt>
            <dd className="break-words font-mono leading-4 text-foreground/90">
              {formatJsonValue(value)}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function RawPayload(props: { label: string; text: string }) {
  const expandable = props.text.length > 160;
  if (!expandable) {
    return (
      <p className="break-words font-mono text-[11px] leading-4 text-muted-foreground">
        <span className="text-foreground/70">{props.label}: </span>
        {props.text}
      </p>
    );
  }
  return (
    <details className="group rounded-[var(--radius-sm)] border border-border-soft bg-background/50">
      <summary className="cursor-pointer px-2 py-1.5 text-[11px] text-muted-foreground">
        {props.label}
        <span className="ml-1 text-primary group-open:hidden">Show payload</span>
      </summary>
      <pre className="max-h-48 overflow-auto border-t border-border-soft px-2 py-1.5 font-mono text-[11px] leading-4 text-muted-foreground">
        {props.text}
      </pre>
    </details>
  );
}

function splitRoundEndSummary(summary: string): { lead: string; report: string } | null {
  const match = summary.match(/^(Round \d+ \w+ ended\.)\s+([\s\S]+)$/);
  if (!match) return null;
  const report = match[2]?.trim();
  const lead = match[1];
  if (!report || !lead) return null;
  return { lead, report };
}

function isRedundantToolSummary(summary: string, toolName?: string): boolean {
  if (!toolName) return false;
  const normalized = summary.trim().toLowerCase();
  const name = toolName.toLowerCase();
  return (
    normalized === `${name} started.` ||
    normalized === `${name} completed.` ||
    normalized === `${name} failed.`
  );
}

function parseJsonRecord(text?: string): Record<string, unknown> | undefined {
  if (!text?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Truncated or non-JSON payloads fall back to raw display.
  }
  return undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractReportFromBrokenJson(text?: string): string | undefined {
  if (!text) return undefined;
  const match = text.match(/"report"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
}

function looksLikeMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > 180 && trimmed.includes(". ")) return true;
  if (/^#{1,6}\s/m.test(trimmed)) return true;
  if (/^\s*[-*]\s/m.test(trimmed)) return true;
  if (/\*\*[^*]+\*\*/.test(trimmed)) return true;
  if (/`[^`]+`/.test(trimmed)) return true;
  if (trimmed.split(/\r?\n/).length > 2) return true;
  return false;
}

function formatJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function parseTokensFromSummary(summary: string): number | undefined {
  const match = summary.match(/([\d,]+)\s+tokens?\s+used/i);
  if (!match?.[1]) return undefined;
  const value = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(value) ? value : undefined;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString();
}
