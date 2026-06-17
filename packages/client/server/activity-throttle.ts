import type { ClientTurnActivity } from "../src/types";

export interface ActivityThrottle {
  emit(activity: ClientTurnActivity): void;
  flush(): void;
}

export function createActivityThrottle(
  onEmit: (activity: ClientTurnActivity) => void,
  minIntervalMs = 150,
): ActivityThrottle {
  let lastAt = 0;
  let pending: ClientTurnActivity | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flushPending = (): void => {
    if (!pending) return;
    onEmit(pending);
    pending = undefined;
    lastAt = Date.now();
  };

  return {
    emit(activity) {
      pending = activity;
      const elapsed = Date.now() - lastAt;
      if (elapsed >= minIntervalMs) {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        flushPending();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        flushPending();
      }, minIntervalMs - elapsed);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      flushPending();
    },
  };
}
