import {
  addWorkspacePreference,
  acceptPlan,
  acceptStageReview,
  acceptTask,
  completeWorkerRun,
  createTask,
  createWorkspace,
  deleteWorkspace,
  exceedWorkerRunBudget,
  failWorkerRun,
  getTask,
  getWorkspace,
  inspectTaskCompact,
  inspectTaskEvents,
  inspectTaskProjection,
  inspectTaskSummary,
  inspectTaskTrace,
  listWorkspacePreferences,
  listWorkspaces,
  recommendFinalReview,
  rejectPlan,
  rejectStageReview,
  rejectTask,
  removeWorkspacePreference,
  startStageReview,
  startWorkerRun,
  submitPlan,
  type CommandContext,
  type CommandResult,
  type FinishWorkerRunInput,
  type SubmitPlanInput,
} from "../commands";
import { resolveDataDir } from "../data-dir";

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

type CliCommandData = Record<string, unknown>;

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliRunResult> {
  try {
    const parsed = parseArgs(argv);
    if (flag(parsed, "help") || flag(parsed, "h")) return text(0, usage());
    if (flag(parsed, "version") || flag(parsed, "v")) {
      return text(0, JSON.stringify({ ok: true, data: { version: "0.0.0" } }) + "\n");
    }

    const dataDir = value(parsed, "data-dir");
    const workspaceId = value(parsed, "workspace");
    const outputMode = flag(parsed, "text") ? "text" : "json";
    const ctx: CommandContext = {
      dataDir: resolveDataDir({ dataDir, env }).dir,
      ...(workspaceId ? { workspaceId } : {}),
      outputMode,
    };

    const result = await dispatch(ctx, parsed);
    return render(result, outputMode);
  } catch (err) {
    return render(
      {
        ok: false,
        error: {
          code: "invalid_input",
          message: err instanceof Error ? err.message : String(err),
        },
      },
      "json",
    );
  }
}

