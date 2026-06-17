import { Badge } from "./components/ui/badge";
import type { ClientDiagnostics, SchedulerStatus } from "./types";

export function SystemDiagnosticsBar(props: {
  diagnostics?: ClientDiagnostics;
  scheduler?: SchedulerStatus;
  runtimeError?: string | null;
}) {
  const items = buildDiagnosticItems(props);
  if (items.length === 0 && !props.runtimeError) return null;

  return (
    <div className="mx-auto flex max-w-[840px] flex-wrap gap-1.5 px-4 pb-2">
      {items.map((item) => (
        <Badge key={item.label} variant={item.variant} title={item.detail}>
          {item.label}: {item.value}
        </Badge>
      ))}
      {props.runtimeError ? (
        <Badge variant="destructive" title={props.runtimeError}>
          Turn error
        </Badge>
      ) : null}
    </div>
  );
}

function buildDiagnosticItems(input: {
  diagnostics?: ClientDiagnostics;
  scheduler?: SchedulerStatus;
}): {
  label: string;
  value: string;
  variant: "ok" | "warn" | "err" | "outline";
  detail?: string;
}[] {
  const items: {
    label: string;
    value: string;
    variant: "ok" | "warn" | "err" | "outline";
    detail?: string;
  }[] = [];

  if (input.diagnostics?.clientApi) {
    items.push({
      label: "Client API",
      value: input.diagnostics.clientApi.ok ? "ok" : "error",
      variant: input.diagnostics.clientApi.ok ? "ok" : "err",
      detail: input.diagnostics.clientApi.detail,
    });
  }

  const scheduler = input.scheduler ?? input.diagnostics?.daemon;
  if (scheduler) {
    if (!scheduler.enabled) {
      items.push({
        label: "Daemon",
        value: "unavailable",
        variant: "err",
        detail: scheduler.lastError ?? "Scheduler is not reachable.",
      });
    } else if (scheduler.lastError) {
      items.push({
        label: "Daemon",
        value: "error",
        variant: "err",
        detail: scheduler.lastError,
      });
    } else if (scheduler.paused) {
      items.push({ label: "Daemon", value: "paused", variant: "warn" });
    } else {
      items.push({ label: "Daemon", value: "ok", variant: "ok" });
    }
  }

  if (input.diagnostics?.model) {
    items.push({
      label: "Model",
      value: input.diagnostics.model.ok ? "ready" : "not ready",
      variant: input.diagnostics.model.ok ? "ok" : "warn",
      detail: input.diagnostics.model.detail,
    });
  }

  return items;
}

export function classifyTurnError(message: string): string {
  if (message.includes("Client agent backend") || message.includes("preflight")) {
    return `Model/runtime: ${message}`;
  }
  if (message.includes("Scheduler") || message.includes("daemon")) {
    return `Daemon: ${message}`;
  }
  if (message.toLowerCase().includes("fetch") || message.includes("network")) {
    return `Client API: ${message}`;
  }
  return message;
}
