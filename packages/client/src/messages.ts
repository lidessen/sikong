import type { ClientMessage, ClientMessageRole, MessagePart, TurnResponse } from "./types";

export function createClientMessage(input: {
  role: ClientMessageRole;
  parts: MessagePart[];
  id?: string;
  createdAt?: string;
}): ClientMessage {
  return {
    id: input.id ?? crypto.randomUUID(),
    role: input.role,
    createdAt: input.createdAt ?? new Date().toISOString(),
    parts: input.parts,
  };
}

export function createTextMessage(role: ClientMessageRole, text: string): ClientMessage {
  return createClientMessage({
    role,
    parts: [{ type: "text", text }],
  });
}

export function createPendingMessage(): ClientMessage {
  return {
    ...createTextMessage("assistant", "Sikong is working..."),
    pending: true,
  };
}

export function messageFromTurnResponse(response: TurnResponse): ClientMessage {
  if (response.message) return response.message;
  return createTextMessage(
    "assistant",
    response.text || `Turn finished with status ${response.status}.`,
  );
}
