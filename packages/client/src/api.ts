import type { ClientState, TurnResponse } from "./types";

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
