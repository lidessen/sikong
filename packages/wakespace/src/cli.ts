#!/usr/bin/env bun
/**
 * wakespace CLI — the surface a lead agent (Claude Code) drives the
 * workspace through (no MCP; agent-browser-style). Each command operates on the
 * durable workspace dir; `run` drives pending tasks' wakes to quiescence. Write
 * commands take an exclusive dir lock — don't run two writers on one --dir.
 *
 *   create <request> [--workflow <id>] [--project <id>] [--id <id>]   publish a task (intake-routed unless --workflow)
 *   run [--task <id>]                                                 drive pending task(s) to done/quiet (exit 1 if any wake errored)
 *   submit <id> <set-field <f> <v> | cancel [reason] | block <reason> | unblock>
 *   register <workflow.yaml>                                          register a workflow definition
 *   overview [--project <id>] [--json]                                  human workspace dashboard
 *   status [--project <id>] [--text] | task <id> [--text] | chronicle [--task <id>] [-n N] [--text]
 *   --dir <path>   workspace dir override (default $WAKESPACE_HOME or ~/.wakespace; legacy $WAKESPACE_DIR still works)
 *
 *   Agent-facing commands default to JSON. Use --text for ad-hoc human output.
 *
 *   set-field coerces by the field's declared type (string/enum kept literal;
 *   number/boolean/json JSON-parsed).
 */
import { unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  JsonProjectStore,
  JsonWorkerStore,
  JsonWorkspaceChronicleStore,
  JsonWorkspaceEventStore,
  JsonWorkspaceProjectionStore,
} from "./store";
import { renderOverview, renderStatus, renderTaskDetail, taskDetail, workspaceOverview, workspaceStatus } from "./inspect";
import { acquireLock, getDefaultWorker, openWorkspace, saveWorkflow, setDefaultWorker, type Workspace } from "./workspace";
import { parseDataFile } from "./config-file";
import { isValidProjectId, type Project } from "./project";
import { discoverWorkers, isValidWorkerId, type Worker, type WorkerProvider, type WorkerRuntime } from "./worker";
import type { WorkerPermissionMode } from "./worker";
import type { Command } from "./workflow";
import { resolveWorkspaceDir } from "./workspace-layout";

const VALUE_FLAGS = new Set([
  "--dir", "--project", "--workflow", "--id", "--task", "-n",
  "--root", "--name", "--model", "--worker", "--runtime", "--provider", "--desc",
  "--permission", "--permission-mode",
]);
const BOOL_FLAGS = new Set(["--json", "--text", "--human"]);
const fail = (msg: string, code = 2): never => {
  console.error(msg);
  process.exit(code);
};

