import type {
  ClientMessage,
  ClientState,
  SikongSettings,
  TurnResponse,
  TurnStreamEvent,
} from "./types";

const API_BASE = import.meta.env.VITE_SIKONG_API_BASE_URL ?? "";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String(body.message)
        : response.statusText;
    throw new Error(message);
  }
  return body as T;
}

export async function getClientState(workspaceId?: string): Promise<ClientState> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return await request<ClientState>(`/api/state${query}`);
}

export async function updateSettings(settings: SikongSettings): Promise<SikongSettings> {
  return await request<SikongSettings>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function getTranscript(): Promise<ClientMessage[]> {
  return await request<ClientMessage[]>("/api/transcript");
}

export async function submitPlanDecision(input: {
  workspaceId: string;
  taskId: string;
  planId: string;
  version: number;
  decision: "accept" | "reject";
}): Promise<unknown> {
  return await request<unknown>("/api/tasks/plan-decision", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function driveTask(input: { workspaceId: string; taskId: string }): Promise<unknown> {
  return await request<unknown>("/api/tasks/drive", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function runTurn(input: {
  message: string;
  workspaceId?: string;
  taskId?: string;
}): Promise<TurnResponse> {
  return await request<TurnResponse>("/api/turn", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function runTurnStream(
  input: {
    message: string;
    workspaceId?: string;
    taskId?: string;
  },
  onEvent: (event: TurnStreamEvent) => void,
): Promise<TurnResponse> {
  const response = await fetch(`${API_BASE}/api/turn/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body && typeof body === "object" && "message" in body
        ? String(body.message)
        : response.statusText;
    throw new Error(message);
  }
  if (!response.body) throw new Error("turn stream response body is missing");

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let finalResponse: TurnResponse | undefined;

  for (;;) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseSseFrame(frame);
      if (!event) continue;
      onEvent(event);
      if (event.type === "turn.completed") finalResponse = event.response;
      if (event.type === "turn.error") throw new Error(event.message);
    }
    if (chunk.done) break;
  }

  const trailing = parseSseFrame(buffer);
  if (trailing) {
    onEvent(trailing);
    if (trailing.type === "turn.completed") finalResponse = trailing.response;
    if (trailing.type === "turn.error") throw new Error(trailing.message);
  }
  if (!finalResponse) throw new Error("turn stream ended without a completion event");
  return finalResponse;
}

function parseSseFrame(frame: string): TurnStreamEvent | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
  if (!data) return undefined;
  return JSON.parse(data) as TurnStreamEvent;
}
