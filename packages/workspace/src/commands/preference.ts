import { FileWorkspacePreferencesFactory } from "../workspace";
import type { WorkspacePreference } from "../workspace";
import { FileWorkspaceStore } from "../workspace";
import type { CommandContext, CommandResult } from "./types";
import { fail, ok } from "./types";

export interface WorkspacePreferenceInput {
  workspaceId?: string;
}

export interface AddWorkspacePreferenceInput extends WorkspacePreferenceInput {
  text: string;
  note?: string;
  sourceTaskId?: string;
}

export interface RemoveWorkspacePreferenceInput extends WorkspacePreferenceInput {
  preferenceId: string;
}

export async function listWorkspacePreferences(
  ctx: CommandContext,
  input: WorkspacePreferenceInput = {},
): Promise<CommandResult<{ preferences: WorkspacePreference[] }>> {
  const opened = await openPreferences(ctx, input.workspaceId);
  if (!opened.ok) return opened;
  return ok({ preferences: await opened.data.preferences.read() });
}

export async function addWorkspacePreference(
  ctx: CommandContext,
  input: AddWorkspacePreferenceInput,
): Promise<CommandResult<{ preference: WorkspacePreference }>> {
  if (!input.text.trim()) return fail("invalid_input", "Preference text must be non-empty.");
  const opened = await openPreferences(ctx, input.workspaceId);
  if (!opened.ok) return opened;
  const preference = await opened.data.preferences.append({
    text: input.text,
    ...(input.note ? { note: input.note } : {}),
    ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
  });
  return ok({ preference });
}

export async function removeWorkspacePreference(
  ctx: CommandContext,
  input: RemoveWorkspacePreferenceInput,
): Promise<CommandResult<{ preferenceId: string }>> {
  const opened = await openPreferences(ctx, input.workspaceId);
  if (!opened.ok) return opened;
  const current = await opened.data.preferences.read();
  const next = current.filter((preference) => preference.id !== input.preferenceId);
  if (next.length === current.length) {
    return fail("preference_not_found", "Workspace preference not found.", {
      preferenceId: input.preferenceId,
    });
  }
  await opened.data.preferences.write(next);
  return ok({ preferenceId: input.preferenceId });
}

async function openPreferences(
  ctx: CommandContext,
  workspaceId = ctx.workspaceId,
): Promise<
  CommandResult<{
    preferences: ReturnType<FileWorkspacePreferencesFactory["open"]>;
  }>
> {
  if (!workspaceId) return fail("invalid_input", "Workspace id is required.");
  const workspace = await new FileWorkspaceStore(ctx.dataDir).get(workspaceId);
  if (!workspace) {
    return fail("workspace_not_found", "Workspace not found.", { workspaceId });
  }
  return ok({
    preferences: new FileWorkspacePreferencesFactory(ctx.dataDir).open(workspace),
  });
}
