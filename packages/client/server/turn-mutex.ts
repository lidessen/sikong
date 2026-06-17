let turnChain: Promise<void> = Promise.resolve();

export function withTurnMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = turnChain.then(fn, fn);
  turnChain = run.then(
    () => {},
    () => {},
  );
  return run;
}
