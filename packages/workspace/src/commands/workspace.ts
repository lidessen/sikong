import { FileWorkspaceStore, type WorkspaceDef } from "../workspace";
import type { CommandContext, CommandResult } from "./types";
import { fail, ok } from "./types";

export interface CreateWorkspaceInput {
  id: string;
  name: string;
}

export interface WorkspaceIdInput {
  workspaceId: string;
}

export async function createWorkspace(
  ctx: CommandContext,
  input: CreateWorkspaceInput,
): Promise<CommandResult<{ workspace: WorkspaceDef }>> {
  const store = new FileWorkspaceStore(ctx.dataDir);
  if (await store.get(input.id)) {
    return fail("workspace_exists", "Workspace already exists.", { workspaceId: input.id });
  }

  try {
    const workspace = { id: input.id, name: input.name };
    await store.put(workspace);
    return ok({ workspace });
  } catch (err) {
    return fail("invalid_input", errorMessage(err));
  }
}

export async function listWorkspaces(
  ctx: CommandContext,
): Promise<CommandResult<{ workspaces: WorkspaceDef[] }>> {
  return ok({ workspaces: await new FileWorkspaceStore(ctx.dataDir).list() });
}

export async function getWorkspace(
  ctx: CommandContext,
  input: WorkspaceIdInput,
): Promise<CommandResult<{ workspace: WorkspaceDef }>> {
  const workspace = await new FileWorkspaceStore(ctx.dataDir).get(input.workspaceId);
  if (!workspace) {
    return fail("workspace_not_found", "Workspace not found.", { workspaceId: input.workspaceId });
  }
  return ok({ workspace });
}

export async function deleteWorkspace(
  ctx: CommandContext,
  input: WorkspaceIdInput,
): Promise<CommandResult<{ workspaceId: string }>> {
  const store = new FileWorkspaceStore(ctx.dataDir);
  if (!(await store.get(input.workspaceId))) {
    return fail("workspace_not_found", "Workspace not found.", { workspaceId: input.workspaceId });
  }
  await store.delete(input.workspaceId);
  return ok({ workspaceId: input.workspaceId });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
