#!/usr/bin/env bun
/**
 * sikong CLI — the surface a lead agent (Claude Code) drives the
 * workspace through (no MCP; agent-browser-style). Each command operates on the
 * durable workspace dir; `run` drives pending tasks' wakes to quiescence.
 * Metadata writes take an exclusive dir lock; long `run` commands use task
 * scope leases so independent tasks can overlap.
 *
 *   create <request> [--workflow <id>] [--project <id>] [--parent <id>] [--id <id>]   publish a task
 *   run [--task <id>]                                                 drive pending task(s) to done/quiet (exit 1 if any wake errored)
 *   submit <id> <set-field <f> <v> | transition [reason] | evidence <json> | accept <reason> | reject <reason> | steer <message> | cancel [reason] | block <reason> | concern <message> | scope-limit <message> | stop [reason] | unblock>
 *   register <workflow.yaml>                                          register a workflow definition
 *   overview [--project <id>] [--json]                                  human workspace dashboard
 *   status [--project <id>] [--text] | task <id> [--text] | trace <id> [--text] | chronicle [--task <id>] [-n N] [--text]
 *   inspect wait [--task <id>] [--after <seq>] [--timeout <ms>] [--text]
 *   --dir <path>   workspace dir override (default $SIKONG_HOME or ~/.sikong; legacy $SIKONG_DIR still works)
 *
 *   Agent-facing commands default to JSON. Use --text for ad-hoc human output.
 *
 *   set-field coerces by the field's declared type (string/enum kept literal;
 *   number/boolean/json JSON-parsed).
 */
import { unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  JsonProjectStore,
  JsonWorkerStore,
  JsonWorkspaceChronicleStore,
  JsonWorkspaceEventStore,
  JsonWorkspaceProjectionStore,
} from "./store";
import { renderLeadActions, renderOverview, renderStatus, renderTaskDetail, taskDetail, workspaceOverview, workspaceStatus } from "./inspect";
import { renderUsage, summarizeUsage } from "./usage";
import { acquireLock, getDefaultWorker, openWorkspace, reconcileWorktrees, saveWorkflow, setDefaultWorker, type Workspace } from "./workspace";
import { parseDataFile } from "./config-file";
import { chronicleLine, renderTrace, taskTrace } from "./cli-trace";
import { JsonSteerMailbox, type LeadMessageKind } from "./engine/steer-mailbox";
import { isValidProjectId, type Project } from "./project";
import { discoverWorkers, discoveredRoster, isValidWorkerId, type Worker, type WorkerProvider, type WorkerRuntime } from "./worker";
import type { WorkerPermissionMode } from "./worker";
import type { AcceptanceCheck, AcceptanceEvidence, Command } from "./workflow";
import { resolveWorkspaceDir } from "./workspace-layout";

const VALUE_FLAGS = new Set([
  "--dir", "--project", "--workflow", "--id", "--task", "-n",
  "--root", "--name", "--model", "--worker", "--runtime", "--provider", "--desc",
  "--permission", "--permission-mode", "--wake-timeout",
  "--after", "--timeout", "--poll",
  "--parent", "--interval",
  "--frame", "--ref",
  "--acceptance",
  "--read-scope", "--write-scope",
]);
const BOOL_FLAGS = new Set(["--json", "--text", "--human", "--once"]);
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
const LEAD_MESSAGE_OPS = new Set(["steer", "cancel", "block", "concern", "scope-limit", "stop"]);
const isLeadMessageSubmit = cmd === "submit" && LEAD_MESSAGE_OPS.has(positional[2] ?? "");
const argv1 = process.argv[1] ?? "sikong";
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function parseNonNegativeNumber(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) fail(`${name} must be a non-negative number (got "${raw}")`);
  return n;
}

function parseScopeList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((scope) => scope.trim()).filter(Boolean);
}

