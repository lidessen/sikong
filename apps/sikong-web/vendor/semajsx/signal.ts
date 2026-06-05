/**
 * semajsx/signal — reactive primitives (vendored)
 *
 * The heart of SemaJSX. Signals are observable values that notify subscribers
 * on change. All state management builds on these primitives.
 *
 * @module
 */

/** A subscription callback registered via signal.subscribe() */
export type Subscriber<T> = (value: T, oldValue: T) => void

/** The core signal interface */
export interface Signal<T> {
  /** Current value (read / write) */
  value: T
  /** Register a subscriber. Returns an unsubscribe function. */
  subscribe(fn: Subscriber<T>): () => void
}

/**
 * Create a signal with an initial value.
 */
export function signal<T>(initial: T): Signal<T> {
  let value = initial
  const subs = new Set<Subscriber<T>>()
  let _batchQueued = false

  return {
    get value(): T {
      return value
    },
    set value(next: T) {
      if (next !== value) {
        const prev = value
        value = next
        if (batchDepth > 0) {
          if (!_batchQueued) {
            _batchQueued = true
            pendingNotifications.push(() => {
              _batchQueued = false
              subs.forEach((fn) => fn(value, prev))
            })
          }
        } else {
          subs.forEach((fn) => fn(next, prev))
        }
      }
    },
    subscribe(fn: Subscriber<T>): () => void {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
  }
}

/**
 * Create a computed signal from dependencies.
 */
export function computed<T>(deps: Signal<unknown>[], fn: () => T): Signal<T> {
  let dirty = true
  let cache: T

  const compute = () => {
    if (dirty) {
      cache = fn()
      dirty = false
    }
    return cache
  }

  const subs = new Set<Subscriber<T>>()
  const refresh = () => {
    const old = cache
    dirty = true
    const next = fn()
    subs.forEach((sub) => sub(next, old))
  }

  for (const dep of deps) {
    dep.subscribe(refresh)
  }

  return {
    get value(): T {
      return compute()
    },
    set value(_: T) {
      throw new Error("Cannot set value of a computed signal")
    },
    subscribe(fn: Subscriber<T>): () => void {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
  }
}

/**
 * Run a side-effect function whenever dependencies change.
 * Returns a dispose function.
 */
export function effect(
  deps: Signal<unknown>[],
  fn: () => (() => void) | undefined,
): () => void {
  let cleanup: (() => void) | undefined = undefined
  const run = () => {
    if (cleanup) cleanup()
    cleanup = fn()
  }
  const unsubscribes = deps.map((dep) => dep.subscribe(run))
  run()
  return () => {
    unsubscribes.forEach((unsub) => unsub())
    if (cleanup) cleanup()
  }
}

/**
 * Batch multiple signal writes into a single notification cycle.
 */
let batchDepth = 0
const pendingNotifications: Array<() => void> = []

export function batch(fn: () => void): void {
  batchDepth++
  try {
    fn()
  } finally {
    batchDepth--
    if (batchDepth === 0) {
      const copy = pendingNotifications.splice(0)
      copy.forEach((n) => n())
    }
  }
}

export type AsyncState<T> =
  | { pending: true; value?: undefined; error?: undefined }
  | { pending: false; value: T; error?: undefined }
  | { pending: false; value?: undefined; error: Error }

/**
 * Create a signal from a promise, tracking pending / value / error states.
 */
export function when<T>(promise: Promise<T>): Signal<AsyncState<T>> {
  const s = signal<AsyncState<T>>({ pending: true })
  promise
    .then((value) => {
      s.value = { pending: false, value }
    })
    .catch((error: Error) => {
      s.value = { pending: false, error }
    })
  return s
}

/**
 * Create a signal that re-fetches when dependencies change.
 */
export function resource<T>(
  fetcher: () => Promise<T>,
  deps?: Signal<unknown>[],
): Signal<AsyncState<T>> {
  const s = signal<AsyncState<T>>({ pending: true })
  const run: () => (() => void) | undefined = () => {
    s.value = { pending: true }
    fetcher()
      .then((value) => {
        s.value = { pending: false, value }
      })
      .catch((error: Error) => {
        s.value = { pending: false, error }
      })
    return undefined
  }

  if (deps) {
    effect(deps, run)
  } else {
    run()
  }
  return s
}

/**
 * Create a signal from an async iterable (e.g. a stream).
 */
export function stream<T>(source: AsyncIterable<T>): Signal<T | undefined> {
  const s = signal<T | undefined>(undefined)
  ;(async () => {
    for await (const chunk of source) {
      s.value = chunk
    }
  })()
  return s
}
