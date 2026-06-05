import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { evalAcceptanceCheck } from "./eval-acceptance";
import type { AcceptanceCheck } from "../workflow/types";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "eval-acc-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("evalAcceptanceCheck — command", () => {
  test("passes on exit 0", async () => {
    const r = await evalAcceptanceCheck(
      { kind: "command", description: "true", cmd: "true" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(true);
    expect(r.checkDescription).toBe("true");
    expect(r.evidence).toContain("exit code: 0 (expected: 0)");
  });

  test("fails on non-zero exit", async () => {
    const r = await evalAcceptanceCheck(
      { kind: "command", description: "false", cmd: "false" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("exit code: 1 (expected: 0)");
    expect(r.suggestion).toBeDefined();
  });

  test("honours custom expectExit", async () => {
    const r = await evalAcceptanceCheck(
      { kind: "command", description: "expect 42", cmd: "node", expectExit: 42 },
      { cwd: tmp },
    );
    // `node` with no args exits 1 (not 42), so this should fail
    // Use a known command that exits 42
    const r2 = await evalAcceptanceCheck(
      { kind: "command", description: "expect 42", cmd: "exit 42", expectExit: 42 },
      { cwd: tmp },
    );
    expect(r2.passed).toBe(true);
    expect(r2.evidence).toContain("exit code: 42 (expected: 42)");
  });

  test("captures stdout as evidence", async () => {
    const r = await evalAcceptanceCheck(
      { kind: "command", description: "echo", cmd: "echo 'hello world'" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain("hello world");
  });

  test("captures stderr as evidence and suggestion on failure", async () => {
    const r = await evalAcceptanceCheck(
      { kind: "command", description: "stderr test", cmd: "node -e console.error('oops');process.exit(1)" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("oops");
    expect(r.suggestion).toContain("oops");
  });

  test("empty cmd returns structured failure (not a throw)", async () => {
    const r = await evalAcceptanceCheck(
      { kind: "command", description: "empty", cmd: "   " },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("empty");
    expect(r.suggestion).toBeDefined();
  });

  test("missing binary returns structured failure (not a throw)", async () => {
    const r = await evalAcceptanceCheck(
      { kind: "command", description: "no-binary", cmd: "nonexistent-binary-999999" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
  });
});

describe("evalAcceptanceCheck — fileExists", () => {
  test("passes when file exists", async () => {
    await writeFile(join(tmp, "present.txt"), "content");
    const r = await evalAcceptanceCheck(
      { kind: "fileExists", description: "check present", path: "present.txt" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain("present.txt");
  });

  test("fails when file does not exist", async () => {
    const r = await evalAcceptanceCheck(
      { kind: "fileExists", description: "check missing", path: "missing.txt" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("does not exist");
    expect(r.suggestion).toBeDefined();
    expect(r.suggestion).toContain("not found");
  });

  test("lists directory contents in suggestion on failure", async () => {
    await mkdir(join(tmp, "sub"));
    await writeFile(join(tmp, "sub", "a.txt"), "");
    await writeFile(join(tmp, "sub", "b.txt"), "");
    const r = await evalAcceptanceCheck(
      { kind: "fileExists", description: "check in sub", path: "sub/missing.txt" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.suggestion).toContain("a.txt");
    expect(r.suggestion).toContain("b.txt");
  });

  test("accepts absolute paths", async () => {
    const abs = join(tmp, "absolute.txt");
    await writeFile(abs, "content");
    const r = await evalAcceptanceCheck(
      { kind: "fileExists", description: "absolute path", path: abs },
      { cwd: tmp },
    );
    expect(r.passed).toBe(true);
    expect(r.evidence).toBe(abs);
  });
});

describe("evalAcceptanceCheck — grep", () => {
  test("passes when pattern is found and expectMatch is true", async () => {
    await writeFile(join(tmp, "test.txt"), "hello world\nfoo bar\nbaz");
    const r = await evalAcceptanceCheck(
      { kind: "grep", description: "find hello", path: "test.txt", pattern: "hello", expectMatch: true },
      { cwd: tmp },
    );
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain("1:hello world");
  });

  test("fails when pattern is not found and expectMatch is true", async () => {
    await writeFile(join(tmp, "test.txt"), "hello world");
    const r = await evalAcceptanceCheck(
      { kind: "grep", description: "find missing", path: "test.txt", pattern: "zzz", expectMatch: true },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.suggestion).toBeDefined();
    expect(r.suggestion).toContain("zzz");
  });

  test("passes when pattern is absent and expectMatch is false", async () => {
    await writeFile(join(tmp, "test.txt"), "hello world");
    const r = await evalAcceptanceCheck(
      { kind: "grep", description: "no zzz", path: "test.txt", pattern: "zzz", expectMatch: false },
      { cwd: tmp },
    );
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain("confirmed absent");
  });

  test("fails when pattern is found and expectMatch is false", async () => {
    await writeFile(join(tmp, "test.txt"), "hello world\nzzz");
    const r = await evalAcceptanceCheck(
      { kind: "grep", description: "no zzz", path: "test.txt", pattern: "zzz", expectMatch: false },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("zzz");
    expect(r.suggestion).toBeDefined();
    expect(r.suggestion).toContain("unexpectedly found");
  });

  test("handles multiple matches and evidence truncation", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `match ${i}`);
    await writeFile(join(tmp, "multi.txt"), lines.join("\n"));
    const r = await evalAcceptanceCheck(
      { kind: "grep", description: "multi", path: "multi.txt", pattern: "^match", expectMatch: true },
      { cwd: tmp },
    );
    expect(r.passed).toBe(true);
    // Evidence should show 5 matches + "more" note
    expect(r.evidence).toContain("more matches");
  });

  test("invalid regex returns structured failure", async () => {
    await writeFile(join(tmp, "test.txt"), "hello");
    const r = await evalAcceptanceCheck(
      { kind: "grep", description: "bad regex", path: "test.txt", pattern: "[unclosed", expectMatch: true },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("invalid regex");
    expect(r.suggestion).toBeDefined();
  });

  test("missing file returns structured failure", async () => {
    const r = await evalAcceptanceCheck(
      { kind: "grep", description: "no file", path: "nonexistent.txt", pattern: "test", expectMatch: true },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("could not read");
  });
});

describe("evalAcceptanceCheck — projectGate", () => {
  test("passes when typecheck and test pass", async () => {
    // Create a minimal project with passing scripts
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "test-proj",
        scripts: { typecheck: "true", test: "true" },
      }),
    );
    const r = await evalAcceptanceCheck(
      { kind: "projectGate", description: "project gate" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain("typecheck");
    expect(r.evidence).toContain("test");
  });

  test("fails when typecheck fails", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "test-proj",
        scripts: { typecheck: "false", test: "true" },
      }),
    );
    const r = await evalAcceptanceCheck(
      { kind: "projectGate", description: "project gate" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.suggestion).toContain("typecheck failed");
  });

  test("fails when test fails", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "test-proj",
        scripts: { typecheck: "true", test: "false" },
      }),
    );
    const r = await evalAcceptanceCheck(
      { kind: "projectGate", description: "project gate" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.suggestion).toContain("test failed");
  });

  test("fails when both fail", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "test-proj",
        scripts: { typecheck: "false", test: "false" },
      }),
    );
    const r = await evalAcceptanceCheck(
      { kind: "projectGate", description: "project gate" },
      { cwd: tmp },
    );
    expect(r.passed).toBe(false);
    expect(r.suggestion).toContain("typecheck failed");
    expect(r.suggestion).toContain("test failed");
  });
});
