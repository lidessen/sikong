/**
 * Live smoke for the runtime ⊥ provider design.
 * One DeepSeek key drives multiple runtimes; unsupported pairs throw.
 *
 *   DEEPSEEK_API_KEY=... bun scripts/smoke-provider.ts
 */
import {
  aiSdkLoop,
  claudeCodeLoop,
  codexLoop,
  deepseek,
  ProviderRuntimeError,
  type AgentLoop,
  type LoopEvent,
} from "../src/index";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY not set (run under your interactive shell).");
  process.exit(2);
}

const PROMPT = "Reply with exactly the token PROVIDER_OK and nothing else.";

async function runLoop(label: string, loop: AgentLoop): Promise<string> {
  const t0 = Date.now();
  const pf = await loop.preflight().catch((e) => ({ ok: false, reason: String(e) }));
  console.log(`\n[${label}] caps=[${loop.capabilities.join(",")}] preflight=${JSON.stringify(pf)}`);
  if (!pf.ok) {
    await loop.dispose().catch(() => {});
    return `${label}: SKIP (${pf.reason})`;
  }
  try {
    const run = loop.run({ prompt: PROMPT, maxSteps: 3 });
    let text = "";
    for await (const ev of run as AsyncIterable<LoopEvent>) {
      if (ev.type === "text") {
        text += ev.text;
        process.stdout.write(ev.text);
      } else if (ev.type === "error") {
        console.log(`\n  [error] ${ev.error.message}`);
      }
    }
    const r = await run.result;
    await loop.dispose().catch(() => {});
    const ok = r.status === "completed" && r.text.length > 0;
    return `${label}: ${ok ? "PASS" : "FAIL"} (${Date.now() - t0}ms, status=${r.status}, usage=${r.usage.totalTokens}, text="${r.text.trim().slice(0, 40)}")`;
  } catch (e) {
    await loop.dispose().catch(() => {});
    return `${label}: FAIL (threw: ${e instanceof Error ? e.message : String(e)})`;
  }
}

const summary: string[] = [];

// One provider value, reused across runtimes.
const provider = deepseek({ apiKey });

// 1) ai-sdk runtime on DeepSeek (in-process LanguageModel).
summary.push(await runLoop("ai-sdk × deepseek", aiSdkLoop({ provider })));

// 2) claude-code runtime on DeepSeek (Anthropic-wire endpoint, creds via child env).
//    This is the cross-runtime proof: the Claude Code engine running on DeepSeek.
summary.push(await runLoop("claude-code × deepseek", claudeCodeLoop({ provider })));

// 3) Honest rejection: codex cannot drive DeepSeek (Responses-wire vs Chat-only).
try {
  codexLoop({ provider });
  summary.push("codex × deepseek: FAIL (expected ProviderRuntimeError, got none)");
} catch (e) {
  const ok = e instanceof ProviderRuntimeError;
  summary.push(
    `codex × deepseek: ${ok ? "PASS" : "FAIL"} (threw ${e instanceof Error ? e.constructor.name : typeof e}: ${e instanceof Error ? e.message.slice(0, 80) : ""})`,
  );
}

console.log("\n################ SUMMARY ################");
for (const line of summary) console.log(line);
console.log("PROVIDER_SMOKE_COMPLETE");
