export {
  defaultDataDir,
  ensureDataDirLayout,
  preferencesFile,
  resolveDataDir,
  taskEventsDir,
  taskEventsFile,
  taskEventsLockFile,
  taskProjectionFile,
  taskProjectionsDir,
  workspaceDir,
  workspaceFile,
  worktreeDir,
  worktreesDir,
} from "./layout";
export type { DataDirResolution, DataDirResolutionSource } from "./layout";

export { withFileLock, type FileLockOptions } from "./file-lock";
export { readYamlFile, writeYamlFile } from "./yaml";
