import type { FieldCmp, Guard, TaskStatus } from "./types";

/** The slice of state a guard is evaluated against. */
export interface GuardEnv {
  /** The task's current projected fields. */
  fields: Readonly<Record<string, unknown>>;
  /** Event TYPES present in the task's CURRENT stage (scoped by the caller). */
  eventTypes: ReadonlySet<string>;
  /** Statuses of this task's children (for `childrenDone`). */
  children: readonly TaskStatus[];
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "cancelled"]);

/**
 * Evaluate a declarative guard. Pure and total — never throws, never calls an
 * LLM. Unknown/odd comparisons resolve to `false` rather than erroring, so a
 * malformed guard simply fails to admit (fail-closed).
 */
export function evalGuard(guard: Guard, env: GuardEnv): boolean {
  switch (guard.op) {
    case "always":
      return true;
    case "never":
      return false;
    case "field":
      return compare(env.fields[guard.field], guard.cmp, guard.value);
    case "hasEvent":
      return env.eventTypes.has(guard.eventType);
    case "childrenDone":
      // All children reached an END STATE — done OR cancelled. Vacuously true
      // with zero children (no child contradicts "all are done"). A cancelled/failed
      // child still SATISFIES this; gate on `childrenSucceeded` if a failed subtask
      // must not advance the parent.
      return env.children.every((s) => TERMINAL.has(s));
    case "childrenSucceeded":
      // Stricter join: every child finished SUCCESSFULLY (done); a cancelled child
      // makes this false. Vacuously true with zero children.
      return env.children.every((s) => s === "done");
    case "and":
      return guard.all.every((g) => evalGuard(g, env));
    case "or":
      return guard.any.some((g) => evalGuard(g, env));
    case "not":
      return !evalGuard(guard.guard, env);
  }
}

function compare(actual: unknown, cmp: FieldCmp, value: unknown): boolean {
  switch (cmp) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "eq":
      return actual === value;
    case "ne":
      return actual !== value;
    case "in":
      return Array.isArray(value) && value.includes(actual);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof actual !== "number" || typeof value !== "number") return false;
      return cmp === "gt"
        ? actual > value
        : cmp === "gte"
          ? actual >= value
          : cmp === "lt"
            ? actual < value
            : actual <= value;
    }
  }
}
