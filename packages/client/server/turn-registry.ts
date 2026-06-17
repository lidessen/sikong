import type { TurnResponse, TurnStreamEvent } from "../src/types";

const turnSessionTtlMs = 5 * 60_000;
const reconnectGraceMs = 60_000;

export type TurnSessionStatus = "running" | "completed" | "cancelled" | "error";

interface TurnSession {
  turnId: string;
  segmentId: string;
  startedAt: string;
  events: TurnStreamEvent[];
  status: TurnSessionStatus;
  response?: TurnResponse;
  errorMessage?: string;
  abortController: AbortController;
  reconnectGraceTimer?: ReturnType<typeof setTimeout>;
  expireTimer?: ReturnType<typeof setTimeout>;
  subscribers: Set<(event: TurnStreamEvent) => void>;
}

const sessions = new Map<string, TurnSession>();

export interface TurnSessionHandle {
  turnId: string;
  segmentId: string;
  startedAt: string;
  abortController: AbortController;
  publish(event: TurnStreamEvent): void;
  complete(response: TurnResponse): void;
  fail(message: string): void;
  cancel(reason: "timeout" | "cancelled"): void;
  attach(subscriber: (event: TurnStreamEvent) => void, afterIndex?: number): () => void;
  subscriberDisconnected(): void;
}

export function createTurnSession(): TurnSessionHandle {
  const turnId = crypto.randomUUID();
  const segmentId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const abortController = new AbortController();

  const session: TurnSession = {
    turnId,
    segmentId,
    startedAt,
    events: [],
    status: "running",
    abortController,
    subscribers: new Set(),
  };
  sessions.set(turnId, session);

  const publish = (event: TurnStreamEvent): void => {
    session.events.push(event);
    for (const subscriber of session.subscribers) {
      subscriber(event);
    }
  };

  const scheduleExpire = (): void => {
    if (session.expireTimer) clearTimeout(session.expireTimer);
    session.expireTimer = setTimeout(() => {
      sessions.delete(turnId);
    }, turnSessionTtlMs);
  };

  const finish = (status: TurnSessionStatus): void => {
    session.status = status;
    scheduleExpire();
  };

  return {
    turnId,
    segmentId,
    startedAt,
    abortController,
    publish,
    complete(response) {
      session.response = response;
      finish("completed");
    },
    fail(message) {
      session.errorMessage = message;
      finish("error");
    },
    cancel(reason) {
      finish("cancelled");
      void reason;
    },
    attach(subscriber, afterIndex = -1) {
      if (session.reconnectGraceTimer) {
        clearTimeout(session.reconnectGraceTimer);
        session.reconnectGraceTimer = undefined;
      }
      const start = Math.max(0, afterIndex + 1);
      for (const event of session.events.slice(start)) {
        subscriber(event);
      }
      if (session.status !== "running") {
        return () => {};
      }
      session.subscribers.add(subscriber);
      return () => {
        session.subscribers.delete(subscriber);
        if (session.subscribers.size === 0 && session.status === "running") {
          session.reconnectGraceTimer = setTimeout(() => {
            if (session.subscribers.size === 0 && session.status === "running") {
              abortController.abort("cancelled");
            }
          }, reconnectGraceMs);
        }
      };
    },
    subscriberDisconnected() {
      if (session.subscribers.size > 0 || session.status !== "running") return;
      session.reconnectGraceTimer = setTimeout(() => {
        if (session.subscribers.size === 0 && session.status === "running") {
          abortController.abort("cancelled");
        }
      }, reconnectGraceMs);
    },
  };
}

export function getTurnSession(turnId: string): TurnSession | undefined {
  return sessions.get(turnId);
}

export function resumeTurnSession(turnId: string): TurnSessionHandle | undefined {
  const session = sessions.get(turnId);
  if (!session) return undefined;
  return {
    turnId: session.turnId,
    segmentId: session.segmentId,
    startedAt: session.startedAt,
    abortController: session.abortController,
    publish(event) {
      session.events.push(event);
      for (const subscriber of session.subscribers) subscriber(event);
    },
    complete(response) {
      session.response = response;
      session.status = "completed";
    },
    fail(message) {
      session.errorMessage = message;
      session.status = "error";
    },
    cancel(reason) {
      session.status = "cancelled";
      void reason;
    },
    attach(subscriber, afterIndex = -1) {
      if (session.reconnectGraceTimer) {
        clearTimeout(session.reconnectGraceTimer);
        session.reconnectGraceTimer = undefined;
      }
      const start = Math.max(0, afterIndex + 1);
      for (const event of session.events.slice(start)) {
        subscriber(event);
      }
      if (session.status !== "running") {
        return () => {};
      }
      session.subscribers.add(subscriber);
      return () => {
        session.subscribers.delete(subscriber);
      };
    },
    subscriberDisconnected() {
      if (session.subscribers.size > 0 || session.status !== "running") return;
      session.reconnectGraceTimer = setTimeout(() => {
        if (session.subscribers.size === 0 && session.status === "running") {
          session.abortController.abort("cancelled");
        }
      }, reconnectGraceMs);
    },
  };
}
