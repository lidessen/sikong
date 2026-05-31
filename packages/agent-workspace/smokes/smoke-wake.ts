/**
 * Wake/intake smoke — drives a task through the M1 engine into durable stores.
 *
 *   # creds-free dry runs + inspect:
 *   bun smokes/smoke-wake.ts mock --dir /tmp/aw
 *   bun smokes/smoke-wake.ts mock --dir /tmp/aw --intake "login throws 500 on submit, high severity"
 *   bun src/cli.ts status --dir /tmp/aw
 *
 *   # live DeepSeek v4 flash (creds via interactive shell):
 *   zsh -ic 'bun smokes/smoke-wake.ts ai-sdk --dir /tmp/aw --intake "the login page 500s on submit, high severity"'
 */
import { aiSdkLoop, claudeCodeLoop, deepseek, mockLoop } from "agent-loop";
import {
  GENERAL_WORKFLOW,
  JsonlChronicleStore,
  JsonlEventStore,
  JsonProjectionStore,
  MemoryWorkflowRegistry,
  WorkflowEngine,
  type LoopFactory,
  type WorkflowDef,
} from "../src/index";

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const runtime = argv[0] && !argv[0].startsWith("-") ? argv[0] : "mock";
const dir = flag("--dir") ?? ".agent-workspace";
const intakeReq = flag("--intake");

const BUG: WorkflowDef = {
  id: "bug",
  version: "1",
  name: "Bug",
  description: "Track and fix a reported software bug.",
  fields: {
    title: { type: "string", description: "short title of the bug" },
    severity: { type: "enum", enum: ["low", "high"], description: "how bad it is" },
    summary: { type: "string", description: "the fix / outcome, written when finishing" },
  },
  stages: [
    { id: "open", category: "in_progress", entry: { op: "always" }, instructions: "Investigate; when resolved, write a `summary` and request a transition." },
    { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
  ],
};

const provider = deepseek({ model: "deepseek-v4-flash" });
const buildWorker = () =>
  runtime === "ai-sdk"
    ? aiSdkLoop({ provider })
    : runtime === "claude"
      ? claudeCodeLoop({ provider })
      : mockLoop({ callTool: { name: "request_transition", args: { reason: "done (mock)" } } });
const buildIntake = () =>
  runtime === "ai-sdk"
    ? aiSdkLoop({ provider })
    : runtime === "claude"
      ? claudeCodeLoop({ provider })
      : mockLoop({ callTool: { name: "route", args: { workflowId: "bug", fields: { title: "mock bug", severity: "high" } } } });

const loop: LoopFactory = () => buildWorker();
const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
registry.register(BUG);

const engine = new WorkflowEngine({
  events: new JsonlEventStore(dir),
  projections: new JsonProjectionStore(dir),
  registry,
  chronicle: new JsonlChronicleStore(dir),
  loop,
  intakeLoop: buildIntake,
  maxStepsPerWake: 6,
  wakeTimeoutMs: 90_000,
  hooks: {
    onWakeStart: ({ wakeId, stageId }) => console.log(`▶ ${wakeId} @ "${stageId}"`),
    onLoopEvent: ({ event }) => {
      if (event.type === "tool_call_start") console.log(`  ↳ ${event.name}(${JSON.stringify(event.args)})`);
      if (event.type === "text" && event.text.trim()) console.log(`  · ${event.text.trim().slice(0, 120)}`);
    },
    onReject: ({ command, reason }) => console.log(`  ✗ ${command.kind}: ${reason}`),
    onWakeEnd: ({ wakeId, advancedTo, status, error }) =>
      console.log(`■ ${wakeId} — status=${status}${advancedTo ? ` → "${advancedTo}"` : ""}${error ? ` ERROR: ${error.message}` : ""}`),
    onError: ({ error }) => console.error(`‼ ${error.message}`),
  },
});

console.log(`runtime=${runtime} model=deepseek-v4-flash dir=${dir}\n`);

const task = intakeReq
  ? await engine.intake(intakeReq, { projectId: "default", taskId: "intake-smoke" })
  : await engine.createTask({
      projectId: "default",
      taskId: "wake-smoke",
      fields: { request: "Write one sentence explaining event sourcing in `summary`, then request a transition." },
    });

if (intakeReq) console.log(`intake routed → "${task.workflowId}", fields=${JSON.stringify(task.fields)}\n`);
else console.log(`created ${task.id} @ "${task.stageId}" (${task.status})\n`);

await engine.idle();

const final = await engine.getTask(task.id);
console.log(`\nfinal: workflow="${final?.workflowId}" stage="${final?.stageId}" status=${final?.status}`);
console.log(`summary: ${JSON.stringify(final?.fields.summary)}`);
console.log(`\ninspect: bun src/cli.ts task ${task.id} --dir ${dir}`);
process.exit(final?.status === "done" ? 0 : 1);
