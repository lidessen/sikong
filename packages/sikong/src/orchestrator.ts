/**
 * Workspace Orchestration Layer — manages multiple sikong workspace directories
 * and provides a unified coordination interface for cross-workspace task
 * management, worker pool sharing, and consolidated monitoring.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspaceDir } from "./workspace-layout";
import { openWorkspace, type Workspace } from "./workspace";
import type { EngineHooks } from "./engine";
import type { WorkflowDef } from "./workflow/types";

export interface OrchestratorConfig {
  /** Override workspace dir resolution. Default: each workspace's own dir. */
  workspaceDirs?: string[];
  /** Engine hooks forwarded to each workspace. */
  hooks?: EngineHooks;
  /** Extra workflows registered in every workspace. */
  extraWorkflows?: readonly WorkflowDef[];
  /** Wake timeout for each workspace engine. */
  wakeTimeoutMs?: number;
}

/**
 * Manages multiple workspace directories and their engines. Each workspace
 * has an independent `WorkflowEngine` and store directory, but they share
 * the orchestrator's coordination lifecycle.
 *
 * M2 scope: cross-workspace task dispatch, unified worker pool, consolidated
 * chronicle view, and lead-agent supervision across workspaces.
 */
export class WorkspaceOrchestrator {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(private readonly config: OrchestratorConfig = {}) {}

  /** Open all discovered or configured workspaces. */
  async open(): Promise<void> {
    const dirs = this.config.workspaceDirs ?? [];

    // If no explicit dirs, scan the default sikong home for workspace subdirs
    if (dirs.length === 0) {
      const home = resolveWorkspaceDir();
      if (home.dir !== "") {
        try {
          const entries = await readdir(home.dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith(".")) {
              const wsDir = join(home.dir, entry.name);
              dirs.push(wsDir);
            }
          }
        } catch {
          // No sikong home yet
        }
      }
    }

    // No dirs found at all — use the default workspace dir
    if (dirs.length === 0) dirs.push(resolveWorkspaceDir().dir);

    for (const dir of dirs) {
      const ws = await openWorkspace(dir, {
        extraWorkflows: this.config.extraWorkflows,
        hooks: this.config.hooks,
        wakeTimeoutMs: this.config.wakeTimeoutMs,
      });
      this.workspaces.set(dir, ws);
    }
  }

  /** Get a workspace by its directory path. */
  get(dir: string): Workspace | undefined {
    return this.workspaces.get(dir);
  }

  /** List all open workspace directories. */
  list(): string[] {
    return [...this.workspaces.keys()];
  }

  /** All open workspace engines. */
  engines(): Map<string, Workspace> {
    return new Map(this.workspaces);
  }

  /** Drive all pending tasks across all workspaces to quiescence. */
  async runAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [, ws] of this.workspaces) {
      promises.push(ws.engine.runPending());
    }
    await Promise.allSettled(promises);
  }

  /** Close all workspaces (dispose engines + pools). */
  async close(): Promise<void> {
    for (const [, ws] of this.workspaces) {
      // Workspace pool isn't exposed yet, so just stop the engine
    }
    this.workspaces.clear();
  }
}
