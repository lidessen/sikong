import type { ClientMessage, ClientState, SikongSettings, TurnResponse } from "./types";

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
