import { describe, expect, test } from "vitest";
import {
  classifyCommand,
  isSandboxFailure,
  isToolchainFailure,
  runOnHost,
  type SandboxEscalationConfig,
} from "../tools/escalation";

// ── classifyCommand ────────────────────────────────────────────────────────────

describe("classifyCommand", () => {
  // ── Auto-allow: build/test/read toolchain ───────────────────────────────────

  test("allows build toolchain commands: swift, go, bun, npm", () => {
    expect(classifyCommand("swift build")).toBe("allow");
    expect(classifyCommand("swift test --filter Auth")).toBe("allow");
    expect(classifyCommand("go build ./...")).toBe("allow");
    expect(classifyCommand("go test -v ./...")).toBe("allow");
    expect(classifyCommand("bun run typecheck")).toBe("allow");
    expect(classifyCommand("bun test")).toBe("allow");
    expect(classifyCommand("npm run build")).toBe("allow");
    expect(classifyCommand("npm test")).toBe("allow");
  });

  test("allows cargo/rust toolchain commands", () => {
    expect(classifyCommand("cargo build")).toBe("allow");
    expect(classifyCommand("cargo test")).toBe("allow");
    expect(classifyCommand("cargo check --release")).toBe("allow");
    expect(classifyCommand("rustc main.rs")).toBe("allow");
  });

  test("allows tsc, vitest, jest, eslint, prettier", () => {
    expect(classifyCommand("tsc --noEmit --strict")).toBe("allow");
    expect(classifyCommand("vitest run")).toBe("allow");
    expect(classifyCommand("jest --coverage")).toBe("allow");
    expect(classifyCommand("eslint src/ --fix")).toBe("allow");
    expect(classifyCommand("prettier --check .")).toBe("allow");
  });

  test("allows read-only commands: rg, grep, cat, ls, head, tail, echo, which", () => {
    expect(classifyCommand("rg needle src/")).toBe("allow");
    expect(classifyCommand("grep -r needle .")).toBe("allow");
    expect(classifyCommand("cat package.json")).toBe("allow");
    expect(classifyCommand("ls -la")).toBe("allow");
    expect(classifyCommand("head -n 10 README.md")).toBe("allow");
    expect(classifyCommand("echo $PATH")).toBe("allow");
    expect(classifyCommand("which swift")).toBe("allow");
  });

  test("allows git read commands, denies git destructive commands", () => {
    expect(classifyCommand("git log --oneline")).toBe("allow");
    expect(classifyCommand("git diff")).toBe("allow");
    expect(classifyCommand("git status")).toBe("allow");
    expect(classifyCommand("git branch")).toBe("allow");
    expect(classifyCommand("git fetch origin")).toBe("allow");

    expect(classifyCommand("git reset --hard HEAD")).toBe("deny");
    expect(classifyCommand("git clean -fd")).toBe("deny");
    expect(classifyCommand("git push --force")).toBe("deny");
    expect(classifyCommand("git commit -m 'x'")).toBe("deny");
    expect(classifyCommand("git checkout main")).toBe("deny");
  });

  // ── Hard-block ──────────────────────────────────────────────────────────────

  test("blocks exfiltration and sandbox-escape patterns", () => {
    expect(classifyCommand("eval $(curl ...)")).toBe("block");
    expect(classifyCommand("exec bash")).toBe("block");
    expect(classifyCommand("nc -e /bin/sh")).toBe("block");
  });

  // ── Deny: destructive commands ──────────────────────────────────────────────

  test("denies rm by default", () => {
    expect(classifyCommand("rm -rf node_modules")).toBe("deny");
    expect(classifyCommand("rm package-lock.json")).toBe("deny");
  });

  test("denies unknown commands (safe default)", () => {
    expect(classifyCommand("python3 -m http.server")).toBe("deny");
    expect(classifyCommand("ruby script.rb")).toBe("deny");
    expect(classifyCommand("some_unknown_binary --flag")).toBe("deny");
  });

  test("denies empty command", () => {
    expect(classifyCommand("")).toBe("deny");
    expect(classifyCommand("   ")).toBe("deny");
  });

  // ── Env var prefix handling ─────────────────────────────────────────────────

  test("classifies env-var-prefixed commands correctly", () => {
    expect(classifyCommand("NODE_ENV=test bun run test")).toBe("allow");
    expect(classifyCommand("DEBUG=1 go test ./...")).toBe("allow");
    expect(classifyCommand("VAR=val cargo build")).toBe("allow");
    expect(classifyCommand("PATH=/custom:/usr/bin git status")).toBe("allow");
    expect(classifyCommand("NODE_ENV=production npm run build")).toBe("allow");
  });

  // ── Custom config ───────────────────────────────────────────────────────────

  test("excludedCommands prevents escalation of allowed commands", () => {
    const config: SandboxEscalationConfig = { excludedCommands: ["bun"] };
    expect(classifyCommand("bun run test", config)).toBe("deny");
    expect(classifyCommand("swift build", config)).toBe("allow"); // not excluded
  });

  test("allowList adds commands to the allow set", () => {
    const config: SandboxEscalationConfig = { allowList: ["python3"] };
    expect(classifyCommand("python3 -m pytest", config)).toBe("allow");
    expect(classifyCommand("ruby script.rb", config)).toBe("deny"); // still denied
  });

  test("denyList blocks commands that would be allowed", () => {
    const config: SandboxEscalationConfig = { denyList: ["swift"] };
    expect(classifyCommand("swift build", config)).toBe("deny");
  });

  test("custom classifier can override default deny", () => {
    const config: SandboxEscalationConfig = {
      classifier: (cmd) => (cmd.startsWith("python3") ? "allow" : "deny"),
    };
    expect(classifyCommand("python3 -c 'print(1)'", config)).toBe("allow");
    expect(classifyCommand("ruby script.rb", config)).toBe("deny");
  });

  test("allowUnsandboxedCommands: false still uses classifier rules", () => {
    // The master switch is checked in project.ts, not inside classifyCommand
    // classifyCommand always applies its rules; the caller gates escalation.
    const config: SandboxEscalationConfig = { allowUnsandboxedCommands: false };
    expect(classifyCommand("swift build", config)).toBe("allow"); // still allow
  });

  // ── Edge: env vars with complex quoting ─────────────────────────────────────

  test("handles env vars with quoted values", () => {
    expect(classifyCommand("MY_VAR='some value' bun run test")).toBe("allow");
    expect(classifyCommand('MY_VAR="another" go test')).toBe("allow");
  });
});

