import { WorkflowValidationError } from "./errors";
import type { AcceptanceCheck, Guard, StageCategory, StageDef, WorkflowDef } from "./types";

export interface ValidationIssue {
  code: string;
  message: string;
  stageId?: string;
  field?: string;
  /** Context label for issues that aren't tied to a stage (e.g. create_subtask acceptance). */
  context?: string;
}

/** Optional registries to resolve stage skill/tool references against (M3). */
export interface ValidateOptions {
  knownTools?: ReadonlySet<string>;
  knownSkills?: ReadonlySet<string>;
}

/**
 * Structural, deterministic validation of a workflow definition. This is the
 * gate every (incl. agent-authored) workflow must pass before registration —
 * possible *because* guards are data, not code. Returns all issues; empty = ok.
 */
export function validateWorkflow(def: WorkflowDef, opts: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (code: string, message: string, extra?: Partial<ValidationIssue>) =>
    issues.push({ code, message, ...extra });

  // Defend the top-level shape first — an agent/JSON-authored def can be missing
  // keys entirely; we want structured issues, not a raw TypeError.
  if (typeof def !== "object" || def === null) return [{ code: "not-an-object", message: "workflow is not an object" }];

  if (!def.id?.trim()) push("missing-id", "workflow id is empty");
  if (!def.version?.trim()) push("missing-version", "workflow version is empty");
  if (!def.name?.trim()) push("missing-name", "workflow name is empty");

  const shape = def as { fields?: unknown; stages?: unknown };
  const hasFields = !!shape.fields && typeof shape.fields === "object";
  if (!hasFields) push("missing-fields", "workflow has no fields object");
  if (!Array.isArray(shape.stages)) {
    push("missing-stages", "workflow has no stages array");
    return issues; // can't validate stages
  }

  // Fields
  if (hasFields)
    for (const [name, fd] of Object.entries(def.fields)) {
      if (fd?.type === "enum" && (!fd.enum || fd.enum.length === 0))
        push("enum-without-values", `enum field "${name}" has no allowed values`, { field: name });
    }

  // maxTeamDepth: if set, must be a positive integer (>= 1). 0 would block all
  // delegation — if you want no delegation just omit the field.
  if (def.maxTeamDepth !== undefined) {
    if (!Number.isInteger(def.maxTeamDepth) || def.maxTeamDepth < 1)
      push("invalid-max-team-depth", `maxTeamDepth must be a positive integer (>= 1), got ${JSON.stringify(def.maxTeamDepth)}`);
  }

  // Stages
  if (def.stages.length === 0) {
    push("no-stages", "workflow has no stages");
    return issues; // nothing else is meaningful
  }

  const validCategory = (c: string): c is StageCategory =>
    c === "todo" || c === "in_progress" || c === "done";

  const seen = new Set<string>();
  def.stages.forEach((stage, idx) => {
    if (!stage.id?.trim()) push("stage-missing-id", "a stage has an empty id");
    else if (seen.has(stage.id))
      push("duplicate-stage-id", `duplicate stage id "${stage.id}"`, { stageId: stage.id });
    else seen.add(stage.id);

    // The registration gate exists to defend against JSON/agent-authored defs
    // that bypass the compile-time category type.
    if (!validCategory(stage.category))
      push("invalid-category", `stage "${stage.id}" has invalid category "${stage.category}"`, {
        stageId: stage.id,
      });

    // In the linear M0 model a 'done' stage is terminal — nothing may follow it,
    // else `complete`-by-stage could fire before the real end.
    if (stage.category === "done" && idx !== def.stages.length - 1)
      push("done-stage-not-terminal", `stage "${stage.id}" is 'done' but is not the last stage`, {
        stageId: stage.id,
      });
  });

  if (!def.stages.some((s) => s.category === "done"))
    push("no-terminal-stage", "workflow has no stage with category 'done' (it can never finish)");

  // The initial stage is entered unconditionally at creation, so its entry guard
  // is ignored: require `always` and forbid a workflow that starts already done.
  const initial = def.stages[0];
  if (initial) {
    if (initial.category === "done")
      push("initial-stage-done", `initial stage "${initial.id}" is 'done' (a task would finish with no work)`, {
        stageId: initial.id,
      });
    if (initial.entry.op !== "always")
      push(
        "initial-stage-guarded",
        `initial stage "${initial.id}" entry must be { op: "always" } (it is ignored at creation)`,
        { stageId: initial.id },
      );
  }

  // Cross-stage: a stage with `acceptancePassed` in its entry requires the
  // PREVIOUS stage to define acceptance criteria for lead review.
  def.stages.forEach((stage, idx) => {
    if (idx > 0 && guardContainsAcceptancePassed(stage.entry)) {
      const prev = def.stages[idx - 1];
      if (!prev || !prev.acceptance?.length)
        push(
          "missing-acceptance-checks",
          `stage "${stage.id}" uses acceptancePassed guard but preceding stage "${prev?.id ?? "(none)"}" has no acceptance criteria`,
          { stageId: stage.id },
        );
    }
  });

  // Guards + reachability + ref resolution
  def.stages.forEach((stage, idx) => {
    validateGuard(stage.entry, def, stage, push);

    // A non-initial stage gated by `never` can never be entered.
    if (idx > 0 && isUnsatisfiable(stage.entry))
      push("unreachable-stage", `stage "${stage.id}" has an unsatisfiable entry guard`, {
        stageId: stage.id,
      });

    if (opts.knownTools)
      for (const t of stage.tools ?? [])
        if (!opts.knownTools.has(t))
          push("unknown-tool", `stage "${stage.id}" references unregistered tool "${t}"`, {
            stageId: stage.id,
          });
    if (opts.knownSkills)
      for (const sk of stage.skills ?? [])
        if (!opts.knownSkills.has(sk))
          push("unknown-skill", `stage "${stage.id}" references unregistered skill "${sk}"`, {
            stageId: stage.id,
          });
    for (const field of stage.outputFields ?? [])
      if (!def.fields[field])
        push("unknown-output-field", `stage "${stage.id}" references unknown output field "${field}"`, {
          stageId: stage.id,
          field,
        });
    for (const check of stage.acceptance ?? []) validateAcceptanceCheck(check, stage, def, push);
  });

  return issues;
}

