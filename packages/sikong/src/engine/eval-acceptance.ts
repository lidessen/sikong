import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AcceptanceCheck, AcceptanceVerdictDetail } from "../workflow/types";

const execFileAsync = promisify(execFile);

/** Max bytes captured from a child process stdout/stderr. */
const CHILD_BUFFER = 8 * 1024 * 1024;
/** Max bytes allowed in the evidence field (truncated after this). */
const EVIDENCE_MAX = 8_000;
/** Max bytes for a suggestion string. */
const SUGGESTION_MAX = 500;
/** Max matching lines to include in grep evidence. */
const GREP_EVIDENCE_LINES = 5;
/** Max sibling files to list in a fileExists suggestion. */
const DIR_LISTING_MAX = 20;
/** Wall-clock timeout per child process (ms). */
const CHILD_TIMEOUT_MS = 60_000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated ${s.length - max} more bytes]`;
}

function resolvePath(path: string, cwd: string): string {
  return path.startsWith("/") ? path : join(cwd, path);
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command via execFile, capturing stdout+stderr. Returns an ExecResult
 * for ALL outcomes — a non-zero exit (or a missing binary) is NOT thrown but
 * returned as a result, so callers always get the output they need for evidence
 * without try/catch boilerplate.
 */
async function execOrCapture(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      maxBuffer: CHILD_BUFFER,
      timeout: CHILD_TIMEOUT_MS,
    });
    return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err: unknown) {
    const e = err as { code?: string | number; stdout?: string; stderr?: string; message: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(err),
    };
  }
}

/**
 * Execute a single acceptance check deterministically, producing a structured
 * verdict detail. All I/O dependencies (cwd, filesystem, shell) are passed
 * explicitly — the function is a bounded, portable switch over the four check
 * kinds defined in ADR 0024.
 *
 * - `command`: runs a shell binary via execFile, checks exit code.
 * - `fileExists`: verifies a file is present on disk.
 * - `grep`: reads a file and tests for a regex pattern match.
 * - `projectGate`: runs the project's standard verification (typecheck + test).
 *
 * Pure relative to I/O — no side-channel access to project state or config.
 * Never throws: every outcome (incl. missing files, invalid patterns, and
 * missing binaries) is returned as a structured `AcceptanceVerdictDetail`.
 */
export async function evalAcceptanceCheck(
  check: AcceptanceCheck,
  opts: { cwd: string },
): Promise<AcceptanceVerdictDetail> {
  switch (check.kind) {
    case "command":
      return evalCommandCheck(check, opts.cwd);
    case "fileExists":
      return evalFileExistsCheck(check, opts.cwd);
    case "grep":
      return evalGrepCheck(check, opts.cwd);
    case "projectGate":
      return evalProjectGateCheck(check, opts.cwd);
  }
}

// ---- command ---------------------------------------------------------------

async function evalCommandCheck(
  check: Extract<AcceptanceCheck, { kind: "command" }>,
  cwd: string,
): Promise<AcceptanceVerdictDetail> {
  const cmd = check.cmd.trim();
  if (!cmd) {
    return {
      checkDescription: check.description,
      passed: false,
      evidence: "command string is empty",
      suggestion: "Provide a non-empty shell command in the acceptance check definition.",
    };
  }
  const expectExit = check.expectExit ?? 0;
  // Run through a shell so the command string is parsed correctly — quotes, pipes,
  // and multi-word args. A naive whitespace split shattered quoted arguments, so
  // e.g. `node -e "console.log('x')"` failed to run.
  const { exitCode, stdout, stderr } = await execOrCapture("/bin/sh", ["-c", cmd], cwd);
  const passed = exitCode === expectExit;

  const evidenceParts: string[] = [];
  if (stdout) evidenceParts.push(`stdout:\n${truncate(stdout, EVIDENCE_MAX)}`);
  if (stderr) evidenceParts.push(`stderr:\n${truncate(stderr, EVIDENCE_MAX)}`);
  evidenceParts.push(`exit code: ${exitCode} (expected: ${expectExit})`);

  return {
    checkDescription: check.description,
    passed,
    evidence: evidenceParts.join("\n---\n"),
    ...(passed
      ? {}
      : {
          suggestion: stderr
            ? truncate(stderr, SUGGESTION_MAX)
            : `Command "${check.cmd}" exited with code ${exitCode}, expected ${expectExit}.`,
        }),
  };
}

// ---- fileExists ------------------------------------------------------------

async function evalFileExistsCheck(
  check: Extract<AcceptanceCheck, { kind: "fileExists" }>,
  cwd: string,
): Promise<AcceptanceVerdictDetail> {
  const abs = resolvePath(check.path, cwd);
  try {
    await access(abs);
    return {
      checkDescription: check.description,
      passed: true,
      evidence: abs,
    };
  } catch {
    const dir = abs.includes("/") ? abs.slice(0, abs.lastIndexOf("/")) : cwd;
    let suggestion: string;
    try {
      const entries = await readdir(dir);
      const listing = entries.slice(0, DIR_LISTING_MAX);
      suggestion = `File not found at ${abs}.${
        listing.length
          ? ` Contents of ${dir} (showing ${Math.min(listing.length, entries.length)} of ${entries.length}):\n${listing.join("\n")}`
          : ` Directory ${dir} is empty.`
      }`;
    } catch {
      suggestion = `File not found at ${abs}, and could not read directory ${dir}.`;
    }
    return {
      checkDescription: check.description,
      passed: false,
      evidence: `${abs} does not exist`,
      suggestion,
    };
  }
}

// ---- grep ------------------------------------------------------------------

async function evalGrepCheck(
  check: Extract<AcceptanceCheck, { kind: "grep" }>,
  cwd: string,
): Promise<AcceptanceVerdictDetail> {
  const abs = resolvePath(check.path, cwd);
  let content: string;
  try {
    content = await readFile(abs, "utf-8");
  } catch (err) {
    return {
      checkDescription: check.description,
      passed: false,
      evidence: `could not read ${abs}: ${(err as Error).message}`,
      suggestion: `Ensure the file exists at ${abs}.`,
    };
  }

  let re: RegExp;
  try {
    re = new RegExp(check.pattern);
  } catch (err) {
    return {
      checkDescription: check.description,
      passed: false,
      evidence: `invalid regex pattern "${check.pattern}": ${(err as Error).message}`,
      suggestion: "Provide a valid JavaScript regular expression in the acceptance check pattern field.",
    };
  }

  const lines = content.split("\n");
  const matchingLines: { num: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) matchingLines.push({ num: i + 1, text: lines[i]! });
  }

  const found = matchingLines.length > 0;
  const passed = check.expectMatch === found;

  if (passed) {
    if (!found && !check.expectMatch) {
      return {
        checkDescription: check.description,
        passed: true,
        evidence: `pattern /${check.pattern}/ confirmed absent from ${check.path} (${lines.length} lines)`,
      };
    }
    const evidenceLines = matchingLines
      .slice(0, GREP_EVIDENCE_LINES)
      .map((m) => `${m.num}:${m.text}`);
    if (matchingLines.length > GREP_EVIDENCE_LINES)
      evidenceLines.push(`… and ${matchingLines.length - GREP_EVIDENCE_LINES} more matches`);
    return {
      checkDescription: check.description,
      passed: true,
      evidence: evidenceLines.join("\n"),
    };
  }

  if (check.expectMatch) {
    // Expected to find the pattern but didn't
    return {
      checkDescription: check.description,
      passed: false,
      evidence: `pattern /${check.pattern}/ not found in ${check.path} (${lines.length} lines scanned)`,
      suggestion: `The pattern /${check.pattern}/ was not found in ${check.path}. Check that the expected content exists or that the pattern is correct.`,
    };
  }

  // Expected NOT to find the pattern but it was found
  const evidenceLines = matchingLines
    .slice(0, GREP_EVIDENCE_LINES)
    .map((m) => `${m.num}:${m.text}`);
  if (matchingLines.length > GREP_EVIDENCE_LINES)
    evidenceLines.push(`… and ${matchingLines.length - GREP_EVIDENCE_LINES} more matches`);
  return {
    checkDescription: check.description,
    passed: false,
    evidence: evidenceLines.join("\n"),
    suggestion: `Pattern /${check.pattern}/ was unexpectedly found in ${check.path}. Remove the matching content or update the check.`,
  };
}

// ---- projectGate -----------------------------------------------------------

async function evalProjectGateCheck(
  check: Extract<AcceptanceCheck, { kind: "projectGate" }>,
  cwd: string,
): Promise<AcceptanceVerdictDetail> {
  const typecheck = await execOrCapture("bun", ["run", "typecheck"], cwd);
  const test = await execOrCapture("bun", ["run", "test"], cwd);

  const evidenceParts: string[] = [];
  let passed = true;
  const failures: string[] = [];

  evidenceParts.push(`--- typecheck (exit ${typecheck.exitCode}) ---`);
  if (typecheck.stdout) evidenceParts.push(truncate(typecheck.stdout, EVIDENCE_MAX));
  if (typecheck.stderr) evidenceParts.push(truncate(typecheck.stderr, EVIDENCE_MAX));
  if (typecheck.exitCode !== 0) {
    passed = false;
    failures.push(`typecheck failed (exit ${typecheck.exitCode})`);
  }

  evidenceParts.push(`\n--- test (exit ${test.exitCode}) ---`);
  if (test.stdout) evidenceParts.push(truncate(test.stdout, EVIDENCE_MAX));
  if (test.stderr) evidenceParts.push(truncate(test.stderr, EVIDENCE_MAX));
  if (test.exitCode !== 0) {
    passed = false;
    failures.push(`test failed (exit ${test.exitCode})`);
  }

  return {
    checkDescription: check.description,
    passed,
    evidence: evidenceParts.join("\n"),
    ...(passed ? {} : { suggestion: failures.join("; ") || "projectGate check failed." }),
  };
}
