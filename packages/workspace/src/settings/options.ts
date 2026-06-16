import { discoverCursorModels } from "agent-loop";

export interface RuntimeBackendOption {
  id: string;
  label: string;
  supportsProvider: boolean;
  defaultProviderLabel: string;
  requiresProvider?: boolean;
  requiresModel?: boolean;
}

export interface RuntimeProviderOption {
  id: string;
  label: string;
  supportedBackends: string[];
}

export interface RuntimeModelOption {
  backend: string;
  id: string;
  label: string;
  aliases?: string[];
}

export interface RuntimeModelDiscoveryError {
  backend: string;
  message: string;
}

export interface SikongSettingsOptions {
  backends: RuntimeBackendOption[];
  providers: RuntimeProviderOption[];
  models?: RuntimeModelOption[];
  modelDiscoveryErrors?: RuntimeModelDiscoveryError[];
}

export function runtimeSettingsOptions(): SikongSettingsOptions {
  return {
    backends: [
      {
        id: "codex",
        label: "Codex",
        supportsProvider: true,
        defaultProviderLabel: "Backend default",
      },
      {
        id: "claude-code",
        label: "Claude Code",
        supportsProvider: true,
        defaultProviderLabel: "Backend default",
      },
      {
        id: "cursor",
        label: "Cursor",
        supportsProvider: false,
        defaultProviderLabel: "Cursor API key",
      },
      {
        id: "ai-sdk",
        label: "AI SDK",
        supportsProvider: true,
        defaultProviderLabel: "Backend default",
        requiresProvider: true,
        requiresModel: true,
      },
    ],
    providers: [
      {
        id: "deepseek",
        label: "DeepSeek",
        supportedBackends: ["claude-code", "ai-sdk"],
      },
      {
        id: "kimi",
        label: "Kimi",
        supportedBackends: ["claude-code", "ai-sdk"],
      },
      {
        id: "anthropic",
        label: "Anthropic",
        supportedBackends: ["claude-code", "ai-sdk"],
      },
      {
        id: "openai",
        label: "OpenAI",
        supportedBackends: ["codex", "ai-sdk"],
      },
    ],
  };
}

export async function discoverRuntimeSettingsOptions(): Promise<SikongSettingsOptions> {
  const base = runtimeSettingsOptions();
  try {
    const cursorModels = await discoverCursorModels();
    return {
      ...base,
      models: cursorModels.map((model) => ({
        backend: "cursor",
        id: model.id,
        label: model.label,
        ...(model.aliases?.length ? { aliases: model.aliases } : {}),
      })),
    };
  } catch (err) {
    return {
      ...base,
      modelDiscoveryErrors: [
        {
          backend: "cursor",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}
