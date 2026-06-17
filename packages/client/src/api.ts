import type {
  ClientMessage,
  ClientState,
  SikongSettings,
  TaskDetailView,
  TurnResponse,
  TurnStreamEvent,
} from "./types";

const API_BASE = import.meta.env.VITE_SIKONG_API_BASE_URL ?? "";
const REQUEST_TIMEOUT_MS = 30_000;

function requestSignal(init: RequestInit = {}): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (init.signal) return AbortSignal.any([init.signal, timeoutSignal]);
  return timeoutSignal;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    signal: requestSignal(init),
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

export async function getTaskDetail(input: {
  workspaceId?: string;
  taskId: string;
}): Promise<TaskDetailView> {
  const query = new URLSearchParams({ taskId: input.taskId });
  if (input.workspaceId) query.set("workspaceId", input.workspaceId);
  return await request<TaskDetailView>(`/api/task-detail?${query.toString()}`);
}

export async function getSettings(): Promise<
  SikongSettings & { options?: SikongSettings["options"] }
> {
  return await request("/api/settings");
}

export async function getSettingsOptions(): Promise<NonNullable<SikongSettings["options"]>> {
  return await request("/api/settings/options");
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

export async function deleteTranscriptMessage(messageId: string): Promise<ClientMessage[]> {
  return await request<ClientMessage[]>(`/api/transcript/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
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
  onEvent: (event: TurnStreamEvent, eventIndex: number) => void,
  signal?: AbortSignal,
): Promise<TurnResponse> {
  const response = await fetch(`${API_BASE}/api/turn/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: inputSignal(signal),
  });
  return await consumeTurnStream(response, onEvent);
}

export async function resumeTurnStream(
  turnId: string,
  afterIndex: number,
  onEvent: (event: TurnStreamEvent, eventIndex: number) => void,
  signal?: AbortSignal,
): Promise<TurnResponse> {
  const response = await fetch(
    `${API_BASE}/api/turn/${encodeURIComponent(turnId)}/stream?after=${afterIndex}`,
    {
      signal: inputSignal(signal),
    },
  );
  if (response.status === 404) {
    throw new Error("turn is no longer active or resumable");
  }
  return await consumeTurnStream(response, onEvent, afterIndex + 1);
}

async function consumeTurnStream(
  response: Response,
  onEvent: (event: TurnStreamEvent, eventIndex: number) => void,
  startIndex = 0,
): Promise<TurnResponse> {
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
  let eventIndex = startIndex - 1;

  for (;;) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseSseFrame(frame);
      if (!event) continue;
      eventIndex += 1;
      onEvent(event, eventIndex);
      if (event.type === "turn.completed") finalResponse = event.response;
      if (event.type === "turn.error") throw new Error(event.message);
      if (event.type === "turn.cancelled") {
        finalResponse = cancelledTurnResponse(event.reason);
      }
    }
    if (chunk.done) break;
  }

  const trailing = parseSseFrame(buffer);
  if (trailing) {
    eventIndex += 1;
    onEvent(trailing, eventIndex);
    if (trailing.type === "turn.completed") finalResponse = trailing.response;
    if (trailing.type === "turn.error") throw new Error(trailing.message);
    if (trailing.type === "turn.cancelled") {
      finalResponse = cancelledTurnResponse(trailing.reason);
    }
  }
  if (!finalResponse) throw new Error("turn stream ended without a completion event");
  return finalResponse;
}

/** Build a synthetic TurnResponse for a cancelled turn. */
function cancelledTurnResponse(reason: string): TurnResponse {
  return {
    text: "",
    status: "cancelled",
    message: {
      id: crypto.randomUUID(),
      role: "system",
      createdAt: new Date().toISOString(),
      parts: [
        {
          type: "text",
          text: `Turn was ${reason === "timeout" ? "timed out" : "cancelled"}.`,
        },
      ],
    },
    context: {
      policy: {
        transcript: "query_with_tools",
        workspaceState: "authoritative",
        taskEvents: "inspect_on_demand",
        memory: "none",
      },
      focus: {},
      currentMessage: { id: "", text: "", createdAt: "" },
      workspaceIndex: [],
      recentTranscript: [],
    },
  };
}

function inputSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (signal) return AbortSignal.any([signal, timeoutSignal]);
  return timeoutSignal;
}

function parseSseFrame(frame: string): TurnStreamEvent | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
  if (!data) return undefined;
  try {
    return JSON.parse(data) as TurnStreamEvent;
  } catch {
    return {
      type: "turn.error",
      turnId: "unknown",
      segmentId: "unknown",
      message: "Received malformed turn stream data.",
      at: new Date().toISOString(),
    };
  }
}
