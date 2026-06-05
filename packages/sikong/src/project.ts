import type { WorkerPermissionMode } from "./worker";
import type { SandboxConfig } from "./config-file";

export type { SandboxConfig };

/**
 * A Project is the container every task lives under (Task.projectId always
 * references one). It carries per-project isolation config — a working dir, a
 * default workflow, a model/env override — so multiple projects run in parallel
 * with their own context. Projects are deliberately created (like workflows);
 * the builtin `default` makes the zero-config case frictionless.
 */
export interface Project {
  id: string;
  name: string;
  /** Working directory for this project's worker wakes (cwd-aware runtimes use it). */
  root: string;
  /** Default workflow for tasks created in this project without an explicit one. */
  defaultWorkflowId?: string;
  /** Default worker (id) hired for this project's tasks unless a task overrides it. */
  defaultWorker?: string;
  /** Extra environment for this project's workers. */
  env?: Record<string, string>;
  /** Runtime permission posture for this project's wakes, overriding the worker default when set. */
  permissionMode?: WorkerPermissionMode;
  /**
   * Free-form project context loaded from `projects/<id>/memory.md`. This is advisory
   * memory for workers, not workflow state, and is not serialized into the
   * structured project YAML.
   */
  memory?: string;
  /**
   * Sandbox escalation config (ADR 0026). Controls whether and how the worker's
   * bash tool can escalate sandbox-constrained commands (build/test toolchain) to
   * the real host for self-verification. Maps to agent-loop's
   * `SandboxEscalationConfig`.
   */
  sandbox?: SandboxConfig;
}

/** The builtin fallback project — the zero-config default every task gets without `--project`. */
export const DEFAULT_PROJECT: Project = {
  id: "default",
  name: "Default",
  root: ".",
};

/** Project ids become filenames + task projectId tags — keep them safe. */
export function isValidProjectId(id: string): boolean {
  return !!id && id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id);
}
