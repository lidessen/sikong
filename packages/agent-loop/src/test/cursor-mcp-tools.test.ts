import { describe, expect, test } from "vitest";
import { defineTool } from "../core/types";
import { buildCursorCustomTools, handleMcpRequest, resolveCursorModelId } from "../adapters/cursor";

describe("cursor MCP tool bridge", () => {
  test("normalizes empty and auto cursor model selections to default", () => {
    expect(resolveCursorModelId(undefined)).toBe("default");
    expect(resolveCursorModelId("")).toBe("default");
    expect(resolveCursorModelId("auto")).toBe("default");
    expect(resolveCursorModelId("composer-2")).toBe("composer-2");
  });

  test("maps loop tools to Cursor custom tools", async () => {
    let stopReason: string | undefined;
    const customTools = buildCursorCustomTools(
      {
        finishClientTurn: defineTool({
          description: "Finish the turn.",
          inputSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
          execute: async (args, ctx) => ({
            ok: true,
            args,
            callId: ctx.callId,
            stop: ctx.requestStop?.("done"),
          }),
        }),
      },
      undefined,
      (reason) => {
        stopReason = reason;
      },
    );

    const result = await customTools.finishClientTurn?.execute(
      { summary: "done" },
      { toolCallId: "call_1" },
    );

    expect(result).toMatchObject({
      ok: true,
      args: { summary: "done" },
      callId: "call_1",
    });
    expect(stopReason).toBe("done");
  });

  test("drops non-json custom tool schemas before passing them to Cursor", () => {
    const customTools = buildCursorCustomTools({
      finishClientTurn: defineTool({
        description: "Finish the turn.",
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string", refine: () => true },
          },
        },
        execute: async () => ({ ok: true }),
      }),
    });

    expect(customTools.finishClientTurn?.inputSchema).toEqual({
      type: "object",
      properties: {
        summary: { type: "string" },
      },
    });
  });

  test("handles MCP initialization", async () => {
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      },
      {},
    );

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        capabilities: {
          tools: {},
        },
      },
    });
  });

  test("awaits async tool execution before returning tools/call content", async () => {
    let completed = false;
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: "call_1",
        method: "tools/call",
        params: {
          name: "finishClientTurn",
          arguments: { summary: "done" },
        },
      },
      {
        finishClientTurn: defineTool({
          description: "Finish the turn.",
          execute: async (args, ctx) => {
            await Promise.resolve();
            completed = true;
            return {
              ok: true,
              args,
              callId: ctx.callId,
            };
          },
        }),
      },
    );

    expect(completed).toBe(true);
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "call_1",
      result: {
        content: [
          {
            type: "text",
          },
        ],
      },
    });
    const result = response?.result as { content?: Array<{ type: string; text?: string }> };
    expect(JSON.parse(String(result.content?.[0]?.text))).toMatchObject({
      ok: true,
      args: { summary: "done" },
      callId: "call_1",
    });
  });
});