async function dispatch(
  ctx: CommandContext,
  parsed: ParsedArgs,
): Promise<CommandResult<CliCommandData>> {
  const [resource, action, arg] = parsed.positionals;

  if (!resource) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "Command is required." },
    };
  }

  if (resource === "workspace") {
    if (action === "create") {
      return createWorkspace(ctx, {
        id: required(value(parsed, "id"), "--id is required."),
        name: required(value(parsed, "name"), "--name is required."),
      });
    }
    if (action === "list") return listWorkspaces(ctx);
    if (action === "show")
      return getWorkspace(ctx, { workspaceId: required(arg, "workspace id is required.") });
    if (action === "delete") {
      return deleteWorkspace(ctx, { workspaceId: required(arg, "workspace id is required.") });
    }
  }

  if (resource === "preference") {
    if (action === "list")
      return listWorkspacePreferences(ctx, { workspaceId: value(parsed, "workspace") });
    if (action === "add") {
      return addWorkspacePreference(ctx, {
        workspaceId: value(parsed, "workspace"),
        text: required(value(parsed, "text") ?? arg, "--text is required."),
        note: value(parsed, "note"),
      });
    }
    if (action === "remove") {
      return removeWorkspacePreference(ctx, {
        workspaceId: value(parsed, "workspace"),
        preferenceId: required(arg, "preference id is required."),
      });
    }
  }

  if (resource === "task") {
    if (action === "create") {
      return createTask(ctx, {
        workspaceId: value(parsed, "workspace"),
        request: required(value(parsed, "request") ?? arg, "--request is required."),
        cwd: value(parsed, "cwd"),
        repoPath: value(parsed, "repo"),
      });
    }
    if (action === "show")
      return getTask(ctx, {
        workspaceId: value(parsed, "workspace"),
        taskId: required(arg, "task id is required."),
      });
    if (action === "submit-plan") {
      return submitPlan(ctx, {
        ...taskInput(parsed, arg),
        ...parsePlanJson(required(value(parsed, "plan-json"), "--plan-json is required.")),
      });
    }
    if (action === "accept-plan") {
      return acceptPlan(ctx, {
        ...taskInput(parsed, arg),
        planId: required(value(parsed, "plan"), "--plan is required."),
        version: requiredNumber(value(parsed, "version"), "--version is required."),
        report: required(value(parsed, "report"), "--report is required."),
      });
    }
    if (action === "reject-plan") {
      return rejectPlan(ctx, {
        ...taskInput(parsed, arg),
        planId: required(value(parsed, "plan"), "--plan is required."),
        version: requiredNumber(value(parsed, "version"), "--version is required."),
        report: required(value(parsed, "report"), "--report is required."),
        requestedChanges: value(parsed, "requested-changes"),
      });
    }
    if (action === "start-worker") {
      return startWorkerRun(ctx, {
        ...taskInput(parsed, arg),
        stageId: value(parsed, "stage"),
        workerId: value(parsed, "worker"),
        objective: value(parsed, "objective"),
      });
    }
    if (action === "complete-worker") {
      return completeWorkerRun(ctx, workerResultInput(parsed, arg));
    }
    if (action === "fail-worker") {
      return failWorkerRun(ctx, workerResultInput(parsed, arg));
    }
    if (action === "exceed-worker-budget") {
      return exceedWorkerRunBudget(ctx, workerResultInput(parsed, arg));
    }
    if (action === "start-stage-review") {
      return startStageReview(ctx, { ...taskInput(parsed, arg), stageId: value(parsed, "stage") });
    }
    if (action === "accept-stage-review") {
      return acceptStageReview(ctx, {
        ...taskInput(parsed, arg),
        reviewId: required(value(parsed, "review"), "--review is required."),
        report: required(value(parsed, "report"), "--report is required."),
      });
    }
    if (action === "reject-stage-review") {
      return rejectStageReview(ctx, {
        ...taskInput(parsed, arg),
        reviewId: required(value(parsed, "review"), "--review is required."),
        report: required(value(parsed, "report"), "--report is required."),
        requestedChanges: value(parsed, "requested-changes"),
      });
    }
    if (action === "recommend-final-review") {
      return recommendFinalReview(ctx, {
        ...taskInput(parsed, arg),
        reviewId: required(value(parsed, "review"), "--review is required."),
        recommendation: recommendation(value(parsed, "recommendation")),
        report: required(value(parsed, "report"), "--report is required."),
      });
    }
    if (action === "accept") {
      return acceptTask(ctx, {
        ...taskInput(parsed, arg),
        report: required(value(parsed, "report"), "--report is required."),
      });
    }
    if (action === "reject") {
      return rejectTask(ctx, {
        ...taskInput(parsed, arg),
        report: required(value(parsed, "report"), "--report is required."),
      });
    }
  }

  if (resource === "inspect") {
    const taskId = required(arg, "task id is required.");
    if (action === "summary")
      return inspectTaskSummary(ctx, { workspaceId: value(parsed, "workspace"), taskId });
    if (action === "compact")
      return inspectTaskCompact(ctx, { workspaceId: value(parsed, "workspace"), taskId });
    if (action === "events")
      return inspectTaskEvents(ctx, { workspaceId: value(parsed, "workspace"), taskId });
    if (action === "projection") {
      return inspectTaskProjection(ctx, { workspaceId: value(parsed, "workspace"), taskId });
    }
    if (action === "trace") {
      return inspectTaskTrace(ctx, {
        workspaceId: value(parsed, "workspace"),
        taskId,
        follow: Boolean(flag(parsed, "follow")),
      });
    }
  }

  return {
    ok: false,
    error: {
      code: "invalid_input",
      message: `Unknown command: ${parsed.positionals.join(" ")}`,
    },
  };
}

function render(result: CommandResult<unknown>, outputMode: "json" | "text"): CliRunResult {
  if (outputMode === "text") {
    if (!result.ok) return text(1, "", `${result.error.code}: ${result.error.message}\n`);
    return text(0, `${JSON.stringify(result.data, null, 2)}\n`);
  }
  return text(result.ok ? 0 : 1, `${JSON.stringify(result)}\n`);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = String(argv[index] ?? "");
    if (!token) continue;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const raw = token.replace(/^-+/, "");
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      flags[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }

    const next = argv[index + 1] === undefined ? undefined : String(argv[index + 1]);
    if (next && !next.startsWith("-")) {
      flags[raw] = next;
      index += 1;
    } else {
      flags[raw] = true;
    }
  }
  return { positionals, flags };
}

function value(parsed: ParsedArgs, name: string): string | undefined {
  const raw = parsed.flags[name];
  return typeof raw === "string" ? raw : undefined;
}

function flag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function requiredNumber(value: string | undefined, message: string): number {
  const raw = required(value, message);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(message);
  return parsed;
}

function taskInput(
  parsed: ParsedArgs,
  taskId: string | undefined,
): { workspaceId?: string; taskId: string } {
  return {
    workspaceId: value(parsed, "workspace"),
    taskId: required(taskId, "task id is required."),
  };
}

