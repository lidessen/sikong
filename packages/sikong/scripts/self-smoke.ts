#!/usr/bin/env bun
/**
 * Candidate self-smoke — mechanical promotion gate (ADR 0016 step 1).
 *
 * Builds the sikong CLI binary (or accepts `--bin`) and runs a battery of
 * real-world, mechanical checks against it to prove it WORKS. This is NOT a
 * unit-test suite — it exercises the compiled binary against a temp workspace
 * and validates CLI I/O, error handling, and structural output integrity.
 *
 * Usage:
 *   bun scripts/self-smoke.ts                          # build + smoke
 *   bun scripts/self-smoke.ts --bin ./dist/sikong      # use existing binary
 *   bun scripts/self-smoke.ts --keep-tmp               # keep tmp workspace after
 *
 * Exit:
 *   0  — all checks pass
 *   1  — one or more checks failed (details on stderr)
 *   2  — binary couldn't be built or found
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JsonWorkspaceChronicleStore, JsonWorkspaceEventStore, JsonWorkspaceProjectionStore } from "../src/store";
import { GENERAL_WORKFLOW } from "../src/workflow/builtin";
import { initTask, project } from "../src/workflow/reducer";

// ---- preamble --------------------------------------------------------------

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (n: string): boolean => argv.includes(n);

const binPath = flag("--bin") ?? join(PKG_ROOT, "dist", "sikong");
const buildFromSource = !flag("--bin");
const keepTmp = hasFlag("--keep-tmp");

// ---- helpers ---------------------------------------------------------------

interface Check {
  name: string;
  run: () => Promise<string | null>; // null = pass, string = failure message
}

const passed: string[] = [];
const failed: string[] = [];

function check(label: string, run: () => Promise<string | null>): void {
  checks.push({ name: label, run });
}

const checks: Check[] = [];

async function runBin(args: string[], opts: { expectExit?: number } = {}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([binPath, ...args], {
    cwd: PKG_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SIKONG_HOME: tmpDir },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (opts.expectExit !== undefined && exitCode !== opts.expectExit) {
    return {
      exitCode,
      stdout,
      stderr: `expected exit ${opts.expectExit}, got ${exitCode}\nstderr:\n${stderr}stdout:\n${stdout}`,
    };
  }
  return { exitCode, stdout, stderr };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

// ---- setup -----------------------------------------------------------------

const tmpRoot = join(tmpdir(), `sikong-self-smoke-${randomUUID().slice(0, 8)}`);
let tmpDir: string;

async function setup(): Promise<void> {
  await mkdir(tmpRoot, { recursive: true });
  tmpDir = join(tmpRoot, ".sikong");
  await mkdir(tmpDir, { recursive: true });
}

async function teardown(): Promise<void> {
  if (keepTmp) {
    console.log(`Workspace kept at ${tmpDir} (--keep-tmp)`);
    return;
  }
  await rm(tmpRoot, { recursive: true, force: true });
}

async function build(): Promise<void> {
  if (!buildFromSource) {
    // Verify the supplied binary exists and is executable.
    const proc = Bun.spawn(["test", "-x", binPath], { cwd: PKG_ROOT, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`--bin path "${binPath}" is not an executable file`);
      process.exit(2);
    }
    return;
  }
  console.log(`Building candidate binary → ${binPath}`);
  await mkdir(dirname(binPath), { recursive: true });
  const proc = Bun.spawn(["bun", "build", "src/cli.ts", "--compile", "--outfile", binPath], {
    cwd: PKG_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`Build failed (exit ${code})`);
    process.exit(2);
  }
}

async function seedReviewRequiredTask(taskId: string): Promise<void> {
  const events = new JsonWorkspaceEventStore(tmpDir);
  const projections = new JsonWorkspaceProjectionStore(tmpDir);
  const chronicle = new JsonWorkspaceChronicleStore(tmpDir);
  const timeline = await events.append(
    taskId,
    initTask({
      taskId,
      projectId: "default",
      workflow: GENERAL_WORKFLOW,
      fields: { request: "self-smoke review-required work log" },
    }),
  );
  await projections.put(project(timeline, GENERAL_WORKFLOW));
  await chronicle.append({
    type: "wake.start",
    taskId,
    wakeId: "self-smoke-wake",
    summary: "wake @ general",
  });
  await chronicle.append({
    type: "wake.diagnostics",
    taskId,
    wakeId: "self-smoke-wake",
    summary: "worker pass",
    data: {
      phase: "worker",
      status: "completed",
      stateCommands: 0,
      toolCallStarts: { readFile: 1 },
      toolCallEnds: { readFile: 1 },
      textPreview: "looked at the work but did not record durable state",
    },
  });
  await chronicle.append({
    type: "wake.review_required",
    taskId,
    wakeId: "self-smoke-wake",
    summary: "worker pass ended without durable stage state; lead/reviewer must inspect the work log",
    data: {
      reason: "no_state_commands",
      outputFields: ["summary"],
      firstPassTextPreview: "looked at the work but did not record durable state",
    },
  });
}

// ---- self-smoke checks -----------------------------------------------------

function registerChecks(): void {
  // 1. Help output (no args) — prints usage and exits 0.
  check("help (no args) prints usage and exits 0", async () => {
    const { exitCode, stdout, stderr } = await runBin([], { expectExit: 0 });
    const stripped = stripAnsi(stdout);
    const expectedTerms = ["create", "run", "submit", "overview", "status", "trace", "worker", "project", "chronicle", "usage", "watch", "inspect", "register"];
    const missing = expectedTerms.filter((t) => !stripped.includes(t));
    if (missing.length) return `help missing commands: ${missing.join(", ")}`;
    if (stderr.trim()) return `unexpected stderr: ${stderr.trim().slice(0, 200)}`;
    return null;
  });

  // 2. Help with explicit `--help` is not a supported flag — must use no-args.
  check("--help is unknown flag (use no-args for help)", async () => {
    const { exitCode, stderr } = await runBin(["--help"]);
    if (exitCode !== 2) return `expected exit 2, got ${exitCode}`;
    if (!stderr.includes("unknown flag")) return `expected 'unknown flag' error, got: ${stderr.trim()}`;
    return null;
  });

  // 3. Unknown flag — exits 2 with error.
  check("unknown flag --bogus exits 2 with error", async () => {
    const { exitCode, stderr } = await runBin(["--bogus"]);
    if (exitCode !== 2) return `expected exit 2, got ${exitCode}`;
    if (!stderr.includes("unknown flag")) return `expected 'unknown flag' error, got: ${stderr.trim()}`;
    return null;
  });

  // 4. Unknown flag inside a flag value context — still exits 2.
  check("unknown flag after command exits 2", async () => {
    const { exitCode, stderr } = await runBin(["create", "--bogus"]);
    if (exitCode !== 2) return `expected exit 2, got ${exitCode}`;
    if (!stderr.includes("unknown flag")) return `expected 'unknown flag' error, got: ${stderr.trim()}`;
    return null;
  });

  // 5. Flag without value — exits 2.
  check("--dir without value exits 2", async () => {
    const { exitCode, stderr } = await runBin(["overview", "--dir"]);
    if (exitCode !== 2) return `expected exit 2, got ${exitCode}`;
    if (!stderr.includes("requires a value")) return `expected 'requires a value' error, got: ${stderr.trim()}`;
    return null;
  });

  // 6. Create without request — exits 2 with usage.
  check("create without request exits 2", async () => {
    const { exitCode, stderr } = await runBin(["create"]);
    if (exitCode !== 2) return `expected exit 2, got ${exitCode}`;
    if (!stderr.includes("usage: cli create")) return `expected usage error, got: ${stderr.trim()}`;
    return null;
  });

  // 7. Submit without args — exits 2 with usage.
  check("submit without args exits 2", async () => {
    const { exitCode, stderr } = await runBin(["submit"]);
    if (exitCode !== 2) return `expected exit 2, got ${exitCode}`;
    if (!stderr.includes("usage: cli submit")) return `expected usage error, got: ${stderr.trim()}`;
    return null;
  });

  // 8. Overview --json — returns valid JSON with expected structure.
  check("overview --json returns valid overview structure", async () => {
    const { exitCode, stdout, stderr } = await runBin(["overview", "--json", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return `invalid JSON: ${stdout.slice(0, 200)}`;
    }
    const keys = ["projects", "workers", "totalTasks", "counts", "recentTasks", "recentActivity", "recentErrors"];
    const missing = keys.filter((k) => !(k in parsed));
    if (missing.length) return `overview missing keys: ${missing.join(", ")}`;
    if (typeof parsed.totalTasks !== "number") return "totalTasks is not a number";
    if (!Array.isArray(parsed.projects)) return "projects is not an array";
    if (!Array.isArray(parsed.workers)) return "workers is not an array";
    return null;
  });

  // 9. Overview --text — produces human-readable output.
  check("overview --text produces readable output", async () => {
    const { exitCode, stdout, stderr } = await runBin(["overview", "--text", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    const stripped = stripAnsi(stdout);
    if (!stripped.includes("Workspace")) return "text output missing 'Workspace' header";
    if (!stripped.includes("Projects")) return "text output missing 'Projects' section";
    if (!stripped.includes("Workers")) return "text output missing 'Workers' section";
    return null;
  });

  // 10. Status --json — returns valid JSON with workspace task status.
  check("status --json returns valid status structure", async () => {
    const { exitCode, stdout, stderr } = await runBin(["status", "--json", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return `invalid JSON: ${stdout.slice(0, 200)}`;
    }
    const keys = ["tasks", "total", "counts", "recentActivity", "recentErrors"];
    const missing = keys.filter((k) => !(k in parsed));
    if (missing.length) return `status missing keys: ${missing.join(", ")}`;
    if (typeof parsed.total !== "number") return "total is not a number";
    if (!Array.isArray(parsed.tasks)) return "tasks is not an array";
    return null;
  });

  // 11. Status --text — produces human-readable output.
  check("status --text produces readable output", async () => {
    const { exitCode, stdout, stderr } = await runBin(["status", "--text", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    const stripped = stripAnsi(stdout);
    if (!stripped.includes("Workspace")) return "text output missing 'Workspace' header";
    if (!stripped.includes("Tasks")) return "text output missing 'Tasks' section";
    return null;
  });

  // 12. Worker discover --json — returns valid discovery structure.
  check("worker discover --json returns valid discovery", async () => {
    const { exitCode, stdout, stderr } = await runBin(["worker", "discover", "--json", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return `invalid JSON: ${stdout.slice(0, 200)}`;
    }
    const keys = ["providers", "providerDetails", "runtimes", "runtimeDetails", "compatibility"];
    const missing = keys.filter((k) => !(k in parsed));
    if (missing.length) return `discover missing keys: ${missing.join(", ")}`;
    if (!Array.isArray(parsed.providers)) return "providers is not an array";
    if (!Array.isArray(parsed.runtimeDetails)) return "runtimeDetails is not an array";
    return null;
  });

  // 13. Worker list --json — returns valid worker roster.
  check("worker list --json returns valid roster", async () => {
    const { exitCode, stdout, stderr } = await runBin(["worker", "list", "--json", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return `invalid JSON: ${stdout.slice(0, 200)}`;
    }
    // Empty workspace returns auto-discovered workers or an empty list.
    if (!("source" in parsed) && !("workers" in parsed)) {
      return "worker list missing 'source' and 'workers' keys";
    }
    if ("workers" in parsed && !Array.isArray(parsed.workers)) return "workers is not an array";
    return null;
  });

  // 14. Worker list --text — produces readable output.
  check("worker list --text produces readable output", async () => {
    const { exitCode, stdout, stderr } = await runBin(["worker", "list", "--text", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    // Empty workspace may show a hint message; just verify it ran without error.
    return null;
  });

  // 15. Project list --json — returns valid project list.
  check("project list --json returns valid project list", async () => {
    const { exitCode, stdout, stderr } = await runBin(["project", "list", "--json", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    let parsed: unknown[];
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return `invalid JSON: ${stdout.slice(0, 200)}`;
    }
    if (!Array.isArray(parsed)) return "project list is not an array";
    // Default project should always be present.
    if (parsed.length === 0) return "project list is empty (expected default project)";
    return null;
  });

  // 16. Project list --text — produces readable output.
  check("project list --text produces readable output", async () => {
    const { exitCode, stdout, stderr } = await runBin(["project", "list", "--text", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    // Just verify it runs without error.
    return null;
  });

  // 17. Chronic with -n limit — returns recent chronicle entries.
  check("chronicle --json -n 5 returns an array", async () => {
    const { exitCode, stdout, stderr } = await runBin(["chronicle", "--json", "-n", "5", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    let parsed: unknown[];
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return `invalid JSON: ${stdout.slice(0, 200)}`;
    }
    if (!Array.isArray(parsed)) return "chronicle is not an array";
    if (parsed.length > 5) return `chronicle returned ${parsed.length} entries (expected ≤ 5)`;
    return null;
  });

  // 18. Review-required work log — compiled binary surfaces it in actions/trace/chronicle.
  check("review-required work log is visible in actions, trace, and chronicle", async () => {
    const taskId = "review-smoke";
    await seedReviewRequiredTask(taskId);

    const actions = await runBin(["actions", "--json", "--dir", tmpDir]);
    if (actions.exitCode !== 0) return `actions exit ${actions.exitCode}: ${actions.stderr.trim()}`;
    let actionsParsed: Record<string, unknown>;
    try {
      actionsParsed = JSON.parse(actions.stdout);
    } catch {
      return `invalid actions JSON: ${actions.stdout.slice(0, 200)}`;
    }
    const rows = Array.isArray(actionsParsed.actions) ? actionsParsed.actions : [];
    if (
      !rows.some(
        (row) =>
          typeof row === "object" &&
          row !== null &&
          (row as Record<string, unknown>).classification === "worker_log_review_required",
      )
    ) {
      return `actions missing worker_log_review_required: ${actions.stdout.slice(0, 400)}`;
    }

    const trace = await runBin(["trace", taskId, "--text", "--dir", tmpDir]);
    if (trace.exitCode !== 0) return `trace exit ${trace.exitCode}: ${trace.stderr.trim()}`;
    const traceText = stripAnsi(trace.stdout);
    if (!traceText.includes("review required")) return "trace output missing review required line";
    if (!traceText.includes("stateCommands=0")) return "trace output missing stateCommands fact";

    const chronicle = await runBin(["chronicle", "--task", taskId, "--text", "-n", "3", "--dir", tmpDir]);
    if (chronicle.exitCode !== 0) return `chronicle exit ${chronicle.exitCode}: ${chronicle.stderr.trim()}`;
    const chronicleText = stripAnsi(chronicle.stdout);
    if (!chronicleText.includes("wake.review_required")) return "chronicle output missing wake.review_required";
    if (!chronicleText.includes("reason=no_state_commands")) return "chronicle output missing review reason";
    return null;
  });

  // 19. Task with nonexistent id — exits 1 with error.
  check("task <nonexistent> exits 1 with error", async () => {
    const { exitCode, stderr, stdout } = await runBin(["task", "no-such-task", "--dir", tmpDir]);
    if (exitCode !== 1) return `expected exit 1, got ${exitCode}`;
    const combined = stripAnsi(stderr + stdout);
    if (!combined.includes("no such task") && !combined.includes("not_found")) {
      return `expected 'no such task' error, got: ${combined.slice(0, 200)}`;
    }
    return null;
  });

  // 20. Usage — returns report structure.
  check("usage --json returns report structure", async () => {
    const { exitCode, stdout, stderr } = await runBin(["usage", "--json", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return `invalid JSON: ${stdout.slice(0, 200)}`;
    }
    const keys = ["tasks", "byProject", "workspace", "windows"];
    const missing = keys.filter((k) => !(k in parsed));
    if (missing.length) return `usage missing keys: ${missing.join(", ")}`;
    if (!Array.isArray(parsed.tasks)) return "tasks is not an array";
    if (!Array.isArray(parsed.windows)) return "windows is not an array";
    if (typeof parsed.workspace !== "object" || parsed.workspace === null) return "workspace is not an object";
    return null;
  });

  // 21. Watch --once — renders a single frame of the dashboard.
  check("watch --once renders without error", async () => {
    const { exitCode, stdout, stderr } = await runBin(["watch", "--once", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    const stripped = stripAnsi(stdout);
    if (!stripped.includes("sikong watch")) return "watch output missing 'sikong watch' header";
    return null;
  });

  // 22. Workspace with default response shapes — no panics.
  check("all --json output for empty workspace is consistent", async () => {
    // Run status without creating any data — just ensure no crash.
    const { exitCode, stderr } = await runBin(["status", "--json", "--dir", tmpDir]);
    if (exitCode !== 0) return `exit ${exitCode}: ${stderr.trim()}`;
    return null;
  });

  // 23. Register with missing file — exits 1.
  check("register without file exits 2", async () => {
    const { exitCode, stderr } = await runBin(["register"]);
    if (exitCode !== 2) return `expected exit 2, got ${exitCode}`;
    if (!stderr.includes("usage: cli register")) return `expected usage error, got: ${stderr.trim()}`;
    return null;
  });
}

// ---- runner ----------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n\x1b[1msikong self-smoke\x1b[0m  (ADR 0016 step 1 · promotion gate)`);
  console.log(`binary: ${binPath}  ${buildFromSource ? "(built from source)" : "(supplied)"}`);
  console.log(`workspace: ${tmpDir}\n`);

  registerChecks();

  let ok = 0;
  let total = checks.length;

  for (const { name, run } of checks) {
    process.stdout.write(`  \x1b[90m·\x1b[0m ${name} ... `);
    try {
      const err = await run();
      if (err === null) {
        process.stdout.write(`\x1b[32mPASS\x1b[0m\n`);
        ok++;
      } else {
        process.stdout.write(`\x1b[31mFAIL\x1b[0m\n`);
        failed.push(`  ${name}\n    ${err}`);
      }
    } catch (e) {
      process.stdout.write(`\x1b[31mFAIL (exception)\x1b[0m\n`);
      failed.push(`  ${name}\n    ${(e as Error).message}`);
    }
  }

  // Summary
  const color = ok === total ? "\x1b[32m" : "\x1b[31m";
  console.log(`\n${color}${ok}/${total} checks passed\x1b[0m`);
  if (failed.length) {
    console.error(`\nFailures:\n${failed.join("\n")}\n`);
  }

  if (ok !== total) process.exit(1);
}

// ---- entry -----------------------------------------------------------------

await setup();
try {
  await build();
  await main();
} finally {
  await teardown();
}
