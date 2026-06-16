import { configFile, ensureDataDirLayout, readYamlFile, writeYamlFile } from "../data-dir";

export type DefaultAgentRuntimeKey = "clientAgent" | "lead" | "worker";

export interface DefaultAgentRuntime {
  backend: string;
  provider?: string;
  model?: string;
}

export interface SikongSettings {
  version: 1;
  defaults: Record<DefaultAgentRuntimeKey, DefaultAgentRuntime>;
}

export interface SettingsStore {
  read(): Promise<SikongSettings>;
  write(settings: SikongSettings): Promise<SikongSettings>;
}

export function defaultSikongSettings(): SikongSettings {
  return {
    version: 1,
    defaults: {
      clientAgent: { backend: "codex" },
      lead: { backend: "codex" },
      worker: { backend: "codex" },
    },
  };
}

export class FileSettingsStore implements SettingsStore {
  constructor(private readonly dataDir: string) {}

  async read(): Promise<SikongSettings> {
    const raw = await readYamlFile<unknown>(configFile(this.dataDir));
    return normalizeSettings(raw);
  }

  async write(settings: SikongSettings): Promise<SikongSettings> {
    const normalized = normalizeSettings(settings);
    const existing = await readYamlFile<unknown>(configFile(this.dataDir));
    const document =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    await ensureDataDirLayout(this.dataDir);
    await writeYamlFile(configFile(this.dataDir), {
      ...document,
      version: normalized.version,
      defaults: normalized.defaults,
    });
    return normalized;
  }
}

export function normalizeSettings(raw: unknown): SikongSettings {
  const fallback = defaultSikongSettings();
  if (!raw || typeof raw !== "object") return fallback;
  const record = raw as Record<string, unknown>;
  const defaults =
    record.defaults && typeof record.defaults === "object"
      ? (record.defaults as Record<string, unknown>)
      : {};
  return {
    version: 1,
    defaults: {
      clientAgent: normalizeDefaultAgentRuntime(
        defaults.clientAgent,
        fallback.defaults.clientAgent,
      ),
      lead: normalizeDefaultAgentRuntime(defaults.lead, fallback.defaults.lead),
      worker: normalizeDefaultAgentRuntime(defaults.worker, fallback.defaults.worker),
    },
  };
}

function normalizeDefaultAgentRuntime(
  raw: unknown,
  fallback: DefaultAgentRuntime,
): DefaultAgentRuntime {
  if (!raw || typeof raw !== "object") return fallback;
  const record = raw as Record<string, unknown>;
  const backend = typeof record.backend === "string" ? record.backend.trim() : "";
  if (!backend || backend === "mock") return fallback;
  const provider =
    backendSupportsProvider(backend) && typeof record.provider === "string"
      ? record.provider.trim()
      : "";
  const model = normalizeModel(backend, record.model);
  return {
    backend,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function backendSupportsProvider(backend: string): boolean {
  return backend !== "cursor";
}

function normalizeModel(backend: string, raw: unknown): string {
  const model = typeof raw === "string" ? raw.trim() : "";
  if (backend === "cursor" && model === "auto") return "default";
  return model;
}
