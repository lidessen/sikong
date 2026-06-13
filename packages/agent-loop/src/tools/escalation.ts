/**
 * Sandbox escalation — detect sandbox-constrained command failures, classify the
 * command for safety, and retry on the real host (bypassing the virtual sandbox).
 *
 * Two orthogonal layers (matching Claude Code's design):
 * 1. **Failure detection** — parse stderr/exit for sandbox-blocked signatures
 *    (EACCES, "command not found" for a known toolchain binary, bwrap denied).
 * 2. **Command classifier** — static allow/deny/block rules so only safe commands
 *    (build/test/read) escalate; destructive and outward-facing commands are blocked.
 *
 * The escalation flow:
 *   try(command in sandbox) → sandbox failure detected → classify(command)
 *     → allow → retry on real host (bypass sandbox)
 *     → deny/block → return original error
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Hooks, ToolHookDecision } from "../core/hooks";

const execFileAsync = promisify(execFile);

// ── Classification types ──────────────────────────────────────────────────────

export type EscalationDecision = "allow" | "deny" | "block";

/**
 * Custom classifier function. Receives the full command string the agent wrote.
 * Return "allow" to escalate, "deny" to surface the original error (soft block),
 * or "block" to always refuse escalation (hard block).
 */
export type CommandClassifier = (command: string) => EscalationDecision;

export interface SandboxEscalationConfig {
  /**
   * Master switch — allow sandbox escalation at all. Default true for dev/worker
   * hosts so the self-verify toolchain works. Set false in strict CI or when
   * every command must stay inside the virtual sandbox.
   */
  allowUnsandboxedCommands?: boolean;
  /** Commands never allowed to escalate, matched as substrings of the first token. */
  excludedCommands?: string[];
  /** Commands always allowed to escalate (added to the built-in allow list). */
  allowList?: string[];
  /** Commands denied escalation (added to the built-in deny list). */
  denyList?: string[];
  /** Custom classifier — invoked when the static rules return "deny". If set and
   *  it returns "allow", escalation proceeds. Lets operators override for their
   *  project-specific toolchain. */
  classifier?: CommandClassifier;
}

// ── Built-in classification rules ──────────────────────────────────────────────

/**
 * First token patterns that are auto-allowed for escalation. A command starting
 * with any of these can bypass the sandbox. Each is matched as a case-insensitive
 * prefix of the command's first whitespace-delimited token.
 *
 * Scope: build, test, typecheck, lint, read-only toolchain commands.
 */
const BUILTIN_ALLOW_PREFIXES = [
  "swift", // swift build|test|run|package
  "go", // go build|test|vet|mod|run|fmt
  "bun", // bun run|test|build|install|add|x|format
  "npm", // npm run|test|build|install|ci
  "npx", // npx (ephemeral tool runner)
  "yarn", // yarn run|test|build|install
  "pnpm", // pnpm run|test|build|install
  "cargo", // cargo build|test|check|fmt|clippy
  "make", // make (build)
  "cmake", // cmake (build)
  "gradle", // gradle (build)
  "mvn", // maven (build)
  "dotnet", // dotnet build|test|run
  "rustc", // rustc (compile single file)
  "tsc", // TypeScript compiler
  "vitest", // vitest (test runner)
  "jest", // jest (test runner)
  "mocha", // mocha (test runner)
  "ava", // ava (test runner)
  "eslint", // eslint (lint)
  "prettier", // prettier (format)
  "biome", // biome (lint/format)
  "rg", // ripgrep
  "grep",
  "cat",
  "ls",
  "head",
  "tail",
  "echo",
  "which",
  "pwd",
  "find",
  "sort",
  "wc",
  "uname",
  "xcodebuild", // xcode build/test
  "bazel", // bazel build/test
  "ninja", // ninja (build backend)
  "typos", // typos-cli (spell check)
  "shellcheck", // shellcheck (shell lint)
];

