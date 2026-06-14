export {
  defaultHomeDir,
  ensureHomeLayout,
  preferencesFile,
  resolveHomeDir,
  taskEventsDir,
  taskProjectionsDir,
  workspaceDir,
  workspaceFile,
  worktreeDir,
  worktreesDir,
} from "./layout";
export type { HomeDirResolution, HomeDirResolutionSource } from "./layout";

export {
  FileWorkspaceStore,
  isValidWorkspaceId,
  requireValidWorkspace,
  type WorkspaceDef,
  type WorkspaceStore,
} from "./workspace";

export {
  FileWorkspacePreferences,
  FileWorkspacePreferencesFactory,
  type WorkspacePreference,
  type WorkspacePreferenceInput,
  type WorkspacePreferences,
  type WorkspacePreferencesFactory,
} from "./preferences";