/** Throw `WorkflowValidationError` if the workflow has any issues. */
export function assertValidWorkflow(def: WorkflowDef, opts?: ValidateOptions): void {
  const issues = validateWorkflow(def, opts);
  if (issues.length > 0) throw new WorkflowValidationError(def.id, issues);
}

function validateGuard(
  guard: Guard,
  def: WorkflowDef,
  stage: StageDef,
  push: (code: string, message: string, extra?: Partial<ValidationIssue>) => void,
): void {
  switch (guard.op) {
    case "always":
    case "never":
    case "hasEvent":
    case "childrenDone":
    case "childrenSucceeded":
    case "acceptancePassed":
      return;
    case "field": {
      if (!def.fields[guard.field])
        push("guard-unknown-field", `stage "${stage.id}" guard references undeclared field "${guard.field}"`, {
          stageId: stage.id,
          field: guard.field,
        });
      if (guard.cmp === "in" && !Array.isArray(guard.value))
        push("guard-in-needs-array", `stage "${stage.id}" guard "in" on "${guard.field}" needs an array value`, {
          stageId: stage.id,
          field: guard.field,
        });
      return;
    }
    case "and":
      if (guard.all.length === 0)
        push("empty-guard", `stage "${stage.id}" has an empty 'and' guard`, { stageId: stage.id });
      guard.all.forEach((g) => validateGuard(g, def, stage, push));
      return;
    case "or":
      if (guard.any.length === 0)
        push("empty-guard", `stage "${stage.id}" has an empty 'or' guard`, { stageId: stage.id });
      guard.any.forEach((g) => validateGuard(g, def, stage, push));
      return;
    case "not":
      validateGuard(guard.guard, def, stage, push);
      return;
  }
}

