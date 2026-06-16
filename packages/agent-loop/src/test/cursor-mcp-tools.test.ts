import { describe, expect, test } from "vitest";
import { defineTool } from "../core/types";
import { handleMcpRequest } from "../adapters/cursor";

describe("cursor MCP tool bridge", () => {
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
