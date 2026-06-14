import { readFile } from "node:fs/promises";
import { runProcess } from "./run";
import type { ProcessRunResult, ProcessRunSpec } from "./types";

export interface ProcessRunnerResult {
  ok: true;
  data: ProcessRunResult;
}

export interface ProcessRunnerError {
  ok: false;
  error: {
    code: "invalid_input" | "process_error";
    message: string;
  };
}

export type ProcessRunnerOutput = ProcessRunnerResult | ProcessRunnerError;

export async function runProcessRunner(argv: readonly string[]): Promise<ProcessRunnerOutput> {
  try {
    const spec = await readSpec(argv);
    return {
      ok: true,
      data: await runProcess(spec),
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function readSpec(argv: readonly string[]): Promise<ProcessRunSpec> {
  const specPath = readFlag(argv, "spec");
  const text = specPath ? await readFile(specPath, "utf8") : await Bun.stdin.text();
  if (!text.trim()) throw new Error("process spec JSON is required");
  return JSON.parse(text) as ProcessRunSpec;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const token = String(argv[index] ?? "");
    if (token === `--${name}`) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`--${name} requires a value`);
      return String(value);
    }
    const prefix = `--${name}=`;
    if (token.startsWith(prefix)) return token.slice(prefix.length);
  }
  return undefined;
}

if (import.meta.main) {
  const result = await runProcessRunner(Bun.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