function parsePlanJson(text: string): Pick<SubmitPlanInput, "summary" | "stages"> {
  const parsed = parseJson(text, "--plan-json must be a JSON object.");
  if (!Array.isArray(parsed.stages)) throw new Error("--plan-json.stages must be an array.");
  return {
    ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
    stages: parsed.stages.map((stage, index) => {
      if (!isRecord(stage)) throw new Error(`--plan-json.stages[${index}] must be an object.`);
      if (!Array.isArray(stage.acceptance)) {
        throw new Error(`--plan-json.stages[${index}].acceptance must be an array.`);
      }
      return {
        title: stringField(stage, "title", `--plan-json.stages[${index}].title is required.`),
        objective: stringField(
          stage,
          "objective",
          `--plan-json.stages[${index}].objective is required.`,
        ),
        acceptance: stage.acceptance.map((item) => {
          if (typeof item !== "string") {
            throw new Error(`--plan-json.stages[${index}].acceptance must contain strings.`);
          }
          return item;
        }),
      };
    }),
  };
}

function workerResultInput(parsed: ParsedArgs, taskId: string | undefined): FinishWorkerRunInput {
  return {
    ...taskInput(parsed, taskId),
    runId: required(value(parsed, "run"), "--run is required."),
    ...parseResultJson(required(value(parsed, "result-json"), "--result-json is required.")),
  };
}

function parseResultJson(text: string): Pick<FinishWorkerRunInput, "summary" | "report" | "note"> {
  const parsed = parseJson(text, "--result-json must be a JSON object.");
  return {
    summary: stringField(parsed, "summary", "--result-json.summary is required."),
    ...(typeof parsed.report === "string" ? { report: parsed.report } : {}),
    ...(typeof parsed.note === "string" ? { note: parsed.note } : {}),
  };
}

function parseJson(text: string, message: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error(message);
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(message);
    throw err;
  }
}

function stringField(record: Record<string, unknown>, key: string, message: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recommendation(value: string | undefined): "accept" | "reject" {
  if (value === "accept" || value === "reject") return value;
  throw new Error("--recommendation must be accept or reject.");
}

function text(exitCode: number, stdout = "", stderr = ""): CliRunResult {
  return { exitCode, stdout, stderr };
}

function usage(): string {
  return `sikong

Usage:
  sikong --data-dir <path> workspace create --id <id> --name <name>
  sikong workspace list
  sikong workspace show <workspaceId>
  sikong workspace delete <workspaceId>
  sikong preference list --workspace <workspaceId>
  sikong preference add --workspace <workspaceId> --text <text>
  sikong preference remove --workspace <workspaceId> <preferenceId>
  sikong task create --workspace <workspaceId> --request <text> [--cwd <path>] [--repo <path>]
  sikong task show <taskId> --workspace <workspaceId>
  sikong task submit-plan <taskId> --workspace <workspaceId> --plan-json <json>
  sikong task accept-plan <taskId> --workspace <workspaceId> --plan <planId> --version <n> --report <text>
  sikong task reject-plan <taskId> --workspace <workspaceId> --plan <planId> --version <n> --report <text>
  sikong task start-worker <taskId> --workspace <workspaceId>
  sikong task complete-worker <taskId> --workspace <workspaceId> --run <runId> --result-json <json>
  sikong task fail-worker <taskId> --workspace <workspaceId> --run <runId> --result-json <json>
  sikong task exceed-worker-budget <taskId> --workspace <workspaceId> --run <runId> --result-json <json>
  sikong task start-stage-review <taskId> --workspace <workspaceId>
  sikong task accept-stage-review <taskId> --workspace <workspaceId> --review <reviewId> --report <text>
  sikong task reject-stage-review <taskId> --workspace <workspaceId> --review <reviewId> --report <text>
  sikong task recommend-final-review <taskId> --workspace <workspaceId> --review <reviewId> --recommendation <accept|reject> --report <text>
  sikong task accept <taskId> --workspace <workspaceId> --report <text>
  sikong task reject <taskId> --workspace <workspaceId> --report <text>
  sikong inspect summary <taskId> --workspace <workspaceId>
  sikong inspect events <taskId> --workspace <workspaceId>
  sikong inspect projection <taskId> --workspace <workspaceId>
  sikong inspect trace <taskId> --workspace <workspaceId>
`;
}

if (import.meta.main) {
  const result = await runCli(Bun.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
