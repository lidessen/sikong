/**
 * Interactive REPL for manually testing agent-loop backends.
 *
 *   bun scripts/repl.ts [backend] [--model <id>] [--gateway] [--cwd <dir>] [--deny-destructive]
 *
 *   backend : ai-sdk (default) | claude | codex | cursor | mock
 *   --model : model id (ai-sdk: deepseek model or gateway string; claude: opus|sonnet|haiku)
 *   --gateway : for ai-sdk, route through the Vercel AI Gateway via a "provider/model" string
 *
 * Type a line to run it as a prompt. While a run streams you can type:
 *   /steer <msg>   inject a steer message (live on codex, deferred elsewhere)
 *   /cancel        cancel the active run
 * Anytime:
 *   /backend <n>   switch backend       /model <id>   set model (re-creates loop)
 *   /caps          show capabilities    /preflight    run preflight
 *   /tool          run a tool-triggering demo prompt
 *   /help          help                 /quit         exit
 */
import * as readline from "node:readline";
import {
  aiSdkLoop,
  claudeCodeLoop,
  codexLoop,
  cursorLoop,
  mockLoop,
  type AgentLoop,
  type LoopEvent,
  type RunHandle,
} from "../src/index";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
const paint = (c: string, s: string) => `${c}${s}${C.reset}`;

type Backend = "ai-sdk" | "claude" | "codex" | "cursor" | "mock";

interface Opts {
  model?: string;
  gateway: boolean;
  cwd?: string;
  denyDestructive: boolean;
}

const argv = process.argv.slice(2);
let backend = (argv.find((a) => !a.startsWith("--")) as Backend) ?? "ai-sdk";
const opts: Opts = {
  model: flagValue("--model"),
  gateway: argv.includes("--gateway"),
  cwd: flagValue("--cwd") ?? process.cwd(),
  denyDestructive: argv.includes("--deny-destructive"),
};

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function buildLoop(name: Backend): Promise<AgentLoop> {
  switch (name) {
    case "ai-sdk": {
      let model: unknown;
      if (opts.gateway) {
        model = opts.model ?? "deepseek/deepseek-chat"; // routed via AI_GATEWAY_API_KEY
      } else {
        const { deepseek } = await import("@ai-sdk/deepseek");
        model = deepseek(opts.model ?? "deepseek-chat");
      }
      return aiSdkLoop({ model: model as never });
    }
    case "claude":
      return claudeCodeLoop({
        model: opts.model ?? "sonnet",
        permissionMode: "bypassPermissions",
        cwd: opts.cwd,
      });
    case "codex":
      return codexLoop({ model: opts.model, fullAuto: true, sandbox: "workspace-write", cwd: opts.cwd });
    case "cursor":
      return cursorLoop({ model: opts.model, cwd: opts.cwd });
    case "mock":
      return mockLoop({ response: "mock reply", thinking: "mock thinking", simulateTool: "demo" });
  }
}

let loop: AgentLoop;
let activeRun: RunHandle | null = null;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function prompt() {
  rl.setPrompt(paint(C.bold, `\nagent-loop:${backend}${activeRun ? " (running)" : ""}> `));
  rl.prompt();
}

async function setBackend(name: Backend) {
  if (loop) await loop.dispose().catch(() => {});
  backend = name;
  loop = await buildLoop(name);
  console.log(
    paint(C.gray, `backend=${loop.id}  capabilities=[${loop.capabilities.join(", ")}]`),
  );
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
      console.log(
        paint(C.gray, `\n  [usage in=${ev.inputTokens} out=${ev.outputTokens} (${ev.source})]`),
      );
      break;
    case "steer":
      console.log(paint(C.magenta, `\n  ↻ steered (${ev.mode}): ${fmt(ev.message, 60)}`));
      break;
    case "hook":
      console.log(paint(C.gray, `  · hook ${ev.name}/${ev.hookEvent} ${ev.phase}`));
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
        if (opts.denyDestructive && /\b(rm|rmdir|del|delete|drop)\b/i.test(JSON.stringify(c.args ?? {}) + " " + c.name)) {
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
  /backend <ai-sdk|claude|codex|cursor|mock>   switch backend
  /model <id>        set model (re-creates the loop)
  /gateway           toggle AI Gateway routing for ai-sdk (re-creates loop)
  /caps              show capabilities
  /preflight         run the backend preflight check
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
      // A bare line while running == steer for convenience.
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
    case "backend":
      await setBackend((arg || "ai-sdk") as Backend);
      break;
    case "model":
      opts.model = arg || undefined;
      await setBackend(backend);
      break;
    case "gateway":
      opts.gateway = !opts.gateway;
      console.log(paint(C.gray, `gateway=${opts.gateway}`));
      await setBackend(backend);
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
      return; // runPrompt re-prompts
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
await setBackend(backend);
const pf = await loop.preflight().catch((e) => ({ ok: false, reason: String(e) }));
console.log(pf.ok ? paint(C.green, "preflight ok") : paint(C.yellow, `preflight: ${pf.reason ?? "n/a"} (you can still try)`));
prompt();
rl.on("line", (line) => {
  void handle(line);
});
rl.on("close", () => process.exit(0));
