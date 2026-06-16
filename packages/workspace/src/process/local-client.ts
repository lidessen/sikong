import {
  runProcess,
  validateProcessRunSpec,
  type ProcessRunSnapshot,
  type ProcessRunSpec,
} from "./index";

interface LocalProcessRecord {
  snapshot: ProcessRunSnapshot;
  finished: Promise<ProcessRunSnapshot>;
}

export class LocalProcessExecutionClient {
  private readonly runs = new Map<string, LocalProcessRecord>();

  async startProcess(spec: ProcessRunSpec): Promise<ProcessRunSnapshot> {
    validateProcessRunSpec(spec);
    if (this.runs.has(spec.runId)) {
      throw new Error(`process run ${spec.runId} already exists`);
    }

    const queuedAt = new Date().toISOString();
    const record: LocalProcessRecord = {
      snapshot: {
        runId: spec.runId,
        workspaceId: spec.workspaceId,
        ...(spec.taskId ? { taskId: spec.taskId } : {}),
        state: "queued",
        spec,
        queuedAt,
      },
      finished: Promise.resolve({} as ProcessRunSnapshot),
    };
    record.snapshot = {
      ...record.snapshot,
      state: "running",
      startedAt: new Date().toISOString(),
    };
    record.finished = runProcess(spec)
      .then((result) => {
        record.snapshot = {
          ...record.snapshot,
          state: "finished",
          result,
          finishedAt: result.finishedAt,
        };
        return record.snapshot;
      })
      .catch((err) => {
        record.snapshot = {
          ...record.snapshot,
          state: "finished",
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date().toISOString(),
        };
        return record.snapshot;
      });
    this.runs.set(spec.runId, record);
    return record.snapshot;
  }

  async waitProcessRun(
    runId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<ProcessRunSnapshot> {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`process run ${runId} not found`);
    if (record.snapshot.state === "finished") return record.snapshot;
    if (options.timeoutMs === undefined) return await record.finished;

    const timeout = Symbol("timeout");
    const result = await Promise.race([
      record.finished,
      sleep(options.timeoutMs).then(() => timeout),
    ]);
    if (typeof result === "symbol") return record.snapshot;
    return result;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