/** Conservative: only flags guards that are *statically* always false. */
function isUnsatisfiable(guard: Guard): boolean {
  switch (guard.op) {
    case "never":
      return true;
    case "and":
      return guard.all.some(isUnsatisfiable);
    case "or":
      return guard.any.length > 0 && guard.any.every(isUnsatisfiable);
    case "not":
      return guard.guard.op === "always";
    default:
      return false;
  }
}

/** Whether a guard expression (or any nested sub-guard) contains `acceptancePassed`. */
function guardContainsAcceptancePassed(guard: Guard): boolean {
  switch (guard.op) {
    case "acceptancePassed":
      return true;
    case "and":
      return guard.all.some(guardContainsAcceptancePassed);
    case "or":
      return guard.any.some(guardContainsAcceptancePassed);
    case "not":
      return guardContainsAcceptancePassed(guard.guard);
    default:
      return false;
  }
}

/** Validate a single acceptance check for structural correctness. */
function validateAcceptanceCheck(
  check: AcceptanceCheck,
  stage: StageDef,
  def: WorkflowDef,
  push: (code: string, message: string, extra?: Partial<ValidationIssue>) => void,
): void {
  const stageId = stage.id;
  switch (check.kind) {
    case "command":
      if (!check.cmd?.trim())
        push("acceptance-command-without-cmd", `stage "${stageId}" has a command acceptance check with no cmd`, {
          stageId,
        });
      if (check.expectExit !== undefined && (typeof check.expectExit !== "number" || !Number.isInteger(check.expectExit)))
        push("acceptance-invalid-exit-code", `stage "${stageId}" command check has non-integer expectExit`, { stageId });
      return;
    case "fileExists":
      if (!check.path?.trim())
        push("acceptance-without-path", `stage "${stageId}" has a fileExists acceptance check with no path`, {
          stageId,
        });
      return;
    case "grep":
      if (!check.path?.trim())
        push("acceptance-without-path", `stage "${stageId}" has a grep acceptance check with no path`, { stageId });
      if (!check.pattern?.trim())
        push("acceptance-grep-without-pattern", `stage "${stageId}" has a grep acceptance check with no pattern`, {
          stageId,
        });
      if (typeof check.expectMatch !== "boolean")
        push("acceptance-grep-without-expect", `stage "${stageId}" grep acceptance check must specify expectMatch`, {
          stageId,
        });
      return;
    case "projectGate":
      // projectGate needs only a description — no further validation at M0.
      return;
    default:
      push(
        "invalid-acceptance-kind",
        `stage "${stageId}" has an acceptance check with unknown kind "${(check as AcceptanceCheck & { kind: string }).kind}"`,
        { stageId },
      );
  }
}

/**
 * Validate acceptance checks from a create_subtask command (ADR 0027). Reuses
 * the same structural validation as stage acceptance, but with a context label
 * (e.g. "create_subtask") instead of a stage id. Returns all issues; empty = ok.
 */
export function validateAcceptanceChecks(
  acceptance: readonly AcceptanceCheck[] | undefined,
  context?: string,
): ValidationIssue[] {
  if (!acceptance?.length) return [];
  const issues: ValidationIssue[] = [];
  const push = (code: string, message: string, extra?: Partial<ValidationIssue>) =>
    issues.push({ code, message, ...(context ? { context } : {}), ...extra });
  for (const check of acceptance) {
    // Wrap in a minimal fake stage just to reuse the existing validator.
    validateAcceptanceCheck(check, { id: context ?? "subtask", category: "in_progress", entry: { op: "always" } }, { id: "", version: "", name: "", description: "", fields: {}, stages: [] }, push);
  }
  return issues;
}
