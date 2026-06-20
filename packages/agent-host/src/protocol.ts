import * as zod from "zod";

const z = ((zod as unknown as { z?: typeof zod }).z ?? zod) as typeof zod;

export const jsonValueSchema = z.json();
export type JsonValue = zod.infer<typeof jsonValueSchema>;

export const agentToolSpecSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    inputSchema: jsonValueSchema,
  })
  .strict();

export type AgentToolSpec = zod.infer<typeof agentToolSpecSchema>;

export const agentPromptSectionSchema = z
  .object({
    title: z.string().min(1),
    content: z.string().min(1),
  })
  .strict();

export type AgentPromptSection = zod.infer<typeof agentPromptSectionSchema>;

export const agentRunRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    objective: z.string().min(1),
    prompt: z.array(agentPromptSectionSchema).min(1),
    input: jsonValueSchema,
    tools: z.array(agentToolSpecSchema),
    terminalToolSet: z.array(z.string().min(1)),
  })
  .strict();

export type AgentRunRequest = zod.infer<typeof agentRunRequestSchema>;

export const agentToolCallSchema = z
  .object({
    name: z.string().min(1),
    arguments: jsonValueSchema,
  })
  .strict();

export type AgentToolCall = zod.infer<typeof agentToolCallSchema>;

export const agentRunResponseSchema = z
  .object({
    report: z.string(),
    toolCalls: z.array(agentToolCallSchema).optional(),
    terminalCall: agentToolCallSchema.optional(),
  })
  .strict();

export type AgentRunResponse = zod.infer<typeof agentRunResponseSchema>;

export const runtimeClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("run"),
      id: z.string().min(1),
      request: agentRunRequestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("shutdown"),
      id: z.string().min(1),
    })
    .strict(),
]);

export type RuntimeClientMessage = zod.infer<typeof runtimeClientMessageSchema>;

export const agentHostMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("result"),
      id: z.string(),
      result: agentRunResponseSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      id: z.string(),
      message: z.string(),
    })
    .strict(),
]);

export type AgentHostMessage = zod.infer<typeof agentHostMessageSchema>;

export function parseAgentRunRequest(input: unknown): AgentRunRequest {
  return agentRunRequestSchema.parse(input);
}

export function parseRuntimeClientMessage(input: unknown): RuntimeClientMessage {
  return runtimeClientMessageSchema.parse(input);
}

export function parseAgentRunResponse(input: unknown): AgentRunResponse {
  return agentRunResponseSchema.parse(input);
}