/**
 * First token patterns that are denied escalation (soft-block). A command
 * starting with any of these gets the original sandbox error surfaced. These are
 * destructive but may be intentionally invoked; an explicit classifier override
 * can still allow them.
 */
const BUILTIN_DENY_PREFIXES = [
  "rm", // rm -rf is destructive
  // git is handled earlier by classifyGitCommand (reads allow, destructive deny).
];

/**
 * First token patterns that are hard-blocked — never escalated under any
 * circumstances. These cover exfiltration, sandbox-bypass attempts, and
 * outward-facing network commands.
 */
const BUILTIN_BLOCK_PREFIXES = [
  "telnet",
  "nc",
  "ncat",
  "socat",
  "expect",
  "eval", // shell eval (arbitrary code execution)
  "exec", // shell exec
];

/**
 * First token patterns for commands that are inherently neutral — they don't
 * read or write files, they only change the environment for subsequent commands
 * in a chain. These are allowed so a cd/export/set/unset segment doesn't poison
 * an otherwise-safe chain like `cd foo && swift build`.
 */
const NEUTRAL_COMMANDS = new Set(["cd", "pushd", "popd", "export", "set", "unset", "true", ":"]);

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extract the command name (first non-whitespace, non-flag token) from a command
 * string. Handles prefixed env vars and flags:
 *   "swift build"                     → "swift"
 *   "bun run test"                    → "bun"
 *   "git reset --hard HEAD"           → "git"
 *   "NODE_ENV=test bun run test"      → "bun"
 *   "tsc --noEmit --strict"           → "tsc"
 *   "  echo hello"                    → "echo"
 */
function firstToken(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";

  // Skip leading env var assignments (VAR=value)
  let i = 0;
  const chars = trimmed;
  while (i < chars.length) {
    // Find next whitespace or = sign
    const eq = chars.indexOf("=", i);
    const ws = findWhitespace(chars, i);

    // If we hit whitespace before =, this isn't an env var prefix
    if (ws !== -1 && (eq === -1 || ws < eq)) {
      // First non-whitespace segment — the command
      const token = chars.slice(i, ws).toLowerCase();
      return token;
    }

    // This LOOKS like VAR=value — skip past the value
    if (eq !== -1) {
      // Skip the value part (could be quoted)
      i = skipValue(chars, eq + 1);
      // Skip any whitespace after the value value so the next iteration
      // of the while loop doesn't find the same whitespace position again
      // and return an empty slice instead of the actual command token.
      while (i < chars.length) {
        const c = chars.charCodeAt(i);
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
        else break;
      }
    } else {
      // No = sign, no whitespace yet — probably the first token
      const token = chars.slice(i).toLowerCase();
      return token;
    }
  }

  return "";
}

function findWhitespace(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) return i;
  }
  return -1;
}

function skipValue(s: string, start: number): number {
  if (start >= s.length) return start;
  const quote = s[start];
  if (quote === "'" || quote === '"') {
    // Quoted value — skip to closing quote
    const end = s.indexOf(quote, start + 1);
    return end !== -1 ? end + 1 : s.length;
  }
  // Unquoted — skip to next whitespace
  const ws = findWhitespace(s, start);
  return ws !== -1 ? ws : s.length;
}

/**
 * Extract the first significant subcommand (non-flag token) for refined matching.
 * "git log"       → "log"
 * "git reset --hard" → "reset"
 * "cargo test"    → "test"
 * "swift build"   → undefined (swift itself is allowed)
 */
function firstSubcommand(command: string): string | undefined {
  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  // Skip leading env-var assignments (VAR=value) so the command word, not the
  // env prefix, is treated as tokens[i].
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  // The next non-flag argument after the command word is the subcommand.
  const rest = tokens.slice(i + 1).filter((t) => !t.startsWith("-"));
  return rest[0]?.toLowerCase();
}

// ── Command chain splitting ─────────────────────────────────────────────────────

/**
 * Split a shell command string into individual commands by breaking on chain
 * operators (`&&`, `||`, `;`, `|`). Respects single and double quotes so
 * operators inside strings are not treated as chain boundaries.
 */
