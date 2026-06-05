import { join } from "node:path";
import { YAML } from "bun";

// ── File utilities ────────────────────────────────────────────────────────────

export function isYamlFile(name: string): boolean {
  return name.endsWith(".yaml") || name.endsWith(".yml");
}

export function isDataFile(name: string): boolean {
  return isYamlFile(name) || name.endsWith(".json");
}

export function parseDataFile<T>(text: string, file: string): T {
  return (isYamlFile(file) ? YAML.parse(text) : JSON.parse(text)) as T;
}

export function dataFileCandidates(root: string, basename: string): string[] {
  return [join(root, `${basename}.yaml`), join(root, `${basename}.yml`), join(root, `${basename}.json`)];
}

export function yamlFile(root: string, basename: string): string {
  return join(root, `${basename}.yaml`);
}

export function stringifyYaml(value: unknown): string {
  return YAML.stringify(value, null, 2);
}

// ── Sandbox escalation config (ADR 0026) ──────────────────────────────────────

/**
 * Sandbox escalation configuration for a project or workspace. Controls how the
 * worker's bash tool handles sandbox-constrained commands — whether and how they
 * are retried on the real host (bypassing the virtual FS sandbox) so the worker
 * can self-verify with the real toolchain.
 *
 * This is the persisted config shape; the agent-loop `SandboxEscalationConfig`
 * type is the runtime shape consumed by the escalation machinery.
 */
export interface SandboxConfig {
  /** Master switch. Default: true (auto-escalation enabled). */
  allowUnsandboxedCommands?: boolean;
  /** Additional commands to allow for escalation (first-token prefixes). */
  allowList?: string[];
  /** Commands to deny escalation for (first-token prefixes). */
  denyList?: string[];
  /** Commands never allowed to escalate (first-token prefixes). */
  excludedCommands?: string[];
}
