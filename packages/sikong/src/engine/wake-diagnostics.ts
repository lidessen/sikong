import type { LoopEvent, RunResult } from "agent-loop";
import type { Command } from "../workflow/types";
import type { WakeTimeoutEstimate } from "./adaptive-timeout";
import type { ToolCallFact } from "./prompt";
import { closesCurrentRun } from "./wake-signals";

const DIAGNOSTIC_TEXT_LIMIT = 800;
const TOOL_FACT_LIMIT = 40;
const TOOL_PREVIEW_LIMIT = 600;

export interface RunDiagnostics {
  phase: "worker" | "commit";
  eventCount: number;
  toolCallStarts: Record<string, number>;
  toolCallEnds: Record<string, number>;
  toolCallErrors: Record<string, number>;
  textChars: number;
  textPreview: string;
  toolCallFacts: ToolCallFact[];
}

type RunDiagnosticStatus = RunResult["status"] | "closed_by_state_command";

export function createRunDiagnostics(phase: RunDiagnostics["phase"]): RunDiagnostics {
  return {
    phase,
    eventCount: 0,
    toolCallStarts: {},
    toolCallEnds: {},
    toolCallErrors: {},
    textChars: 0,
    textPreview: "",
    toolCallFacts: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function appendPreview(existing: string, text: string, limit = DIAGNOSTIC_TEXT_LIMIT): string {
  if (existing.length >= limit) return existing;
  const remaining = limit - existing.length;
  return existing + text.slice(0, remaining);
}

export function compactPreview(
  text: string,
  limit = DIAGNOSTIC_TEXT_LIMIT,
): { preview?: string; chars: number; truncated: boolean } {
  const compact = text.trim();
  if (!compact) return { chars: text.length, truncated: false };
  return {
    preview: compact.slice(0, limit),
    chars: text.length,
    truncated: compact.length > limit,
  };
}

export function timeoutData(timeout: WakeTimeoutEstimate): Record<string, unknown> {
  return {
    timeoutMs: timeout.timeoutMs,
    rawMs: timeout.rawMs,
    minMs: timeout.minMs,
    maxMs: timeout.maxMs,
    effort: timeout.effort,
    components: timeout.components,
  };
}

function sensitiveFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("authorization") ||
    normalized.includes("apikey") ||
    normalized.includes("credential")
  );
}

function sanitizePreviewValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[max-depth]";
  if (typeof value === "string") return value.length > 1_000 ? `${value.slice(0, 1_000)}...` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    const out = value.slice(0, 20).map((item) => sanitizePreviewValue(item, depth + 1));
    if (value.length > 20) out.push(`[truncated ${value.length - 20} items]`);
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, 30);
    for (const [key, entryValue] of entries) {
      out[key] = sensitiveFieldName(key) ? "[redacted]" : sanitizePreviewValue(entryValue, depth + 1);
    }
    if (Object.keys(value).length > entries.length) out["[truncated]"] = `${Object.keys(value).length - entries.length} fields`;
    return out;
  }
  if (value === undefined) return undefined;
  return String(value);
}

function compactValuePreview(value: unknown, limit = TOOL_PREVIEW_LIMIT): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(sanitizePreviewValue(value));
  } catch {
    text = String(value);
  }
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function rememberToolFact(diagnostics: RunDiagnostics, fact: ToolCallFact): void {
  if (diagnostics.toolCallFacts.length >= TOOL_FACT_LIMIT) return;
  diagnostics.toolCallFacts.push(fact);
}

export function observeLoopEvent(diagnostics: RunDiagnostics, event: LoopEvent): void {
  diagnostics.eventCount++;
  switch (event.type) {
    case "text":
      diagnostics.textChars += event.text.length;
      diagnostics.textPreview = appendPreview(diagnostics.textPreview, event.text);
      break;
    case "tool_call_start":
      incrementCount(diagnostics.toolCallStarts, event.name);
      rememberToolFact(diagnostics, {
        tool: event.name,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(compactValuePreview(event.args) ? { argsPreview: compactValuePreview(event.args) } : {}),
      });
      break;
    case "tool_call_end":
      incrementCount(diagnostics.toolCallEnds, event.name);
      if (event.error) incrementCount(diagnostics.toolCallErrors, event.name);
      rememberToolFact(diagnostics, {
        tool: event.name,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(compactValuePreview(event.result) ? { resultPreview: compactValuePreview(event.result) } : {}),
        ...(event.error ? { error: event.error } : {}),
      });
      break;
  }
}

export function runDiagnosticStatus(result: RunResult, commands: readonly Command[]): RunDiagnosticStatus {
  if (result.status === "cancelled" && commands.some(closesCurrentRun)) return "closed_by_state_command";
  return result.status;
}

export function finalizeRunDiagnostics(
  diagnostics: RunDiagnostics,
  result: RunResult,
  commands: readonly Command[] = [],
): Record<string, unknown> {
  const text = result.text || diagnostics.textPreview;
  const preview = compactPreview(text);
  const status = runDiagnosticStatus(result, commands);
  const closeCommandKinds = commands.filter(closesCurrentRun).map((command) => command.kind);
  return {
    phase: diagnostics.phase,
    status,
    ...(status !== result.status ? { runtimeStatus: result.status } : {}),
    ...(closeCommandKinds.length ? { closeCommandKinds } : {}),
    eventCount: diagnostics.eventCount,
    toolCallStarts: diagnostics.toolCallStarts,
    toolCallEnds: diagnostics.toolCallEnds,
    toolCallErrors: diagnostics.toolCallErrors,
    textChars: result.text ? result.text.length : diagnostics.textChars,
    ...(preview.preview ? { textPreview: preview.preview, textTruncated: preview.truncated } : {}),
    ...(diagnostics.toolCallFacts.length ? { toolCallFacts: diagnostics.toolCallFacts } : {}),
    ...(result.status === "error" ? { error: result.error?.message ?? "unknown error" } : {}),
  };
}

export function toolCountsSummary(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}:${count}`);
  return parts.length ? parts.join(", ") : "none";
}

export function progressSummary(event: LoopEvent): string | null {
  switch (event.type) {
    case "tool_call_start":
      return `tool ${event.name} started`;
    case "tool_call_end":
      return event.error ? `tool ${event.name} failed` : `tool ${event.name} ended`;
    default:
      return null;
  }
}

export function progressData(phase: RunDiagnostics["phase"], event: LoopEvent): Record<string, unknown> | null {
  switch (event.type) {
    case "tool_call_start":
      return {
        phase,
        event: event.type,
        tool: event.name,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(compactValuePreview(event.args) ? { argsPreview: compactValuePreview(event.args) } : {}),
      };
    case "tool_call_end":
      return {
        phase,
        event: event.type,
        tool: event.name,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
        ...(compactValuePreview(event.result) ? { resultPreview: compactValuePreview(event.result) } : {}),
        ...(event.error ? { error: event.error } : {}),
      };
    default:
      return null;
  }
}