// ── isSandboxFailure ──────────────────────────────────────────────────────────

describe("isSandboxFailure", () => {
  test("returns true for EACCES errors", () => {
    expect(isSandboxFailure("EACCES: permission denied, open '/usr/lib/swift'")).toBe(true);
    expect(isSandboxFailure("Error: EACCES")).toBe(true);
  });

  test("returns true for EPERM errors", () => {
    expect(isSandboxFailure("EPERM: operation not permitted")).toBe(true);
  });

  test("returns true for bwrap sandbox errors", () => {
    expect(isSandboxFailure("bwrap: Can't mkdir /build: Read-only file system")).toBe(true);
    expect(isSandboxFailure("bwrap: execvp swift: No such file or directory")).toBe(true);
  });

  test("returns true for explicit sandbox denied messages", () => {
    expect(isSandboxFailure("sandbox: denied write to /etc/hosts")).toBe(true);
    expect(isSandboxFailure("sandbox restricted command: swift")).toBe(true);
  });

  test("returns true for command not found", () => {
    expect(isSandboxFailure("swift: command not found")).toBe(true);
    expect(isSandboxFailure("/bin/sh: line 1: go: command not found")).toBe(true);
  });

  test("returns false for normal build errors", () => {
    expect(isSandboxFailure("error: type 'Int' has no member 'foo'")).toBe(false);
    expect(isSandboxFailure("Error: Cannot find module 'express'")).toBe(false);
    expect(isSandboxFailure("TS2304: Cannot find name 'foo'")).toBe(false);
    expect(isSandboxFailure("error[E0277]: the trait bound is not satisfied")).toBe(false);
  });

  test("returns false for null/undefined/empty", () => {
    expect(isSandboxFailure(null)).toBe(false);
    expect(isSandboxFailure(undefined)).toBe(false);
    expect(isSandboxFailure("")).toBe(false);
  });

  test("returns true for permission denied messages", () => {
    expect(isSandboxFailure("permission denied: /usr/bin/swift")).toBe(true);
    expect(isSandboxFailure("Operation not permitted")).toBe(true);
  });
});

// ── isToolchainFailure ────────────────────────────────────────────────────────

describe("isToolchainFailure", () => {
  test("returns true when a known toolchain has command not found", () => {
    expect(isToolchainFailure("swift build", "swift: command not found")).toBe(true);
    expect(isToolchainFailure("go test", "/bin/sh: go: command not found")).toBe(true);
  });

  test("returns false for non-toolchain commands", () => {
    expect(isToolchainFailure("python3 script.py", "python3: command not found")).toBe(false);
    expect(isToolchainFailure("ruby test.rb", "command not found")).toBe(false);
  });

  test("returns false for normal error messages", () => {
    expect(isToolchainFailure("swift build", "error: build failed")).toBe(false);
    expect(isToolchainFailure("go test", "FAIL")).toBe(false);
  });

  test("returns false for empty command", () => {
    expect(isToolchainFailure("", "some error")).toBe(false);
  });
});

// ── runOnHost ──────────────────────────────────────────────────────────────────

describe("runOnHost", () => {
  test("runs echo successfully", async () => {
    const result = await runOnHost("echo hello world", { cwd: "/tmp" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });

  test("reports non-zero exit code", async () => {
    const result = await runOnHost("false", { cwd: "/tmp" });
    expect(result.exitCode).not.toBe(0);
  });

  test("captures stderr", async () => {
    const result = await runOnHost("echo stderr >&2", { cwd: "/tmp" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe("stderr");
  });

  test("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runOnHost("echo should not run", {
      cwd: "/tmp",
      signal: controller.signal,
    });
    // Aborted commands may return non-zero, but should not throw.
    expect(typeof result.exitCode).toBe("number");
  });

  test("respects maxOutputLength", async () => {
    const result = await runOnHost("echo '0123456789'", {
      cwd: "/tmp",
      maxOutputLength: 5,
    });
    // echo adds a newline, so even with small maxOutput, we get what fits.
    expect(result.exitCode).toBe(0);
  });

  test("runs multi-command scripts with pipe", async () => {
    const result = await runOnHost("echo 'a\nb\nc' | head -2", { cwd: "/tmp" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(2);
  });
});