// Split flags from positionals up front so a flag (e.g. --dir) can't be swallowed
// into a positional value like `submit <id> set-field <field> <value>`.
const positional: string[] = [];
const flags = new Map<string, string | true>();
{
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq >= 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.has(name)) {
      const v = eq >= 0 ? a.slice(eq + 1) : raw[++i];
      if (v === undefined) fail(`flag ${name} requires a value`);
      else flags.set(name, v);
    } else if (BOOL_FLAGS.has(name)) {
      flags.set(name, true);
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      fail(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
}
const flag = (name: string): string | undefined => {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
};
const hasFlag = (name: string): boolean => flags.has(name);

const workspaceDir = resolveWorkspaceDir({ dirFlag: flag("--dir") });
const dir = workspaceDir.dir;
const text = (hasFlag("--text") || hasFlag("--human")) && !hasFlag("--json");
const cmd = positional[0];
const argv1 = process.argv[1] ?? "wakespace";
const cli = argv1.endsWith(".ts") ? `bun ${argv1}` : argv1;
const PERMISSION_MODES = new Set<WorkerPermissionMode>([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);

function permissionMode(): WorkerPermissionMode | undefined {
  const raw = flag("--permission-mode") ?? flag("--permission");
  if (raw === undefined) return undefined;
  if (!PERMISSION_MODES.has(raw as WorkerPermissionMode))
    fail("--permission must be default, acceptEdits, bypassPermissions, plan, dontAsk, or auto");
  return raw as WorkerPermissionMode;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printView<T>(value: T, render: (value: T) => string): void {
  console.log(text ? render(value) : JSON.stringify(value, null, 2));
}

function parseLeadCommand(op: string, rest: string[]): Command {
  switch (op) {
    case "cancel":
      return { kind: "cancel", ...(rest.length ? { reason: rest.join(" ") } : {}) };
    case "block": {
      const reason = rest.join(" ");
      if (!reason) throw new Error("block needs <reason>");
      return { kind: "block", reason };
    }
    case "unblock":
      return { kind: "unblock" };
    default:
      throw new Error(`unknown submit op "${op}" (set-field | cancel | block | unblock)`);
  }
}

/** Build a lead command; `set-field` coerces the value by the field's declared type. */
async function buildSubmitCommand(ws: Workspace, taskId: string, op: string, rest: string[]): Promise<Command> {
  if (op !== "set-field") return parseLeadCommand(op, rest);
  const field = rest[0];
  if (!field) throw new Error("set-field needs <field> <value>");
  const raw = rest.slice(1).join(" ");
  const task = await ws.engine.getTask(taskId);
  const def = task ? ws.registry.get(task.workflowId, task.workflowVersion)?.fields[field] : undefined;
  const literal = def?.type === "string" || def?.type === "ref" || def?.type === "enum";
  let value: unknown = raw;
  if (!literal) {
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
  }
  return { kind: "set_field", field, value };
}

// Write commands take the dir's exclusive write lock (released on process exit).
const WRITE_CMDS = new Set(["create", "run", "submit", "register"]);
const needsLock =
  (!!cmd && WRITE_CMDS.has(cmd)) ||
  (cmd === "project" && positional[1] === "create") ||
  (cmd === "project" && positional[1] === "memory" && positional.length > 3) ||
  (cmd === "worker" && (positional[1] === "create" || positional[1] === "default"));
if (needsLock) {
  let lockPath: string;
  try {
    lockPath = (await acquireLock(dir)).path;
  } catch (err) {
    fail((err as Error).message, 1);
  }
  process.on("exit", () => {
    try {
      unlinkSync(lockPath!);
    } catch {
      /* ignore */
    }
  });
}

switch (cmd) {
  // ---- read (no engine / credentials needed) ------------------------------
  case "overview": {
    const view = await workspaceOverview(
      {
        projects: new JsonProjectStore(dir),
        workers: new JsonWorkerStore(dir),
        projections: new JsonWorkspaceProjectionStore(dir),
        chronicle: new JsonWorkspaceChronicleStore(dir),
      },
      {
        ...(flag("--project") ? { projectId: flag("--project")! } : {}),
        ...(await getDefaultWorker(dir).then((defaultWorkerId) => defaultWorkerId ? { defaultWorkerId } : {})),
      },
    );
    console.log(hasFlag("--json") ? JSON.stringify(view, null, 2) : renderOverview(view, { dir }));
    break;
  }
  case "status": {
    const view = await workspaceStatus(
      new JsonWorkspaceProjectionStore(dir),
      new JsonWorkspaceChronicleStore(dir),
      flag("--project") ? { projectId: flag("--project")! } : {},
    );
    printView(view, renderStatus);
    break;
  }
  case "task": {
    const id = positional[1];
    if (!id) fail("usage: cli task <id>");
    const view = await taskDetail(
      id!,
      new JsonWorkspaceEventStore(dir),
      new JsonWorkspaceProjectionStore(dir),
      new JsonWorkspaceChronicleStore(dir),
    );
    if (!view) {
      if (text) console.log(`no such task: ${id}`);
      else printJson({ error: "not_found", taskId: id });
      process.exit(1);
    }
    printView(view, renderTaskDetail);
    break;
  }
  case "chronicle": {
    const taskId = flag("--task");
    const nRaw = flag("-n");
    const limit = nRaw === undefined ? 30 : Number(nRaw);
    if (!Number.isFinite(limit)) fail(`-n must be a number (got "${nRaw}")`);
    const entries = await new JsonWorkspaceChronicleStore(dir).recent({ ...(taskId ? { taskId } : {}), limit });
    if (!text) {
      printJson(entries);
      break;
    }
    for (const e of entries)
      console.log(
        `${new Date(e.ts).toISOString().slice(11, 19)} ${e.type}${e.taskId ? ` ${e.taskId}` : ""} — ${e.summary}`,
      );
    break;
  }

  // ---- drive (constructs the engine; create/run reach DeepSeek) ------------
  case "create": {
    const request = positional[1];
    if (!request) fail("usage: cli create <request> [--workflow <id>] [--project <id>] [--id <id>]");
    const ws = await openWorkspace(dir);
    const projectId = flag("--project") ?? "default";
    const id = flag("--id");
    const workflowId = flag("--workflow");
    const workerId = flag("--worker");
    let task;
    try {
      if (workflowId) {
        const wf = ws.registry.get(workflowId);
        if (!wf) fail(`unknown workflow: ${workflowId}`);
        if (!wf!.fields.request)
          fail(
            `workflow "${workflowId}" has no 'request' field — omit --workflow to route via intake, or set fields with \`submit\` after creating`,
          );
        task = await ws.engine.createTask({
          projectId,
          workflowId,
          fields: { request: request! },
          wake: false,
          ...(id ? { taskId: id } : {}),
          ...(workerId ? { workerId } : {}),
        });
      } else {
        task = await ws.engine.intake(request!, {
          projectId,
          wake: false,
          ...(id ? { taskId: id } : {}),
          ...(workerId ? { workerId } : {}),
        });
      }
    } catch (err) {
      fail((err as Error).message, 1);
    }
    const result = {
      ok: true,
      task,
      next: { command: "run", taskId: task!.id, dir, argv: ["run", "--task", task!.id, "--dir", dir] },
    };
    if (text) {
      console.log(`created ${task!.id} → workflow "${task!.workflowId}" @ "${task!.stageId}" (${task!.status})`);
      console.log(`drive it: ${cli} run --task ${task!.id} --dir ${dir}`);
    } else {
      printJson(result);
    }
    break;
  }
  case "run": {
    const errors: string[] = [];
    const ws = await openWorkspace(dir, {
      hooks: { onError: ({ taskId, error }) => errors.push(`${taskId}: ${error.message}`) },
    });
    await ws.engine.runPending(flag("--task"));
    const view = await workspaceStatus(ws.projections, ws.chronicle);
    printView(view, renderStatus);
    if (errors.length) {
      for (const e of errors) console.error(`‼ ${e}`);
      process.exit(1);
    }
    break;
  }
  case "submit": {
    const id = positional[1];
    const op = positional[2];
    if (!id || !op) fail("usage: cli submit <id> <set-field <f> <v> | cancel [reason] | block <reason> | unblock>");
    const ws = await openWorkspace(dir);
    let command: Command;
    try {
      command = await buildSubmitCommand(ws, id!, op!, positional.slice(3));
    } catch (err) {
      fail((err as Error).message);
      throw err; // unreachable (fail exits) — satisfies definite assignment
    }
    try {
      await ws.engine.submitCommand(id!, command, "lead", { schedule: false });
    } catch (err) {
      fail((err as Error).message, 1);
    }
    if (text) console.log(`submitted ${op} to ${id} — apply with: ${cli} run --task ${id} --dir ${dir}`);
    else printJson({ ok: true, taskId: id, command, next: { command: "run", taskId: id, dir, argv: ["run", "--task", id, "--dir", dir] } });
    break;
  }
  case "register": {
    const file = positional[1];
    if (!file) fail("usage: cli register <workflow.yaml>");
    let def: unknown;
    try {
      def = parseDataFile(await readFile(file!, "utf8"), file!);
    } catch (err) {
      fail(`cannot read ${file}: ${(err as Error).message}`, 1);
    }
    try {
      await saveWorkflow(dir, def as Parameters<typeof saveWorkflow>[1]);
    } catch (err) {
      fail((err as Error).message, 1);
    }
    const d = def as { id: string; version: string };
    if (text) console.log(`registered workflow ${d.id}@${d.version}`);
    else printJson({ ok: true, workflowId: d.id, version: d.version });
    break;
  }
  case "project": {
    const sub = positional[1];
    if (sub === "list") {
      const list = await new JsonProjectStore(dir).list();
      if (!text) {
        printJson(list);
        break;
      }
      for (const p of list)
        console.log(
          `  ${p.id}  ${p.name}  root=${p.root}${p.defaultWorkflowId ? ` workflow=${p.defaultWorkflowId}` : ""}${p.defaultWorker ? ` worker=${p.defaultWorker}` : ""}${p.memory ? " memory=md" : ""}`,
        );
      break;
    }
    if (sub === "create") {
      const id = positional[2];
      if (!id || !isValidProjectId(id))
        fail("usage: cli project create <id> [--name <n>] [--root <path>] [--workflow <id>] [--model <m>]");
      const mode = permissionMode();
      const project: Project = {
        id: id!,
        name: flag("--name") ?? id!,
        root: flag("--root") ?? ".",
        ...(flag("--workflow") ? { defaultWorkflowId: flag("--workflow")! } : {}),
        ...(flag("--worker") ? { defaultWorker: flag("--worker")! } : {}),
        ...(mode ? { permissionMode: mode } : {}),
      };
      await new JsonProjectStore(dir).put(project);
      if (text) console.log(`created project ${project.id} (root ${project.root})`);
      else printJson({ ok: true, project });
      break;
    }
    if (sub === "memory") {
      const id = positional[2];
      if (!id || !isValidProjectId(id)) fail("usage: cli project memory <id> [markdown]");
      const projectId = id as string;
      const store = new JsonProjectStore(dir);
      const project = await store.get(projectId);
      if (!project) fail(`project "${projectId}" not found`, 1);
      const markdown = positional.slice(3).join(" ");
      if (markdown) {
        await store.putMemory(projectId, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
        if (text) console.log(`updated project memory ${projectId} (${store.memoryPath(projectId)})`);
        else printJson({ ok: true, projectId, path: store.memoryPath(projectId) });
      } else {
        const memory = await store.getMemory(projectId);
        if (text) console.log(memory);
        else printJson({ projectId, memory, path: store.memoryPath(projectId) });
      }
      break;
    }
    fail("usage: cli project <create <id> | list | memory <id> [markdown]>");
    break;
  }
  case "worker": {
    const sub = positional[1];
    if (sub === "discover") {
      const d = await discoverWorkers();
      if (!text) {
        printJson(d);
        break;
      }
      console.log("providers:");
      for (const p of d.providerDetails)
        console.log(
          `  ${p.id}: configured=${p.configured ? "yes" : "no"} ai-sdk=${p.aiSdkAvailable ? "yes" : "no"} env=${p.env.join("|")}`,
        );
      console.log("\nruntimes:");
      if (d.runtimeDetails.length === 0) console.log("  (none detected)");
      for (const r of d.runtimeDetails)
        console.log(`  ${r.id}: usableAsWorker=${r.usableAsWorker ? "yes" : "no"}${r.reason ? ` reason=${r.reason}` : ""}`);
      console.log("\ncompatibility:");
      if (d.compatibility.length === 0) console.log("  (no usable worker runtimes detected)");
      for (const c of d.compatibility) console.log(`  ${c.runtime}: providers=${c.providers.join(", ")}`);
      break;
    }
    if (sub === "list") {
      const list = await new JsonWorkerStore(dir).list();
      if (!text) {
        printJson(list);
        break;
      }
      const def = await getDefaultWorker(dir);
      if (list.length === 0) console.log("  (no workers — run `worker discover`)");
      for (const w of list)
        console.log(`  ${w.id}${w.id === def ? " *" : ""}  ${w.runtime}·${w.provider}·${w.model}  — ${w.description}`);
      break;
    }
    if (sub === "create") {
      const id = positional[2];
      if (!id || !isValidWorkerId(id))
        fail(
          "usage: cli worker create <id> --runtime <ai-sdk|claude-code> --provider <deepseek|anthropic|openai> --model <m> [--name <n>] [--desc <d>]",
        );
      const runtime = flag("--runtime");
      const provider = flag("--provider");
      const model = flag("--model");
      if (runtime !== "ai-sdk" && runtime !== "claude-code") fail("--runtime must be ai-sdk or claude-code");
      if (provider !== "deepseek" && provider !== "anthropic" && provider !== "openai")
        fail("--provider must be deepseek, anthropic, or openai");
      if (!model) fail("--model is required");
      const mode = permissionMode();
      const worker: Worker = {
        id: id!,
        name: flag("--name") ?? id!,
        description: flag("--desc") ?? "",
        runtime: runtime as WorkerRuntime,
        provider: provider as WorkerProvider,
        model: model!,
        ...(mode ? { permissionMode: mode } : {}),
      };
      await new JsonWorkerStore(dir).put(worker);
      if (text) console.log(`created worker ${worker.id} (${worker.runtime}·${worker.provider}·${worker.model})`);
      else printJson({ ok: true, worker });
      break;
    }
    if (sub === "default") {
      const id = positional[2];
      if (!id) fail("usage: cli worker default <id>");
      if (!(await new JsonWorkerStore(dir).get(id!))) fail(`worker "${id}" not found (create it first)`, 1);
      await setDefaultWorker(dir, id!);
      if (text) console.log(`default worker set to ${id}`);
      else printJson({ ok: true, defaultWorkerId: id });
      break;
    }
    fail("usage: cli worker <discover | create <id> … | list | default <id>>");
    break;
  }

  default:
    console.log(
      `wakespace CLI (dir: ${dir})\n\n` +
        "drive:\n" +
        "  create <request> [--workflow <id>] [--project <id>] [--worker <id>] [--id <id>]\n" +
        "  run [--task <id>]\n" +
        "  submit <id> <set-field <f> <v> | cancel [reason] | block <reason> | unblock>\n" +
        "  register <workflow.yaml>\n" +
        "  project create <id> [--name <n>] [--root <path>] [--workflow <id>] [--worker <id>] [--permission <mode>]\n" +
        "  project memory <id> [markdown]\n" +
        "  worker discover | create <id> --runtime <r> --provider <p> --model <m> [--desc <d>] [--permission <mode>] | default <id>\n" +
        "read:\n" +
        "  overview [--project <id>] [--json]     human dashboard (text by default)\n" +
        "  project list [--text]\n" +
        "  worker list [--text]\n" +
        "  status [--project <id>] [--text]\n" +
        "  task <id> [--text]\n" +
        "  chronicle [--task <id>] [-n <N>] [--text]\n" +
        "  --json is accepted for compatibility; agent-facing commands already default to JSON\n" +
        "  --dir <path>   workspace dir override ($WAKESPACE_HOME or ~/.wakespace by default; legacy $WAKESPACE_DIR still works)",
    );
    if (cmd && cmd !== "help") process.exit(2);
}
