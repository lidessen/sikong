/**
 * Interactive REPL for manually testing agent-loop runtimes + providers.
 *
 *   bun scripts/repl.ts [runtime] [options]
 *
 *   runtime : ai-sdk (default) | claude | codex | cursor | mock
 *
 * Provider (orthogonal to runtime) — one credential drives any runtime it supports:
 *   --provider deepseek|anthropic|openai|openai-compatible|gateway
 *   --api-key <key>        (else read from the provider's usual env var)
 *   --model <id>           model id (provider default otherwise)
 *   --base-url <url>       for --provider openai-compatible
 *   --provider-id <id>     for --provider openai-compatible (default "custom")
 *
 * Without --provider:
 *   ai-sdk uses DeepSeek via DEEPSEEK_API_KEY (or --gateway for AI Gateway);
 *   claude/codex/cursor use their native auth.
 *
 * Examples:
 *   bun scripts/repl.ts claude --provider deepseek      # Claude Code engine on DeepSeek
 *   bun scripts/repl.ts ai-sdk --provider deepseek
 *   bun scripts/repl.ts codex  --provider openai-compatible --base-url https://… --model m
 *
 * Type a prompt to run it. While a run streams, a bare line is sent as a steer.
 * Commands: /runtime /provider /model /caps /preflight /tool /steer /cancel /deny /help /quit
 */
import * as readline from "node:readline";
import {
  aiSdkLoop,
  anthropic,
  claudeCodeLoop,
  codexLoop,
  cursorLoop,
  deepseek,
  gateway,
  mockLoop,
  openai,
  openaiCompatible,
  type AgentLoop,
  type LoopEvent,
  type ModelProvider,
  type RunHandle,
} from "../src/index";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};
const paint = (c: string, s: string) => `${c}${s}${C.reset}`;

type Runtime = "ai-sdk" | "claude" | "codex" | "cursor" | "mock";
type ProviderKind = "deepseek" | "anthropic" | "openai" | "openai-compatible" | "gateway";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

let runtime = (argv.find((a) => !a.startsWith("--")) as Runtime) ?? "ai-sdk";
const opts = {
  providerKind: flag("--provider") as ProviderKind | undefined,
  apiKey: flag("--api-key"),
  model: flag("--model"),
  baseURL: flag("--base-url"),
  providerId: flag("--provider-id") ?? "custom",
  gateway: argv.includes("--gateway"),
  cwd: flag("--cwd") ?? process.cwd(),
  denyDestructive: argv.includes("--deny-destructive"),
};

// apiKey is optional everywhere: pass --api-key to override, otherwise the
// provider auto-discovers its conventional env var (DEEPSEEK_API_KEY, etc.).
function buildProvider(): ModelProvider | undefined {
  if (!opts.providerKind) return undefined;
  const key = opts.apiKey ? { apiKey: opts.apiKey } : {};
  const model = opts.model ? { model: opts.model } : {};
  switch (opts.providerKind) {
    case "deepseek":
      return deepseek({ ...key, ...model });
    case "anthropic":
      return anthropic({ ...key, ...model });
    case "openai":
      return openai({ ...key, ...model });
    case "gateway":
      return gateway({ ...key, model: opts.model ?? "deepseek/deepseek-chat" });
    case "openai-compatible":
      if (!opts.baseURL) throw new Error("--provider openai-compatible requires --base-url");
      return openaiCompatible({
        id: opts.providerId,
        ...key,
        baseURL: opts.baseURL,
        model: opts.model ?? "default",
      });
  }
}

async function buildLoop(name: Runtime): Promise<AgentLoop> {
  const provider = buildProvider();
  switch (name) {
    case "ai-sdk": {
      if (provider) return aiSdkLoop({ provider });
      if (opts.gateway) {
        return aiSdkLoop({ provider: gateway({ model: opts.model ?? "deepseek/deepseek-chat" }) });
      }
      return aiSdkLoop({ provider: deepseek(opts.model ? { model: opts.model } : {}) });
    }
    case "claude":
      return claudeCodeLoop({
        ...(provider ? { provider } : { model: opts.model ?? "sonnet" }),
        permissionMode: "bypassPermissions",
        cwd: opts.cwd,
      });
    case "codex":
      return codexLoop({
        ...(provider ? { provider } : opts.model ? { model: opts.model } : {}),
        fullAuto: true,
        sandbox: "workspace-write",
        cwd: opts.cwd,
      });
    case "cursor":
      return cursorLoop({ ...(opts.model ? { model: opts.model } : {}), cwd: opts.cwd });
    case "mock":
      return mockLoop({ response: "mock reply", thinking: "mock thinking", simulateTool: "demo" });
  }
}

let loop!: AgentLoop;
let activeRun: RunHandle | null = null;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function prompt() {
  const tag = opts.providerKind ? `${runtime}/${opts.providerKind}` : runtime;
  rl.setPrompt(paint(C.bold, `\nagent-loop:${tag}${activeRun ? " (running)" : ""}> `));
  rl.prompt();
}