function splitChains(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) return [];

  const segments: string[] = [];
  let current = "";
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (i < trimmed.length) {
    const c = trimmed[i]!;
    const next = trimmed[i + 1];

    // Handle quotes — toggle state, don't treat content as operators
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += c;
      i++;
      continue;
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += c;
      i++;
      continue;
    }

    // Only check for chain operators outside quotes
    if (!inSingleQuote && !inDoubleQuote) {
      if (c === "&" && next === "&") {
        if (current.trim()) segments.push(current.trim());
        current = "";
        i += 2;
        continue;
      }
      if (c === "|" && next === "|") {
        if (current.trim()) segments.push(current.trim());
        current = "";
        i += 2;
        continue;
      }
      if (c === "|") {
        if (current.trim()) segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (c === ";") {
        if (current.trim()) segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
    }

    current += c;
    i++;
  }

  if (current.trim()) segments.push(current.trim());

  return segments;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Classify a single-segment command (no chain operators) for sandbox escalation.
 * Returns "allow", "deny", or "block".
 *
 * The classifier checks:
 * 1. Hard-block patterns → block
 * 2. Excluded commands / deny list (config) → deny
 * 3. git — refine by subcommand (reads allow, destructive deny)
 * 4. Built-in allow list (build/test/read) → allow
 * 5. Custom allow list (config) → allow
 * 6. Built-in deny list → deny
 * 7. Neutral commands (cd, export, set, unset) → allow
 * 8. Default → deny (safe default)
 */
function classifySingleCommand(
  command: string,
  config?: SandboxEscalationConfig,
): EscalationDecision {
  const token = firstToken(command);

  // Empty command → deny
  if (!token) return "deny";

  // (1) Hard-block patterns — always win; nothing below can re-enable them.
  if (BUILTIN_BLOCK_PREFIXES.some((p) => token === p)) {
    return "block";
  }

  // (2) Operator deny/exclude — an explicit deny overrides any allow below
  //     (including the built-in allow list), so a denylist is never silently
  //     bypassed by a command that also happens to be allow-listed.
  if (config?.excludedCommands?.some((ex) => token.startsWith(ex.toLowerCase()))) {
    return "deny";
  }
  if (config?.denyList?.some((p) => token.startsWith(p.toLowerCase()))) {
    return "deny";
  }

  // (3) git — refine by subcommand (reads allow, destructive/unknown deny),
  //     independent of the allow/deny prefix lists.
  if (token === "git") {
    return classifyGitCommand(command);
  }

  // (4) Built-in allow list (build/test/read toolchain)
  if (BUILTIN_ALLOW_PREFIXES.some((p) => token === p)) {
    return "allow";
  }

  // (5) Custom allow list from config
  if (config?.allowList?.some((p) => token.startsWith(p.toLowerCase()))) {
    return "allow";
  }

  // (6) Built-in deny list
  if (BUILTIN_DENY_PREFIXES.some((p) => token === p)) {
    return "deny";
  }

  // (7) Neutral commands — cd, export, set, unset. These are harmless on their
  //     own; they only set up the environment for subsequent commands in a chain.
  //     The chain splitter classifies each segment independently, so the
  //     subsequent segment still gets its own safety check.
  if (NEUTRAL_COMMANDS.has(token)) {
    return "allow";
  }

  // (8) Default: deny (safe default — only known-safe commands escalate)
  return "deny";
}

/**
 * Classify a command for sandbox escalation. Returns:
 * - "allow" — safe to escalate, run on real host
 * - "deny" — soft block, surface the original sandbox error
 * - "block" — hard block, never escalate
 *
 * Splits the command on chain operators (`&&`, `||`, `;`, `|`) and classifies
 * each segment independently. The conservative union applies: if any segment
 * is block, the whole command is block; if any segment is deny, the whole
 * command is deny; otherwise allow (all segments must be allow).
 */
export function classifyCommand(
  command: string,
  config?: SandboxEscalationConfig,
): EscalationDecision {
  const segments = splitChains(command);
  if (segments.length === 0) return "deny";

  let result: EscalationDecision = "allow";
  for (const segment of segments) {
    const decision = classifySingleCommand(segment, config);
    if (decision === "block") return "block";
    if (decision === "deny") result = "deny";
  }

  // Custom classifier — receives the full original command (not a pre-split
  // segment), so a site-specific override can still inspect chains as a whole.
  if (result === "deny" && config?.classifier) {
    return config.classifier(command);
  }

  return result;
}

/** Refined git classification: reads are allowed, destructive ops are denied. */
function classifyGitCommand(command: string): EscalationDecision {
  const sub = firstSubcommand(command);

  // Git read/status commands — allow
  const readSubcommands = new Set([
    "log",
    "diff",
    "show",
    "status",
    "branch",
    "tag",
    "describe",
    "rev-parse",
    "rev-list",
    "ls-files",
    "ls-tree",
    "cat-file",
    "config",
    "remote",
    "fetch",
    "pull",
    "submodule",
  ]);
  if (sub && readSubcommands.has(sub)) return "allow";

  // Git destructive commands — deny
  const destructiveSubcommands = new Set([
    "reset",
    "clean",
    "push",
    "rebase",
    "cherry-pick",
    "merge",
    "commit",
    "add",
    "checkout",
    "switch",
    "restore",
  ]);
  if (sub && destructiveSubcommands.has(sub)) return "deny";

  // Unknown git subcommand — deny by default
  return "deny";
}

/** True for shell/bash-style tool names across runtimes (claude-code: "Bash"). */
function isBashToolName(name: string): boolean {
  const n = name.toLowerCase();
  return n === "bash" || n === "shell" || n.endsWith("_bash") || n.includes("bash");
}

/**
 * Build an `onToolUse` hook that applies sandbox-escalation policy to shell/bash
 * tool calls on runtimes with a permission gate (e.g. claude-code). This is the
 * auto-mode counterpart to the project-bash host retry: allow-listed
 * build/test/read commands are affirmatively **approved** (so a worker in
 * `acceptEdits` can run `swift build`/`go test`/`bun run test` to self-verify),
 * hard-blocked commands are **denied**, and everything else **defers** to the
 * runtime's normal permission posture. Non-bash tool calls are never affected.
 */
export function createEscalationOnToolUse(
  config: SandboxEscalationConfig,
): NonNullable<Hooks["onToolUse"]> {
  return (ev): ToolHookDecision => {
    if (config.allowUnsandboxedCommands === false) return { action: "continue" };
    if (!isBashToolName(ev.name)) return { action: "continue" };
    const command = typeof ev.args?.command === "string" ? ev.args.command : undefined;
    if (!command) return { action: "continue" };

    const decision = classifyCommand(command, config);
    if (decision === "allow") return { action: "approve" };
    if (decision === "block") {
      return { action: "deny", reason: `Blocked by sandbox policy: ${firstToken(command)}` };
    }
    // "deny" classification → defer to the runtime's normal permission posture.
    return { action: "continue" };
  };
}

// ── Sandbox failure detection ─────────────────────────────────────────────────

/**
 * Patterns in stderr/error messages that indicate a sandbox restriction rather
 * than a normal command failure.
 */
const SANDBOX_FAILURE_PATTERNS = [
  /EACCES/i,
  /EPERM/i,
  /permission denied/i,
  /operation not permitted/i,
  /bwrap:/i,
  /sandbox.*denied/i,
  /sandbox.*restrict/i,
  /command not found/i,
  /not found.*PATH/i,
  /no such file or directory/i,
];

/**
 * Commands known to be toolchain binaries that would indicate a sandbox problem
 * if they fail (as opposed to a user script failing).
 */
const TOOLCHAIN_COMMANDS = new Set([
  "swift",
  "go",
  "bun",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "cargo",
  "rustc",
  "make",
  "cmake",
  "gradle",
  "mvn",
  "dotnet",
  "xcodebuild",
  "bazel",
  "ninja",
  "tsc",
  "vitest",
  "jest",
  "mocha",
  "ava",
  "eslint",
  "prettier",
  "biome",
  "shellcheck",
  "typos",
  "rg",
  "grep",
]);

/**
 * Determine whether a tool execution error is plausibly due to sandbox
 * restrictions rather than a normal command failure. Returns true when:
 * - stderr matches sandbox-failure patterns (EACCES, bwrap, etc.)
 * - A known toolchain binary exited with "command not found"
 * - The exit code signals a system-level denial
 *
 * @param error - The error object or string from the tool execution
 * @returns true if the failure looks sandbox-related
 */
export function isSandboxFailure(error: unknown): boolean {
  if (!error) return false;

  const message = typeof error === "string" ? error : String(error);

  // Check against sandbox-specific patterns
  if (SANDBOX_FAILURE_PATTERNS.some((p) => p.test(message))) return true;

  return false;
}

/**
 * Check if a command failure on a known toolchain binary suggests sandbox
 * restriction. The first token is checked against the TOOLCHAIN_COMMANDS set.
 */
export function isToolchainFailure(command: string, error: unknown): boolean {
  const token = firstToken(command);
  if (!token || !TOOLCHAIN_COMMANDS.has(token)) return false;
  return isSandboxFailure(error);
}

// ── Real-host runner (bypass sandbox) ───────────────────────────────────────────

export interface HostRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string;
}

