import type { ToolSet } from "agent-loop";

export function mergeToolSets(...sets: Array<ToolSet | undefined>): ToolSet | undefined {
  const merged: ToolSet = {};
  for (const set of sets) {
    if (!set) continue;
    Object.assign(merged, set);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
