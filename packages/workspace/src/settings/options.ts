export interface RuntimeBackendOption {
  id: string;
  label: string;
  supportsProvider: boolean;
  defaultProviderLabel: string;
}

export interface RuntimeProviderOption {
  id: string;
  label: string;
  supportedBackends: string[];
}

export interface SikongSettingsOptions {
  backends: RuntimeBackendOption[];
  providers: RuntimeProviderOption[];
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
      },
    ],
    providers: [
      {
        id: "deepseek",
        label: "DeepSeek",
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