/**
 * Run a command on the real host, bypassing the virtual sandbox. Uses the host's
 * native shell so pipes, redirects, and multi-command scripts work naturally.
 *
 * The command runs with the host's full PATH and unrestricted filesystem access,
 * scoped only by the given `cwd`. Output is capped at `maxOutputLength` bytes.
 *
 * @param command - The shell command string to execute
 * @param opts - Options
 * @returns HostRunResult with exit code, stdout, stderr
 */
export async function runOnHost(
  command: string,
  opts: {
    /** Working directory for the command (typically the workspace root). */
    cwd: string;
    /** AbortSignal for cancellation. */
    signal?: AbortSignal;
    /** Max bytes to capture from stdout+stderr combined. Default 1MB. */
    maxOutputLength?: number;
    /** Additional environment variables. */
    env?: Record<string, string>;
  },
): Promise<HostRunResult> {
  const maxBytes = opts.maxOutputLength ?? 1_048_576;
  // The child-process buffer cap is generous and independent of the display
  // limit: a command must never be killed merely for producing more output than
  // we intend to surface. We truncate to maxBytes ourselves on both paths.
  const bufferCap = Math.max(maxBytes, 64 * 1_048_576);

  try {
    const { stdout: out, stderr: err } = await execFileAsync("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      signal: opts.signal,
      maxBuffer: bufferCap,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    return {
      exitCode: 0,
      stdout: String(out ?? "").slice(0, maxBytes),
      stderr: String(err ?? "").slice(0, maxBytes),
      signal: undefined,
    };
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      signal?: string;
    };

    const stdout = String(nodeErr.stdout ?? "").slice(0, maxBytes);
    const stderr = String(nodeErr.stderr ?? "").slice(0, maxBytes);

    // Resolve exit code: execFile throws with `code` = the exit code (number) on
    // non-zero exit, or a system error string like "ENOENT". AbortSignal yields -1.
    const isAbort = (err as NodeJS.ErrnoException).code === "ABORT_ERR";
    const exitCode = isAbort
      ? -1
      : typeof (nodeErr as unknown as Record<string, unknown>).code === "number"
        ? ((nodeErr as unknown as Record<string, unknown>).code as number)
        : 1;

    return {
      exitCode,
      stdout,
      stderr: nodeErr.signal ? `${stderr}\n[killed: signal ${nodeErr.signal}]` : stderr,
      signal: nodeErr.signal ?? undefined,
    };
  }
}