async function waitForNextChronicleEvent(
  store: JsonWorkspaceChronicleStore,
  opts: { taskId?: string; afterSeq?: number; timeoutMs: number; pollMs: number },
) {
  const startedAt = Date.now();
  const baseline =
    opts.afterSeq ??
    ((await store.recent({ ...(opts.taskId ? { taskId: opts.taskId } : {}), limit: 1 }))[0]?.seq ?? 0);
  const deadline = startedAt + opts.timeoutMs;
  while (true) {
    const entries = await store.recent({ ...(opts.taskId ? { taskId: opts.taskId } : {}), limit: 200 });
    const next = entries
      .filter((entry) => entry.seq > baseline)
      .sort((a, b) => a.seq - b.seq || a.ts - b.ts)[0];
    if (next) return { event: next, afterSeq: baseline, waitedMs: Date.now() - startedAt };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { event: null, afterSeq: baseline, waitedMs: Date.now() - startedAt };
    await sleep(Math.min(opts.pollMs, remaining));
  }
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
    case "transition":
    case "request-transition":
      return { kind: "request_transition", ...(rest.length ? { reason: rest.join(" ") } : {}) };
    case "unblock":
      return { kind: "unblock" };
    case "accept": {
      const reason = rest.join(" ");
      if (!reason) throw new Error("accept needs <reason>");
      return { kind: "acceptance_decision", decision: "accepted", reason };
    }
    case "reject": {
      const reason = rest.join(" ");
      if (!reason) throw new Error("reject needs <reason>");
      return { kind: "acceptance_decision", decision: "rejected", reason };
    }
    case "evidence": {
      const raw = rest.join(" ");
      if (!raw) throw new Error("evidence needs <json>");
      let evidence: unknown;
      try {
        evidence = JSON.parse(raw);
      } catch {
        throw new Error("evidence must be a JSON object");
      }
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
        throw new Error("evidence must be a JSON object");
      return { kind: "submit_evidence", evidence: evidence as AcceptanceEvidence };
    }
    case "steer": {
      const message = rest.join(" ").trim();
      if (!message) throw new Error("steer needs <message>");
      return { kind: "steer", message };
    }
    default:
      throw new Error(`unknown submit op "${op}" (set-field | transition | evidence | accept | reject | steer | cancel | block | unblock)`);
  }
}

