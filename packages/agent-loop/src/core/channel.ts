/**
 * A single-producer / single-consumer async event channel.
 *
 * Backends push events as they arrive; the consumer drains them via the async
 * iterator. Buffered (no backpressure) so a slow consumer never blocks the
 * backend's stream — events queue until read.
 */
export interface EventChannel<T> {
  /** Enqueue an event. No-op once the channel has ended. */
  push(event: T): void;
  /** Signal normal completion. The iterator returns after draining the queue. */
  end(): void;
  /** Signal failure. The iterator throws after draining the queue. */
  fail(err: Error): void;
  /** The async-iterable side. Iterate exactly once. */
  readonly iterable: AsyncIterable<T>;
}

export function createEventChannel<T>(): EventChannel<T> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;

  const wakeUp = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  return {
    push(event: T) {
      if (done) return;
      queue.push(event);
      wakeUp();
    },
    end() {
      if (done) return;
      done = true;
      wakeUp();
    },
    fail(err: Error) {
      if (done) return;
      failure = err;
      done = true;
      wakeUp();
    },
    iterable: {
      async *[Symbol.asyncIterator](): AsyncIterator<T> {
        while (true) {
          while (queue.length > 0) {
            yield queue.shift() as T;
          }
          if (done) {
            if (failure) throw failure;
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}
