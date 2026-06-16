import { Bot, Cpu, Loader2, Settings, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import type React from "react";
import type { FormEvent } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { CardDescription, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import type {
  DefaultAgentRuntime,
  DefaultAgentRuntimeKey,
  RuntimeBackendOption,
  RuntimeProviderOption,
  SikongSettings,
  SikongSettingsOptions,
} from "./types";

const agentDefaultLabels: Array<{
  key: DefaultAgentRuntimeKey;
  title: string;
  description: string;
}> = [
  {
    key: "clientAgent",
    title: "Client Agent",
    description: "Interprets chat, reads workspace state, and reports back.",
  },
  {
    key: "lead",
    title: "Lead",
    description: "Turns requirements into specs, accepts plans, and closes decisions.",
  },
  {
    key: "worker",
    title: "Worker",
    description: "Runs implementation and verification work items.",
  },
];

const fallbackSettingsOptions: SikongSettingsOptions = {
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
    { id: "deepseek", label: "DeepSeek", supportedBackends: ["claude-code", "ai-sdk"] },
    { id: "anthropic", label: "Anthropic", supportedBackends: ["claude-code", "ai-sdk"] },
    { id: "openai", label: "OpenAI", supportedBackends: ["codex", "ai-sdk"] },
  ],
};

export function SettingsDialog(props: {
  open: boolean;
  settings: SikongSettings;
  options?: SikongSettingsOptions;
  onClose: () => void;
  onSaveSettings: (settings: SikongSettings) => Promise<void>;
}) {
  if (!props.open) return null;
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[1px]"
      onClick={props.onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        className="relative flex max-h-[min(760px,calc(100dvh-2rem))] w-full max-w-[640px] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-background shadow-[var(--shadow-sheet)]"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-3 top-3 z-10 size-7"
          onClick={props.onClose}
        >
          <X />
        </Button>
        <SettingsForm
          settings={props.settings}
          options={props.options ?? props.settings.options ?? fallbackSettingsOptions}
          titleId="settings-dialog-title"
          onSave={props.onSaveSettings}
        />
      </div>
    </div>
  );
}

function SettingsForm(props: {
  settings: SikongSettings;
  options: SikongSettingsOptions;
  titleId?: string;
  onSave: (settings: SikongSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SikongSettings>(props.settings);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.settings);

  useEffect(() => {
    setDraft(props.settings);
  }, [props.settings]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSavedAt(null);
    try {
      await props.onSave(draft);
      setSavedAt(new Date().toLocaleTimeString());
    } finally {
      setSaving(false);
    }
  }

  function updateDefault(key: DefaultAgentRuntimeKey, next: DefaultAgentRuntime) {
    setDraft((current) => ({
      version: 1,
      defaults: {
        ...current.defaults,
        [key]: normalizeDraftDefault(next, props.options),
      },
    }));
  }

  return (
    <form className="flex min-h-0 flex-col" onSubmit={submit}>
      <div className="shrink-0 border-b border-divider px-4 py-3 pr-12">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-[var(--radius-md)] border border-[var(--accent-dim)] bg-[var(--accent-soft)] text-primary">
            <Settings />
          </span>
          <div className="min-w-0">
            <CardTitle id={props.titleId} className="text-[15px]">
              Settings
            </CardTitle>
            <CardDescription>
              Runtime defaults for chat coordination, lead decisions, and worker execution.
            </CardDescription>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-9">
          <Badge variant="outline">config.yaml</Badge>
          <Badge variant={dirty ? "warn" : "neutral"}>{dirty ? "unsaved" : "current"}</Badge>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <div className="flex flex-col gap-2">
          {agentDefaultLabels.map((item) => (
            <AgentDefaultFields
              key={item.key}
              role={item}
              value={draft.defaults[item.key]}
              options={props.options}
              onChange={(next) => updateDefault(item.key, next)}
            />
          ))}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-divider bg-bg/95 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {savedAt
            ? `Saved ${savedAt}`
            : dirty
              ? "Changes are local until saved."
              : "Stored in config.yaml"}
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(props.settings)}>
            Reset
          </Button>
          <Button type="submit" size="sm" disabled={saving || !dirty}>
            {saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}

function AgentDefaultFields(props: {
  role: (typeof agentDefaultLabels)[number];
  value: DefaultAgentRuntime;
  options: SikongSettingsOptions;
  onChange: (value: DefaultAgentRuntime) => void;
}) {
  const backend = backendOption(props.options.backends, props.value.backend);
  const providerDisabled = !backend.supportsProvider;
  const providerOptions = providersForBackend(props.options.providers, props.value.backend);
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-card p-3">
      <div className="grid gap-3 lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] border bg-background text-primary">
            <AgentRoleIcon role={props.role.key} />
          </span>
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <p className="truncate text-[13px] font-semibold">{props.role.title}</p>
              <Badge variant="outline">
                {props.value.provider
                  ? `${props.value.backend}/${props.value.provider}`
                  : props.value.backend}
              </Badge>
            </div>
            <p className="text-[12px] leading-5 text-muted-foreground">{props.role.description}</p>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(160px,1.2fr)]">
          <RuntimeField label="Backend">
            <select
              className={settingsSelectClassName}
              value={props.value.backend}
              onChange={(event) => {
                const backend = event.currentTarget.value;
                props.onChange({
                  ...props.value,
                  backend,
                  ...(backendOption(props.options.backends, backend).supportsProvider
                    ? {}
                    : { provider: "" }),
                });
              }}
            >
              {props.options.backends.map((backend) => (
                <option key={backend.id} value={backend.id}>
                  {backend.label}
                </option>
              ))}
            </select>
          </RuntimeField>
          <RuntimeField label="Provider">
            <select
              className={settingsSelectClassName}
              value={providerDisabled ? "" : (props.value.provider ?? "")}
              disabled={providerDisabled}
              onChange={(event) =>
                props.onChange({ ...props.value, provider: event.currentTarget.value })
              }
            >
              {providerOptions.map((provider) => (
                <option
                  key={provider === "" ? "backend-default" : provider.id}
                  value={provider === "" ? "" : provider.id}
                >
                  {provider === "" ? backend.defaultProviderLabel : provider.label}
                </option>
              ))}
            </select>
          </RuntimeField>
          <RuntimeField label="Model">
            <Input
              value={props.value.model ?? ""}
              placeholder="default"
              onChange={(event) =>
                props.onChange({ ...props.value, model: event.currentTarget.value })
              }
            />
          </RuntimeField>
        </div>
      </div>
    </div>
  );
}

const settingsSelectClassName =
  "h-7 w-full rounded-[var(--radius-md)] border border-input bg-bg-elev px-2 text-[13px] text-foreground outline-none transition-[background-color,border-color,color] focus-visible:border-ring";

function RuntimeField(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {props.label}
      {props.children}
    </label>
  );
}

function AgentRoleIcon(props: { role: DefaultAgentRuntimeKey }) {
  if (props.role === "clientAgent") return <Bot />;
  if (props.role === "lead") return <ShieldCheck />;
  return <Cpu />;
}

function normalizeDraftDefault(
  value: DefaultAgentRuntime,
  options: SikongSettingsOptions,
): DefaultAgentRuntime {
  const backend = value.backend.trim() || "codex";
  const provider = backendOption(options.backends, backend).supportsProvider
    ? value.provider?.trim()
    : "";
  const model = value.model?.trim();
  return {
    backend,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function backendOption(
  options: readonly RuntimeBackendOption[],
  backend: string,
): RuntimeBackendOption {
  return (
    options.find((option) => option.id === backend) ?? {
      id: backend,
      label: backend,
      supportsProvider: true,
      defaultProviderLabel: "Backend default",
    }
  );
}

function providersForBackend(
  providers: readonly RuntimeProviderOption[],
  backend: string,
): Array<RuntimeProviderOption | ""> {
  return ["", ...providers.filter((provider) => provider.supportedBackends.includes(backend))];
}
