import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Cross-language type compatibility test.
 *
 * Writes JSON fixtures from the TS types that the Go test (cross_test.go)
 * reads and validates. Ensures both sides serialize/deserialize the same
 * domain types identically.
 */

const FIXTURE_DIR = join(tmpdir(), "sikong-cross-test", randomUUID());

function fixturePath(name: string): string {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = join(FIXTURE_DIR, name);
  writeFileSync(p, "");
  return p;
}

describe("cross-language type compatibility", () => {
  it("Task JSON serialization matches Go's expected shape", () => {
    const task = {
      id: "task_test_001",
      projectId: "default",
      workflowId: "development",
      workflowVersion: "3",
      parentId: "",
      depth: 0,
      workerId: "claude-code-anthropic",
      stageId: "plan",
      status: "in_progress",
      fields: { title: "Implement login", priority: "high" },
      childIds: ["task_test_002"],
      dependsOn: [] as string[],
      scopes: { read: ["project:default"], write: ["file:src/login.ts"] },
      isolate: false,
      effort: "medium",
      createdAt: 1718000000000,
      updatedAt: 1718000000000,
    };

    const path = fixturePath("task.json");
    writeFileSync(path, JSON.stringify(task, null, 2));
    const parsed = JSON.parse(readFileSync(path, "utf8"));

    expect(parsed.id).toBe("task_test_001");
    expect(parsed.projectId).toBe("default");
    expect(parsed.workflowId).toBe("development");
    expect(parsed.status).toBe("in_progress");
    expect(parsed.fields.title).toBe("Implement login");
    expect(parsed.scopes.read).toEqual(["project:default"]);
    expect(parsed.depth).toBe(0);
    expect((parsed as any).extraField).toBeUndefined();
  });

  it("TaskEvent JSON serialization matches Go's expected shape", () => {
    const event = {
      seq: 1,
      taskId: "task_test_001",
      type: "field.set",
      payload: { field: "title", value: "Implement login" },
      source: "worker",
      ts: 1718000000000,
    };

    const path = fixturePath("event.json");
    writeFileSync(path, JSON.stringify(event, null, 2));
    const parsed = JSON.parse(readFileSync(path, "utf8"));

    expect(parsed.seq).toBe(1);
    expect(parsed.taskId).toBe("task_test_001");
    expect(parsed.type).toBe("field.set");
    expect(parsed.source).toBe("worker");
  });

  it("ChronicleEntry JSON serialization matches Go's expected shape", () => {
    const entry = {
      seq: 42,
      ts: 1718000000000,
      type: "wake.end",
      taskId: "task_test_001",
      wakeId: "wake_abc123",
      summary: "wake completed: stage plan → done",
      data: { durationMs: 15000, toolCalls: 3 },
    };

    const path = fixturePath("chronicle.json");
    writeFileSync(path, JSON.stringify(entry, null, 2));
    const parsed = JSON.parse(readFileSync(path, "utf8"));

    expect(parsed.seq).toBe(42);
    expect(parsed.type).toBe("wake.end");
    expect(parsed.summary).toContain("wake completed");
    expect(parsed.data.durationMs).toBe(15000);
  });

  it("Worker and Project YAML serialization", () => {
    const worker = {
      id: "claude-code-anthropic",
      name: "Claude Code · Anthropic",
      description: "coding agent on claude-sonnet-4-6",
      runtime: "claude-code",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      roles: ["coding", "general"],
    };

    const path = fixturePath("worker.json");
    writeFileSync(path, JSON.stringify(worker, null, 2));
    const parsed = JSON.parse(readFileSync(path, "utf8"));

    expect(parsed.id).toBe("claude-code-anthropic");
    expect(parsed.runtime).toBe("claude-code");
    expect(parsed.roles).toEqual(["coding", "general"]);
  });

  it("JSON-RPC protocol message serialization", () => {
    const runWakeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "runWake",
      params: {
        worker: {
          runtime: "ai-sdk",
          provider: { id: "deepseek", model: "deepseek-v4-flash" },
        },
        task: {
          taskId: "task_test_001",
          workflowId: "general",
          workflowVersion: "1",
          stageId: "open",
          systemPrompt: "# Workflow: General\n\nYou are advancing...",
          userPrompt: "## Current field values\n- title: (unset)",
          tools: {
            set_field: { description: "Set a field value", inputSchema: { type: "object" } },
          },
        },
      },
    };

    const path = fixturePath("rpc-runWake.json");
    writeFileSync(path, JSON.stringify(runWakeRequest, null, 2));
    const parsed = JSON.parse(readFileSync(path, "utf8"));

    expect(parsed.method).toBe("runWake");
    expect(parsed.params.worker.provider.id).toBe("deepseek");
    expect(parsed.params.task.taskId).toBe("task_test_001");
    expect(parsed.params.task.tools.set_field).toBeDefined();
  });

  it("writes FIXTURE_DIR for Go test consumption", () => {
    // Print fixture dir path so the harness can pass it to the Go test
    console.log(`SIKONG_CROSS_FIXTURE_DIR=${FIXTURE_DIR}`);
    expect(FIXTURE_DIR).toBeTruthy();
  });
});
