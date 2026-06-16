import type { ProcessRunSnapshot, ProcessRunSpec } from "./types";

export type DaemonProcessFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DaemonProcessClientOptions {
  baseUrl: string;
  fetch?: DaemonProcessFetch;
}

export class DaemonProcessClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DaemonProcessClientError";
    this.status = status;
    this.code = code;
  }
}

export class DaemonProcessClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: DaemonProcessFetch;

  constructor(options: DaemonProcessClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async health(): Promise<{ ok: boolean }> {
    return this.readJson(this.request("/health"));
  }

  async shutdown(): Promise<{ ok: boolean }> {
    return this.readJson(
      this.request("/shutdown", {
        method: "POST",
      }),
    );
  }

  async schedulerStatus(): Promise<{
    enabled: boolean;
    paused: boolean;
    active: number;
    maxConcurrent: number;
    lastScanAt?: string;
    lastTickAt?: string;
    lastError?: string;
    started: number;
    completed: number;
    runnableSeen: number;
    activeTasks?: string[];
    processTimeoutMs: number;
    waitTimeoutMs: number;
  }> {
    return this.readJson(this.request("/scheduler/status"));
  }

  async wakeScheduler(): Promise<unknown> {
    return this.readJson(
      this.request("/scheduler/wake", {
        method: "POST",
      }),
    );
  }

  async listProcessRuns(
    options: {
      workspaceId?: string;
      taskId?: string;
      state?: ProcessRunSnapshot["state"];
      limit?: number;
    } = {},
  ): Promise<{ runs: ProcessRunSnapshot[] }> {
    const search = new URLSearchParams();
    if (options.workspaceId) search.set("workspaceId", options.workspaceId);
    if (options.taskId) search.set("taskId", options.taskId);
    if (options.state) search.set("state", options.state);
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.readJson(this.request(`/process-runs${suffix}`));
  }

  async startProcess(spec: ProcessRunSpec): Promise<ProcessRunSnapshot> {
    return this.readJson(
      this.request("/process-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(spec),
      }),
    );
  }

  async getProcessRun(runId: string): Promise<ProcessRunSnapshot> {
    return this.readJson(this.request(`/process-runs/${encodeURIComponent(runId)}`));
  }

  async waitProcessRun(
    runId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<ProcessRunSnapshot> {
    const search = new URLSearchParams();
    if (options.timeoutMs !== undefined) {
      search.set("timeoutMs", String(options.timeoutMs));
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.readJson(this.request(`/process-runs/${encodeURIComponent(runId)}/wait${suffix}`));
  }

  async cancelProcessRun(runId: string): Promise<ProcessRunSnapshot> {
    return this.readJson(
      this.request(`/process-runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      }),
    );
  }

  private request(path: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, init);
  }

  private async readJson<T>(responsePromise: Promise<Response>): Promise<T> {
    const response = await responsePromise;
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      throw toDaemonProcessClientError(response.status, data);
    }
    return data as T;
  }
}

function toDaemonProcessClientError(status: number, data: unknown): DaemonProcessClientError {
  const fallback = "daemon process request failed";
  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    data.error &&
    typeof data.error === "object"
  ) {
    const error = data.error as { code?: unknown; message?: unknown };
    return new DaemonProcessClientError(
      status,
      typeof error.code === "string" ? error.code : "daemon_error",
      typeof error.message === "string" ? error.message : fallback,
    );
  }
  return new DaemonProcessClientError(status, "daemon_error", fallback);
}