async function setRuntime(name: Runtime) {
  if (loop) await loop.dispose().catch(() => {});
  runtime = name;
  try {
    loop = await buildLoop(name);
    console.log(paint(C.gray, `runtime=${loop.id}  capabilities=[${loop.capabilities.join(", ")}]`));
  } catch (e) {
    console.log(paint(C.red, `build failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}

function fmt(v: unknown, n = 140): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function printEvent(ev: LoopEvent) {
  switch (ev.type) {
    case "text":
      process.stdout.write(ev.text);
      break;
    case "thinking":
      process.stdout.write(paint(C.gray, ev.text));
      break;
    case "tool_call_start":
      console.log(paint(C.cyan, `\n  ⚙ ${ev.name}(${fmt(ev.args, 80)})`));
      break;
    case "tool_call_end":
      console.log(
        ev.error
          ? paint(C.red, `  ✗ ${ev.name}: ${fmt(ev.error)}`)
          : paint(C.gray, `  ✓ ${ev.name} -> ${fmt(ev.result, 80)}`),
      );
      break;
    case "usage":
      console.log(paint(C.gray, `\n  [usage in=${ev.inputTokens} out=${ev.outputTokens} (${ev.source})]`));
      break;
    case "steer":
      console.log(paint(C.magenta, `\n  ↻ steered (${ev.mode}): ${fmt(ev.message, 60)}`));
      break;
    case "error":
      console.log(paint(C.red, `\n  ⚠ ${ev.error.message}`));
      break;
  }
}

function runPrompt(text: string) {
  const run = loop.run({
    prompt: text,
    maxSteps: 12,
    hooks: {
      onToolUse: (c) => {
        if (
          opts.denyDestructive &&
          /\b(rm|rmdir|del|delete|drop)\b/i.test(JSON.stringify(c.args ?? {}) + " " + c.name)
        ) {
          console.log(paint(C.red, `\n  ⛔ denied ${c.name} (destructive)`));
          return { action: "deny", reason: "destructive op blocked by REPL" };
        }
        return { action: "continue" };
      },
    },
  });
  activeRun = run;
  void (async () => {
    try {
      for await (const ev of run) printEvent(ev);
      const r = await run.result;
      console.log(
        paint(
          r.status === "completed" ? C.green : C.yellow,
          `\n[${r.status}] ${r.durationMs}ms  usage=${r.usage.inputTokens}/${r.usage.outputTokens}/${r.usage.totalTokens}  text.len=${r.text.length}`,
        ),
      );
    } catch (e) {
      console.log(paint(C.red, `\n[error] ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      activeRun = null;
      prompt();
    }
  })();
}

const HELP = `
${paint(C.bold, "commands")}
  /runtime <ai-sdk|claude|codex|cursor|mock>   switch runtime (re-creates the loop)
  /provider <deepseek|anthropic|openai|gateway|openai-compatible|none>   set provider
  /model <id>        set model (re-creates the loop)
  /caps              show capabilities
  /preflight         run the runtime+provider preflight check
  /tool              run a demo prompt that should trigger a tool/command
  /steer <msg>       inject a steer message into the active run
  /cancel            cancel the active run
  /deny              toggle destructive-tool blocking (onToolUse demo)
  /help              this help
  /quit              exit
type anything else to run it as a prompt.`;

async function handle(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return prompt();

  if (!trimmed.startsWith("/")) {
    if (activeRun) {
      const o = await activeRun.steer(trimmed);
      console.log(paint(C.magenta, `  ↻ steer -> ${o.mode}`));
      return;
    }
    return runPrompt(trimmed);
  }

  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "help":
      console.log(HELP);
      break;
    case "quit":
    case "exit":
      if (loop) await loop.dispose().catch(() => {});
      rl.close();
      process.exit(0);
      break;
    case "runtime":
      await setRuntime((arg || "ai-sdk") as Runtime);
      break;
    case "provider":
      opts.providerKind = arg === "none" || !arg ? undefined : (arg as ProviderKind);
      console.log(paint(C.gray, `provider=${opts.providerKind ?? "(native)"}`));
      await setRuntime(runtime);
      break;
    case "model":
      opts.model = arg || undefined;
      await setRuntime(runtime);
      break;
    case "caps":
      console.log(paint(C.gray, `[${loop.capabilities.join(", ")}]`));
      break;
    case "preflight": {
      const pf = await loop.preflight();
      console.log(pf.ok ? paint(C.green, "preflight ok") : paint(C.red, `preflight: ${pf.reason}`));
      break;
    }
    case "tool":
      runPrompt("Use your shell/command tool to run `echo TOOL_OK`, then reply DONE.");
      return;
    case "steer":
      if (!activeRun) console.log(paint(C.yellow, "no active run"));
      else {
        const o = await activeRun.steer(arg);
        console.log(paint(C.magenta, `  ↻ steer -> ${o.mode}`));
      }
      break;
    case "cancel":
      if (!activeRun) console.log(paint(C.yellow, "no active run"));
      else activeRun.cancel("user");
      break;
    case "deny":
      opts.denyDestructive = !opts.denyDestructive;
      console.log(paint(C.gray, `denyDestructive=${opts.denyDestructive}`));
      break;
    default:
      console.log(paint(C.yellow, `unknown command /${cmd} (try /help)`));
  }
  prompt();
}

console.log(paint(C.bold, "agent-loop interactive REPL") + paint(C.gray, "  (/help for commands)"));
await setRuntime(runtime);
const pf = await loop.preflight().catch((e) => ({ ok: false, reason: String(e) }));
console.log(pf.ok ? paint(C.green, "preflight ok") : paint(C.yellow, `preflight: ${pf.reason ?? "n/a"} (you can still try)`));
prompt();
rl.on("line", (line) => {
  void handle(line);
});
rl.on("close", () => process.exit(0));
