import { preferencesFile } from "./layout";
import { readYamlFile, writeYamlFile } from "./yaml";
import type { WorkspaceDef } from "./workspace";

export interface WorkspacePreference {
  id: string;
  text: string;
  note?: string;
  sourceTaskId?: string;
}

export interface WorkspacePreferenceInput {
  text: string;
  note?: string;
  sourceTaskId?: string;
}

export interface WorkspacePreferences {
  read(): Promise<WorkspacePreference[]>;
  write(preferences: WorkspacePreference[]): Promise<void>;
  append(preference: WorkspacePreferenceInput): Promise<WorkspacePreference>;
}

export interface WorkspacePreferencesFactory {
  open(workspace: WorkspaceDef): WorkspacePreferences;
}

interface PreferencesDocument {
  version: 1;
  preferences?: WorkspacePreference[];
}

export class FileWorkspacePreferences implements WorkspacePreferences {
  constructor(private readonly file: string) {}

  async read(): Promise<WorkspacePreference[]> {
    const doc = await readYamlFile<PreferencesDocument>(this.file);
    return [...(doc?.preferences ?? [])];
  }

  async write(preferences: WorkspacePreference[]): Promise<void> {
    const normalized = preferences.map((preference) => normalizePreference(preference));
    await writeYamlFile(this.file, {
      version: 1,
      preferences: normalized,
    } satisfies PreferencesDocument);
  }

  async append(input: WorkspacePreferenceInput): Promise<WorkspacePreference> {
    const current = await this.read();
    const preference = normalizePreference({ ...input, id: nextPreferenceId(input.text, current) });
    await this.write([...current, preference]);
    return preference;
  }
}

export class FileWorkspacePreferencesFactory implements WorkspacePreferencesFactory {
  constructor(private readonly homeDir: string) {}

  open(workspace: WorkspaceDef): WorkspacePreferences {
    return new FileWorkspacePreferences(preferencesFile(this.homeDir, workspace.id));
  }
}

function normalizePreference(preference: WorkspacePreference): WorkspacePreference {
  if (!preference.id.trim()) throw new Error("workspace preference id must be non-empty");
  if (!preference.text.trim()) throw new Error("workspace preference text must be non-empty");
  return {
    id: preference.id,
    text: preference.text,
    ...(preference.note ? { note: preference.note } : {}),
    ...(preference.sourceTaskId ? { sourceTaskId: preference.sourceTaskId } : {}),
  };
}

function nextPreferenceId(text: string, existing: readonly WorkspacePreference[]): string {
  const used = new Set(existing.map((preference) => preference.id));
  const base = slugify(text) || "preference";
  if (!used.has(base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

function slugify(text: string): string {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 4).join("-").slice(0, 48);
}