function leadMessageFromSubmit(
  op: string,
  rest: string[],
): { kind: LeadMessageKind; message: string; command: Command | { kind: LeadMessageKind; message: string } } {
  const message = rest.join(" ").trim();
  switch (op) {
    case "steer":
      if (!message) throw new Error("steer needs <message>");
      return { kind: "steer", message, command: { kind: "steer", message } };
    case "cancel": {
      const reason = message || "operator requested cancellation review";
      return {
        kind: "stop_requested",
        message: `Cancellation requested for lead review: ${reason}`,
        command: { kind: "stop_requested", message: reason },
      };
    }
    case "block":
      if (!message) throw new Error("block needs <reason>");
      return {
        kind: "stop_requested",
        message: `Block requested for lead review: ${message}`,
        command: { kind: "stop_requested", message },
      };
    case "concern":
      if (!message) throw new Error("concern needs <message>");
      return { kind: "concern", message, command: { kind: "concern", message } };
    case "scope-limit":
      if (!message) throw new Error("scope-limit needs <message>");
      return { kind: "scope_limit", message, command: { kind: "scope_limit", message } };
    case "stop": {
      const reason = message || "operator requested wake stop for lead review";
      return { kind: "stop_requested", message: reason, command: { kind: "stop_requested", message: reason } };
    }
    default:
      throw new Error(`unknown lead message op "${op}"`);
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

// Metadata/state commands take the dir's exclusive write lock (released on
// process exit). `run` intentionally does not: long worker wakes are controlled
// by task scope leases, while short store writes use file-level locks.
const WRITE_CMDS = new Set(["create", "design", "release", "submit", "register", "visual-design"]);
const needsLock =
  (!!cmd && WRITE_CMDS.has(cmd) && !isLeadMessageSubmit) ||
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
        events: new JsonWorkspaceEventStore(dir),
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
      {
        ...(flag("--project") ? { projectId: flag("--project")! } : {}),
        events: new JsonWorkspaceEventStore(dir),
      },
    );
    printView(view, renderStatus);
    break;
  }
  case "actions": {
    const view = await workspaceStatus(
      new JsonWorkspaceProjectionStore(dir),
      new JsonWorkspaceChronicleStore(dir),
      {
        ...(flag("--project") ? { projectId: flag("--project")! } : {}),
        events: new JsonWorkspaceEventStore(dir),
      },
    );
    if (text) console.log(renderLeadActions(view.pendingLeadActions));
    else printJson({ total: view.pendingLeadActions.length, actions: view.pendingLeadActions });
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
    for (const e of entries) console.log(chronicleLine(e));
    break;
  }
  case "trace": {
    const taskId = positional[1] ?? flag("--task") ?? fail("usage: cli trace <id> [--text]");
    const view = await taskTrace(taskId, {
      projections: new JsonWorkspaceProjectionStore(dir),
      chronicle: new JsonWorkspaceChronicleStore(dir),
    });
    if (!view.task) {
      if (text) console.log(`no such task: ${taskId}`);
      else printJson({ error: "not_found", taskId });
      process.exit(1);
    }
    printView(view, renderTrace);
    break;
  }
  case "usage": {
    const projectId = flag("--project");
    const allEntries = await new JsonWorkspaceChronicleStore(dir).recent({
      type: ["wake.end", "wake.error"],
      limit: 1_000_000,
    });
    const tasks = await new JsonWorkspaceProjectionStore(dir).query();
    const taskProject = new Map(tasks.map((t) => [t.id, t.projectId] as const));
    let entries = allEntries;
    if (projectId) {
      const ids = new Set(tasks.filter((t) => t.projectId === projectId).map((t) => t.id));
      entries = allEntries.filter((e) => e.taskId !== undefined && ids.has(e.taskId));
    }
    const report = summarizeUsage(entries, taskProject, Date.now());
    if (!text) {
      printJson(report);
      break;
    }
    console.log(renderUsage(report, projectId ? { scope: `project ${projectId}` } : {}));
    break;
  }
  case "watch": {
    // Live terminal dashboard: overview + token/cost + recent activity, redrawn
    // every interval. Read-only (polls ~/.sikong); ctrl-c to exit. `--once`
    // renders a single frame (scriptable / testable).
    const intervalSec = Math.max(1, Number(flag("--interval") ?? "3"));
    const projectId = flag("--project");
    const once = hasFlag("--once");
    const projectsStore = new JsonProjectStore(dir);
    const workersStore = new JsonWorkerStore(dir);
    const projectionsStore = new JsonWorkspaceProjectionStore(dir);
    const chronicleStore = new JsonWorkspaceChronicleStore(dir);
    const defaultWorkerId = await getDefaultWorker(dir);
    const tick = async () => {
      const overview = await workspaceOverview(
        { projects: projectsStore, workers: workersStore, projections: projectionsStore, chronicle: chronicleStore },
        {
          ...(projectId ? { projectId } : {}),
          ...(defaultWorkerId ? { defaultWorkerId } : {}),
          activityLimit: 8,
        },
      );
      const tasks = await projectionsStore.query();
      const taskProject = new Map(tasks.map((t) => [t.id, t.projectId] as const));
      const all = await chronicleStore.recent({ type: ["wake.end", "wake.error"], limit: 1_000_000 });
      const entries = projectId
        ? all.filter((e) => e.taskId !== undefined && taskProject.get(e.taskId) === projectId)
        : all;
      const usageReport = summarizeUsage(entries, taskProject, Date.now());
      if (!once) process.stdout.write("\x1b[2J\x1b[H");
      console.log(
        `sikong watch — ${new Date().toLocaleTimeString()}${once ? "" : ` · every ${intervalSec}s · ctrl-c to exit`}\n`,
      );
      console.log(renderOverview(overview, { dir }));
      console.log("\n" + renderUsage(usageReport, projectId ? { scope: `project ${projectId}` } : {}));
    };
    await tick();
    if (once) break;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => void tick().catch(() => {}), intervalSec * 1000);
      process.on("SIGINT", () => {
        clearInterval(timer);
        resolve();
      });
    });
    break;
  }
  case "inspect": {
    const sub = positional[1];
    if (sub !== "wait") fail("usage: cli inspect wait [--task <id>] [--after <seq>] [--timeout <ms>] [--text]");
    const afterRaw = flag("--after");
    const afterSeq = afterRaw === undefined ? undefined : parseNonNegativeNumber(afterRaw, "--after", 0);
    const timeoutMs = parseNonNegativeNumber(flag("--timeout"), "--timeout", 30_000);
    const pollMs = Math.max(10, parseNonNegativeNumber(flag("--poll"), "--poll", 250));
    const taskId = flag("--task");
    const result = await waitForNextChronicleEvent(new JsonWorkspaceChronicleStore(dir), {
      ...(taskId ? { taskId } : {}),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      timeoutMs,
      pollMs,
    });
    if (result.event) {
      if (text) console.log(chronicleLine(result.event));
      else printJson({ ok: true, timedOut: false, ...result });
      break;
    }
    if (text) console.log(`timeout waiting for chronicle event after seq ${result.afterSeq}`);
    else printJson({ ok: false, timedOut: true, afterSeq: result.afterSeq, waitedMs: result.waitedMs, timeoutMs });
    process.exit(124);
    break;
  }

  // ---- drive (constructs the engine; create/run reach DeepSeek) ------------
  case "create": {
    const request = positional[1];
    if (!request) fail("usage: cli create <request> [--workflow <id>] [--project <id>] [--parent <id>] [--id <id>] [--acceptance '<json-array>']");
    const ws = await openWorkspace(dir);
    const projectId = flag("--project") ?? "default";
    const id = flag("--id");
    const workflowId = flag("--workflow");
    const workerId = flag("--worker");
    const parentId = flag("--parent");
    const readScopes = parseScopeList(flag("--read-scope"));
    const writeScopes = parseScopeList(flag("--write-scope"));
    const scopes =
      readScopes.length || writeScopes.length
        ? { ...(readScopes.length ? { read: readScopes } : {}), ...(writeScopes.length ? { write: writeScopes } : {}) }
        : undefined;
    let acceptance: unknown = undefined;
    const acceptanceRaw = flag("--acceptance");
    if (acceptanceRaw !== undefined) {
      try { acceptance = JSON.parse(acceptanceRaw); } catch {
        fail(`--acceptance must be valid JSON, got: ${acceptanceRaw.slice(0, 80)}`);
      }
      if (!Array.isArray(acceptance))
        fail("--acceptance must be a JSON array of acceptance checks");
    }
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
          ...(parentId ? { parentId } : {}),
          ...(scopes ? { scopes } : {}),
          ...(Array.isArray(acceptance) && acceptance.length ? { acceptance: acceptance as AcceptanceCheck[] } : {}),
        });
      } else {
        task = await ws.engine.intake(request!, {
          projectId,
          wake: false,
          ...(id ? { taskId: id } : {}),
          ...(workerId ? { workerId } : {}),
          ...(parentId ? { parentId } : {}),
          ...(scopes ? { scopes } : {}),
          ...(Array.isArray(acceptance) && acceptance.length ? { acceptance: acceptance as AcceptanceCheck[] } : {}),
        });
      }
    } catch (err) {
      fail((err as Error).message, 1);
    }
    // Guardrail (ADR 0009 dogfood finding): a write-class workflow (one that staffs
    // a coding team — i.e. declares a workerRole) run against the current directory
    // means the team will edit files HERE. Warn so it's never a surprise.
    const createdWf = ws.registry.get(task!.workflowId);
    const createdProject = await ws.projects.get(projectId);
    if (createdWf?.workerRole && resolve(createdProject?.root ?? ".") === resolve(process.cwd())) {
      console.error(
        `⚠ workflow "${task!.workflowId}" staffs a coding team that edits the project, and project "${projectId}" root is the current directory (${resolve(createdProject?.root ?? ".")}). Running this task will modify files here. To target a specific directory, \`project create <id> --root <path>\` then pass --project <id>.`,
      );
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
    const wakeTimeoutFlag = flag("--wake-timeout"); // seconds; explicit override for adaptive wake timeout
    const ws = await openWorkspace(dir, {
      hooks: { onError: ({ taskId, error }) => errors.push(`${taskId}: ${error.message}`) },
      ...(wakeTimeoutFlag ? { wakeTimeoutMs: Math.max(1, Number(wakeTimeoutFlag)) * 1000 } : {}),
    });
    await ws.engine.runPending(flag("--task"));
    await reconcileWorktrees(ws, dir).catch(() => {}); // reclaim leftover isolation worktrees (ADR 0010)
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
    if (!id || !op) fail("usage: cli submit <id> <set-field <f> <v> | transition [reason] | evidence <json> | accept <reason> | reject <reason> | steer <message> | cancel [reason] | block <reason> | concern <message> | scope-limit <message> | stop [reason] | unblock>");
    const taskId = id as string;
    const submitOp = op as string;
    if (LEAD_MESSAGE_OPS.has(submitOp)) {
      const leadMessage = ((): ReturnType<typeof leadMessageFromSubmit> => {
        try {
          return leadMessageFromSubmit(submitOp, positional.slice(3));
        } catch (err) {
          return fail((err as Error).message);
        }
      })();
      const task = await new JsonWorkspaceProjectionStore(dir).get(taskId);
      if (!task) fail(`task ${taskId} not found`, 1);
      await new JsonSteerMailbox(dir).submit(taskId, leadMessage.message, leadMessage.kind);
      const note =
        leadMessage.kind === "stop_requested"
          ? "current wake will stop for lead review if one is running; task state is not directly changed"
          : "lead will review this message before task topology changes";
      if (text) console.log(`submitted ${leadMessage.kind} to ${taskId} — ${note}`);
      else printJson({ ok: true, taskId, command: leadMessage.command, next: { note } });
      break;
    }
    const ws = await openWorkspace(dir);
    let command: Command;
    try {
      command = await buildSubmitCommand(ws, taskId, submitOp, positional.slice(3));
    } catch (err) {
      fail((err as Error).message);
      throw err; // unreachable (fail exits) — satisfies definite assignment
    }
    try {
      await ws.engine.submitCommand(taskId, command, "lead", { schedule: false });
    } catch (err) {
      fail((err as Error).message, 1);
    }
    if (text)
      console.log(
        command.kind === "steer"
          ? `submitted steer to ${taskId} — an active wake will receive it if one is running`
          : `submitted ${submitOp} to ${taskId} — apply with: ${cli} run --task ${taskId} --dir ${dir}`,
      );
    else
      printJson({
        ok: true,
        taskId,
        command,
        ...(command.kind === "steer"
          ? { next: { note: "active wake will receive this steer if one is running" } }
          : { next: { command: "run", taskId, dir, argv: ["run", "--task", taskId, "--dir", dir] } }),
      });
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
      // The effective roster sikong hires from: explicit workers, or — when none
      // are registered — the environment-discovered ones (ADR 0008).
      const explicit = await new JsonWorkerStore(dir).list();
      const auto = explicit.length === 0;
      const list = auto ? await discoveredRoster() : explicit;
      if (!text) {
        printJson({ source: auto ? "discovered" : "registered", workers: list });
        break;
      }
      const def = await getDefaultWorker(dir);
      if (list.length === 0)
        console.log(
          "  (no hireable worker — set a provider key like DEEPSEEK_API_KEY/ANTHROPIC_API_KEY or install `claude`, then re-run; or `worker create` one)",
        );
      else if (auto)
        console.log("  (auto-discovered from the environment — sikong hires from these; `worker create` to pin explicit ones)");
      for (const w of list)
        console.log(
          `  ${w.id}${w.id === def ? " *" : ""}  ${w.runtime}·${w.provider}·${w.model}  roles=${(w.roles ?? []).join("|") || "(runtime default)"}  — ${w.description}`,
        );
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

  case "design": {
    const request = positional[1];
    if (!request) fail("usage: cli design <request> [--project <id>] [--id <id>] [--worker <id>] [--parent <id>]");
    const ws = await openWorkspace(dir);
    const projectId = flag("--project") ?? "default";
    const id = flag("--id");
    const workerId = flag("--worker");
    const parentId = flag("--parent");
    const fields: Record<string, unknown> = { request };
    let task;
    try {
      const wf = ws.registry.get("design");
      if (!wf) fail("built-in 'design' workflow not found");
      task = await ws.engine.createTask({
        projectId,
        workflowId: "design",
        fields,
        wake: false,
        ...(id ? { taskId: id } : {}),
        ...(workerId ? { workerId } : {}),
        ...(parentId ? { parentId } : {}),
      });
    } catch (err) {
      fail((err as Error).message, 1);
    }
    const result = {
      ok: true,
      task,
      next: { command: "run", taskId: task!.id, dir, argv: ["run", "--task", task!.id, "--dir", dir] },
    };
    if (text) {
      console.log(`created ${task!.id} → workflow "design" @ "${task!.stageId}" (${task!.status})`);
      console.log(`drive it: ${cli} run --task ${task!.id} --dir ${dir}`);
    } else {
      printJson(result);
    }
    break;
  }

  case "visual-design": {
    const request = positional[1];
    if (!request) fail("usage: cli visual-design <request> [--project <id>] [--id <id>] [--worker <id>] [--parent <id>] [--frame <text>]");
    const ws = await openWorkspace(dir);
    const projectId = flag("--project") ?? "default";
    const id = flag("--id");
    const workerId = flag("--worker");
    const parentId = flag("--parent");
    const frame = flag("--frame");
    const fields: Record<string, unknown> = { request };
    if (frame) fields.frame = frame;
    let task;
    try {
      const wf = ws.registry.get("visual-design");
      if (!wf) fail("built-in 'visual-design' workflow not found");
      task = await ws.engine.createTask({
        projectId,
        workflowId: "visual-design",
        fields,
        wake: false,
        ...(id ? { taskId: id } : {}),
        ...(workerId ? { workerId } : {}),
        ...(parentId ? { parentId } : {}),
      });
    } catch (err) {
      fail((err as Error).message, 1);
    }
    // Guardrail (ADR 0009): warn when write-class workflow targets cwd.
    const createdProject = await ws.projects.get(projectId);
    if (resolve(createdProject?.root ?? ".") === resolve(process.cwd())) {
      console.error(
        `⚠ visual-design workflow staffs a coding team that edits the project, and project "${projectId}" root is the current directory (${resolve(createdProject?.root ?? ".")}). Running this task will modify files here. To target a specific directory, \`project create <id> --root <path>\` then pass --project <id>.`,
      );
    }
    const result = {
      ok: true,
      task,
      next: { command: "run", taskId: task!.id, dir, argv: ["run", "--task", task!.id, "--dir", dir] },
    };
    if (text) {
      console.log(`created ${task!.id} → workflow "visual-design" @ "${task!.stageId}" (${task!.status})`);
      if (frame) console.log(`  frame: ${frame.slice(0, 80)}${frame.length > 80 ? "…" : ""}`);
      console.log(`drive it: ${cli} run --task ${task!.id} --dir ${dir}`);
    } else {
      printJson(result);
    }
    break;
  }

  case "release": {
    const request = positional[1];
    if (!request) fail("usage: cli release <request> [--project <id>] [--id <id>] [--worker <id>] [--parent <id>] [--ref <ref>]");
    const ws = await openWorkspace(dir);
    const projectId = flag("--project") ?? "default";
    const id = flag("--id");
    const workerId = flag("--worker");
    const parentId = flag("--parent");
    const releaseRef = flag("--ref");
    const fields: Record<string, unknown> = { request };
    if (releaseRef) fields.releaseRef = releaseRef;
    let task;
    try {
      const wf = ws.registry.get("release");
      if (!wf) fail("built-in 'release' workflow not found");
      task = await ws.engine.createTask({
        projectId,
        workflowId: "release",
        fields,
        wake: false,
        ...(id ? { taskId: id } : {}),
        ...(workerId ? { workerId } : {}),
        ...(parentId ? { parentId } : {}),
      });
    } catch (err) {
      fail((err as Error).message, 1);
    }
    // Guardrail (ADR 0009): warn when write-class workflow targets cwd.
    const createdProject = await ws.projects.get(projectId);
    if (resolve(createdProject?.root ?? ".") === resolve(process.cwd())) {
      console.error(
        `⚠ release workflow staffs a coding team that edits the project, and project "${projectId}" root is the current directory (${resolve(createdProject?.root ?? ".")}). Running this task will modify files here. To target a specific directory, \`project create <id> --root <path>\` then pass --project <id>.`,
      );
    }
    const result = {
      ok: true,
      task,
      next: { command: "run", taskId: task!.id, dir, argv: ["run", "--task", task!.id, "--dir", dir] },
    };
    if (text) {
      console.log(`created ${task!.id} → workflow "release" @ "${task!.stageId}" (${task!.status})`);
      if (releaseRef) console.log(`  release ref: ${releaseRef}`);
      console.log(`drive it: ${cli} run --task ${task!.id} --dir ${dir}`);
    } else {
      printJson(result);
    }
    break;
  }

  default:
    console.log(
      `sikong CLI (dir: ${dir})\n\n` +
        "drive:\n" +
        "  create <request> [--workflow <id>] [--project <id>] [--worker <id>] [--parent <id>] [--id <id>] [--read-scope a,b] [--write-scope x,y]\n" +
        "  design <request> [--project <id>] [--id <id>] [--worker <id>] [--parent <id>]\n" +
        "                                                               shorthand for --workflow design (generic technical blueprint design)\n" +
        "  visual-design <request> [--project <id>] [--id <id>] [--worker <id>] [--parent <id>] [--frame <text>]\n" +
        "                                                               shorthand for --workflow visual-design; --frame pre-fills the design frame (ADR 0028)\n" +
        "  release <request> [--project <id>] [--id <id>] [--worker <id>] [--parent <id>] [--ref <ref>]\n" +
        "                                                               shorthand for --workflow release; --ref pre-fills the releaseRef field\n" +
        "  run [--task <id>]\n" +
        "  submit <id> <set-field <f> <v> | transition [reason] | evidence <json> | accept <reason> | reject <reason> | steer <message> | cancel [reason] | block <reason> | concern <message> | scope-limit <message> | stop [reason] | unblock>\n" +
        "                                                               cancel/block/concern/scope-limit/stop are operator messages for lead review; they do not directly mutate task topology\n" +
        "  register <workflow.yaml>\n" +
        "  project create <id> [--name <n>] [--root <path>] [--workflow <id>] [--worker <id>] [--permission <mode>]\n" +
        "  project memory <id> [markdown]\n" +
        "  worker discover | create <id> --runtime <r> --provider <p> --model <m> [--desc <d>] [--permission <mode>] | default <id>\n" +
      "read:\n" +
      "  overview [--project <id>] [--json]     human dashboard (text by default)\n" +
      "  project list [--text]\n" +
      "  worker list [--text]\n" +
      "  status [--project <id>] [--text]\n" +
      "  actions [--project <id>] [--text]     pending lead review/decision queue\n" +
      "  task <id> [--text]\n" +
      "  trace <id> [--text]                    one-task wake/tool/state-command trace\n" +
      "  chronicle [--task <id>] [-n <N>] [--text]\n" +
      "  usage [--project <id>] [--text]        token usage + cost (5h/7d/30d windows)\n" +
      "  watch [--project <id>] [--interval <s>] [--once]   live dashboard (overview + usage)\n" +
      "  inspect wait [--task <id>] [--after <seq>] [--timeout <ms>] [--text]\n" +
      "  --json is accepted for compatibility; agent-facing commands already default to JSON\n" +
        "  --dir <path>   workspace dir override ($SIKONG_HOME or ~/.sikong by default; legacy $SIKONG_DIR still works)",
    );
    if (cmd && cmd !== "help") process.exit(2);
}
