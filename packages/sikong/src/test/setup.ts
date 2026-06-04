/**
 * Global test setup for sikong.
 *
 * Registers a process-level `unhandledRejection` handler so that unhandled
 * rejections (which Vitest silently swallows, exiting with code 1 while showing
 * all tests as "PASSED") are dumped with full stacks and force-exit the process.
 *
 * Remove once Vitest has built-in unhandledRejection surfacing.
 * https://github.com/vitest-dev/vitest/issues/3144
 */

process.on("unhandledRejection", (reason, promise) => {
  console.error("\n\x1b[31m=== UNHANDLED REJECTION ===\x1b[0m");
  console.error("Reason:", reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error && reason.stack) {
    console.error("Stack:\n" + indentStack(reason.stack));
  }
  console.error("Promise:", promise);
  // Set exit code without calling process.exit(1) — Vitest intercepts
  // process.exit() and wraps it in a secondary error ("process.exit unexpectedly
  // called"), which drowns out the original rejection. Setting exitCode avoids
  // that guard and lets Vitest's own rejection tracking surface the real error
  // while still ensuring a non-zero exit on unhandled rejections.
  process.exitCode = 1;
});

function indentStack(stack: string): string {
  return stack
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");
}
