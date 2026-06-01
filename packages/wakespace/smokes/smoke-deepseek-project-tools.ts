/**
 * Live DeepSeek smoke for AI SDK project tools.
 *
 *   DEEPSEEK_API_KEY=... bun smokes/smoke-deepseek-project-tools.ts
 *   DEEPSEEK_API_KEY=... bun smokes/smoke-deepseek-project-tools.ts --model deepseek-v4-flash
 *   DEEPSEEK_API_KEY=... bun smokes/smoke-deepseek-project-tools.ts --project-root /tmp/project --dir /tmp/aw
 *
 * The smoke creates a marker file under a unique .wakespace-smoke-* directory,
 * asks a real DeepSeek worker to find it with project tools, then asserts both
 * the normalized tool events and the filesystem side effect.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiSdkLoop, deepseek } from "agent-loop";
import {
  JsonlChronicleStore,
  JsonlEventStore,
  JsonProjectionStore,
  MemoryProjectStore,
  MemoryWorkflowRegistry,
  WorkflowEngine,
  type WorkflowDef,
} from "../src/index";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (name: string): boolean => argv.includes(name);

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(
    [
      "usage: bun smokes/smoke-deepseek-project-tools.ts [--model <m>] [--project-root <path>] [--dir <path>]",
      "",
      "Requires DEEPSEEK_API_KEY.",
      "Defaults: --model deepseek-v4-flash, temp project root, temp workspace dir.",
    ].join("\n"),
  );
  process.exit(0);
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is required for this live smoke.");
  process.exit(2);
}

const model = flag("--model") ?? "deepseek-v4-flash";
const workspaceDir = flag("--dir") ?? join(await mkTempDir("wakespace-deepseek-workspace-"), ".wakespace");
const projectRoot = flag("--project-root") ?? (await mkTempDir("wakespace-deepseek-project-"));
const marker = `ds-tool-smoke-${randomUUID().slice(0, 8)}`;
const smokeDir = `.wakespace-smoke-${marker}`;
const markerRel = `${smokeDir}/marker.txt`;
const outputRel = `${smokeDir}/deepseek-smoke.txt`;
const taskId = `deepseek-project-tools-live-${marker}`;

await mkdir(join(projectRoot, smokeDir), { recursive: true });
await writeFile(join(projectRoot, markerRel), `${marker}\n`, "utf8");

const workflow: WorkflowDef = {
  id: "project-tool-smoke",
  version: "1",
  name: "Project Tool Smoke",
  description: "Verify that a real AI SDK worker can use project tools.",
  fields: {
    request: { type: "string", description: "what to verify" },
    summary: { type: "string", description: "must include the discovered marker" },
  },
  stages: [
    {
      id: "work",
      category: "in_progress",
      entry: { op: "always" },
      instructions: [
        "Verify project tools by actually calling project tools; do not guess.",
        `First call \`rg\` with pattern \`ds-tool-smoke-\` and path \`${markerRel}\` to find the marker.`,
        `Then call \`readFile\` to read ${markerRel}.`,
        `Then call \`writeFile\` to create ${outputRel} containing exactly VERIFIED:<marker>.`,
        "After writing, call `set_field` with field `summary` and a value that includes the discovered marker.",
        "Finally call `request_transition`.",
      ].join(" "),
    },
    { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
  ],
};

const registry = new MemoryWorkflowRegistry(workflow);
const toolCalls: string[] = [];
const errors: string[] = [];
let rgFoundMarker = false;
let readFileFoundMarker = false;

const engine = new WorkflowEngine({
  events: new JsonlEventStore(workspaceDir),
  projections: new JsonProjectionStore(workspaceDir),
  chronicle: new JsonlChronicleStore(workspaceDir),
  projects: new MemoryProjectStore([{ id: "p", name: "DeepSeek Smoke Project", root: projectRoot }]),
  registry,
  loop: () => aiSdkLoop({ provider: deepseek({ model }) }),
  wakeTimeoutMs: 180_000,
  hooks: {
    onLoopEvent: ({ event }) => {
      if (event.type === "tool_call_start") {
        toolCalls.push(event.name);
        console.log(`tool:${event.name} ${JSON.stringify(event.args)}`);
      }
      if (event.type === "tool_call_end") {
        if (event.name === "rg" || event.name === "readFile") {
          console.log(`tool_result:${event.name} ${resultText(event.result).slice(0, 500)}`);
        }
        if (event.name === "rg" && resultText(event.result).includes(marker)) rgFoundMarker = true;
        if (event.name === "readFile" && resultText(event.result).includes(marker)) readFileFoundMarker = true;
      }
      if (event.type === "text" && event.text.trim()) {
        console.log(`text:${event.text.trim().slice(0, 160)}`);
      }
    },
    onError: ({ error }) => errors.push(error.message),
  },
});

console.log(`model=${model}`);
console.log(`workspaceDir=${workspaceDir}`);
console.log(`projectRoot=${projectRoot}`);
console.log(`marker=${marker}`);

await engine.createTask({
  projectId: "p",
  workflowId: workflow.id,
  taskId,
  fields: { request: `Find the marker in ${markerRel} and write ${outputRel} as instructed.` },
});
await engine.idle();

const final = await engine.getTask(taskId);
let written = "";
try {
  written = await readFile(join(projectRoot, outputRel), "utf8");
} catch (err) {
  written = `READ_ERROR:${(err as Error).message}`;
}

const requiredTools = ["rg", "readFile", "writeFile", "set_field", "request_transition"];
const missing = requiredTools.filter((name) => !toolCalls.includes(name));
const expected = `VERIFIED:${marker}`;
const ok =
  errors.length === 0 &&
  missing.length === 0 &&
  rgFoundMarker &&
  readFileFoundMarker &&
  final?.status === "done" &&
  String(final.fields.summary ?? "").includes(marker) &&
  written.trim() === expected;

console.log(
  JSON.stringify(
    {
      taskId,
      status: final?.status,
      stageId: final?.stageId,
      summary: final?.fields.summary,
      toolCalls,
      outputRel,
      written,
      errors,
      missing,
      rgFoundMarker,
      readFileFoundMarker,
    },
    null,
    2,
  ),
);

if (!ok) {
  console.error(`LIVE_SMOKE_FAILED expectedOutput=${JSON.stringify(expected)}`);
  process.exit(1);
}

console.log("LIVE_SMOKE_OK");

async function mkTempDir(prefix: string): Promise<string> {
  const root = join(tmpdir(), `${prefix}${randomUUID().slice(0, 8)}`);
  await mkdir(root, { recursive: true });
  return root;
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}
