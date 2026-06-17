const ACTIVE_TURN_KEY = "sikong.active-turn";

export interface ActiveTurnState {
  turnId: string;
  messageId: string;
  startedAt: string;
  lastEventIndex: number;
}

export function readActiveTurnState(): ActiveTurnState | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_TURN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveTurnState;
    if (!parsed.turnId || !parsed.messageId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeActiveTurnState(state: ActiveTurnState): void {
  sessionStorage.setItem(ACTIVE_TURN_KEY, JSON.stringify(state));
}

export function clearActiveTurnState(): void {
  sessionStorage.removeItem(ACTIVE_TURN_KEY);
}
