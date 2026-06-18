import * as zod from "zod";

const z = ((zod as unknown as { z?: typeof zod }).z ?? zod) as typeof zod;

export const jsonValueSchema: zod.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema.optional()),
  ]),
);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export const agentToolChoiceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("required") }).strict(),
  z.object({ type: z.literal("tool"), name: z.string().min(1) }).strict(),
]);

export type AgentToolChoice = zod.infer<typeof agentToolChoiceSchema>;

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

export const agentRunKindSchema = z.union([
  z.literal("engine_operation"),
  z.literal("assistant_turn"),
]);

export type AgentRunKind = zod.infer<typeof agentRunKindSchema>;

export const agentRunRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    kind: agentRunKindSchema,
    objective: z.string().min(1),
    prompt: z.array(agentPromptSectionSchema).min(1),
    input: jsonValueSchema,
    tools: z.array(agentToolSpecSchema),
    terminalToolSet: z.array(z.string().min(1)),
    toolChoice: agentToolChoiceSchema,
  })
  .strict();

export type AgentRunRequest = zod.infer<typeof agentRunRequestSchema>;

export const agentTerminalToolCallSchema = z
  .object({
    name: z.string().min(1),
    arguments: jsonValueSchema,
  })
  .strict();

export type AgentTerminalToolCall = zod.infer<typeof agentTerminalToolCallSchema>;

export const agentWorkerResultSchema = z
  .object({
    report: z.string(),
    terminalCall: agentTerminalToolCallSchema.optional(),
  })
  .strict();

export type AgentWorkerResult = zod.infer<typeof agentWorkerResultSchema>;

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
      result: agentWorkerResultSchema,
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

export function parseAgentWorkerResult(input: unknown): AgentWorkerResult {
  return agentWorkerResultSchema.parse(input);
}
