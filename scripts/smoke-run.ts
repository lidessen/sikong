/**
 * All-in-one live smoke runner (new factory API).
 *
 *   bun scripts/smoke-run.ts [claude|codex|cursor|ai-sdk|all]
 */
import {
  aiSdkLoop,
  claudeCodeLoop,
  codexLoop,
  cursorLoop,
  type AgentLoop,
  type LoopEvent,
} from "../src/index";

type Backend = "claude" | "codex" | "cursor" | "ai-sdk";
const ALL: Backend[] = ["ai-sdk", "claude", "codex", "cursor"];

const arg = (process.argv[2] ?? "all").toLowerCase();
const targets: Backend[] = arg === "all" ? ALL : [arg as Backend];

async function makeLoopFor(name: Backend): Promise<AgentLoop> {
  switch (name) {
    case "claude":
      return claudeCodeLoop({ model: "sonnet", permissionMode: "bypassPermissions" });
    case "codex":
      return codexLoop({ fullAuto: true, sandbox: "workspace-write" });
    case "cursor":
      return cursorLoop({});
    case "ai-sdk": {
      const { deepseek } = await import("@ai-sdk/deepseek");
      return aiSdkLoop({ model: deepseek("deepseek-chat") });
    }
  }
}

function short(v: unknown, n = 100): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function runOne(name: Backend): Promise<string> {
  const t0 = Date.now();
  console.log(`\n========== ${name} ==========`);
  const loop = await makeLoopFor(name);
  console.log("capabilities:", loop.capabilities.join(", "));

  let pf;
  try {
    pf = await loop.preflight();
  } catch (e) {
    pf = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  console.log("preflight:", JSON.stringify(pf));
  if (!pf.ok) {
    await loop.dispose().catch(() => {});
    return `${name}: SKIP (preflight: ${short(pf.reason)})`;
  }

  const types = new Map<string, number>();
  let errored = "";
  try {
    const run = loop.run({
      prompt: "Reply with exactly the token SMOKE_OK and nothing else. Do not use any tools.",
      maxSteps: 4,
      hooks: { onToolUse: () => ({ action: "continue" }) },
    });
    for await (const ev of run as AsyncIterable<LoopEvent>) {
      types.set(ev.type, (types.get(ev.type) ?? 0) + 1);
      if (ev.type === "text") process.stdout.write(ev.text);
      else if (ev.type === "error") errored = ev.error.message;
    }
    const result = await run.result;
    console.log(
      `\n  status=${result.status} dur=${result.durationMs}ms ` +
        `usage=${result.usage.inputTokens}/${result.usage.outputTokens}/${result.usage.totalTokens} ` +
        `text.len=${result.text.length}`,
    );
    console.log("  events:", [...types.entries()].map(([t, n]) => `${t}:${n}`).join(", "));
    await loop.dispose().catch(() => {});
    const ok = result.status === "completed" && result.text.length > 0 && !errored;
    return `${name}: ${ok ? "PASS" : "FAIL"} (${Date.now() - t0}ms, status=${result.status}${errored ? ", err=" + short(errored) : ""})`;
  } catch (e) {
    await loop.dispose().catch(() => {});
    return `${name}: FAIL (threw: ${short(e instanceof Error ? e.message : String(e))})`;
  }
}

const summary: string[] = [];
for (const b of targets) summary.push(await runOne(b));

console.log("\n################ SUMMARY ################");
for (const line of summary) console.log(line);
console.log("SMOKE_SUITE_COMPLETE");
