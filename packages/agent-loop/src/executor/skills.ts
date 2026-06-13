import type { McpServers, RunInput, ToolSet } from "../core/types";

export interface CompiledRequest {
  system: string;
  tools: ToolSet;
  mcp: McpServers;
}

/**
 * Compile skills + base inputs into a single resolved request.
 *
 * - skill instructions are appended to the system prompt, in order
 * - skill tools / MCP servers are merged, with later sources winning on key
 *   collisions (base `input.tools` / `input.mcp` win over skills)
 */
export function compileRequest(input: RunInput): CompiledRequest {
  const skills = input.skills ?? [];

  const systemParts: string[] = [];
  if (input.system?.trim()) systemParts.push(input.system.trim());
  for (const skill of skills) {
    const body = skill.instructions?.trim();
    if (body) systemParts.push(`## Skill: ${skill.name}\n${body}`);
  }

  const tools: ToolSet = {};
  const mcp: McpServers = {};
  // Skills first, base inputs last → base inputs override on collision.
  for (const skill of skills) {
    Object.assign(tools, skill.tools);
    Object.assign(mcp, skill.mcp);
  }
  Object.assign(tools, input.tools);
  Object.assign(mcp, input.mcp);

  return {
    system: systemParts.join("\n\n"),
    tools,
    mcp,
  };
}
