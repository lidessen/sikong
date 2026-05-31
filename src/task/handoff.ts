/**
 * Handoff: the structured baton passed between rounds of a long task. When one
 * run can't finish (context exhausted, step budget hit), it records a handoff;
 * the next fresh agent reads the accumulated handoffs as its entire starting
 * context. This is what makes a task survive across many independent runs.
 */
export interface Handoff {
  /** 1-based round that produced this handoff. */
  round: number;
  /** What this round accomplished. */
  progress: string;
  /** Concrete next steps for the next agent. */
  nextSteps: string;
  /** Unresolved questions / decisions the next agent should be aware of. */
  openQuestions?: string;
  /** References to durable outputs produced this round (files, ids, URLs). */
  artifacts?: string[];
  /**
   * true if the model called `task_handoff` itself; false if the supervisor
   * forced a handoff because the run ended without calling an exit tool.
   */
  voluntary: boolean;
}

/**
 * Persistence for handoffs across runs (and across process restarts, enabling
 * resume). `load` returns [] when nothing is stored yet.
 */
export interface HandoffStore {
  load(): Promise<Handoff[]>;
  save(handoffs: Handoff[]): Promise<void>;
}

/** In-memory store (default). Lives only for the duration of the task call. */
export function memoryStore(initial: Handoff[] = []): HandoffStore {
  let state = [...initial];
  return {
    load: () => Promise.resolve([...state]),
    save: (handoffs) => {
      state = [...handoffs];
      return Promise.resolve();
    },
  };
}

/**
 * JSON-file store: persists handoffs to `path` so a crashed/stopped task can be
 * resumed by calling `runTask` again with the same store. Missing file = [].
 */
export function fileStore(path: string): HandoffStore {
  return {
    async load() {
      try {
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(path, "utf-8");
        const parsed = JSON.parse(raw) as { handoffs?: Handoff[] };
        return Array.isArray(parsed.handoffs) ? parsed.handoffs : [];
      } catch {
        return []; // missing/corrupt → start fresh
      }
    },
    async save(handoffs) {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(path), { recursive: true }).catch(() => {});
      await writeFile(path, JSON.stringify({ handoffs }, null, 2));
    },
  };
}

/** Render accumulated handoffs as the "progress so far" briefing for a new agent. */
export function renderHandoffs(handoffs: Handoff[]): string {
  return handoffs
    .map((h) => {
      const lines = [`### Round ${h.round}`, `Progress: ${h.progress}`, `Next steps: ${h.nextSteps}`];
      if (h.openQuestions) lines.push(`Open questions: ${h.openQuestions}`);
      if (h.artifacts?.length) lines.push(`Artifacts: ${h.artifacts.join(", ")}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
