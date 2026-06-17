import { createDefaultRuntimeAssemblyRegistry, type DefaultAgentRuntime } from "@sikong/workspace";
import type { AgentLoop } from "agent-loop";

interface PooledRuntime {
  key: string;
  loop: AgentLoop;
}

let pooled: PooledRuntime | null = null;

function runtimeKey(runtime: DefaultAgentRuntime): string {
  return JSON.stringify({
    backend: runtime.backend,
    provider: runtime.provider ?? "",
    model: runtime.model ?? "",
  });
}

function runtimeOptions(runtime: DefaultAgentRuntime): Record<string, string> {
  return {
    ...(runtime.provider ? { provider: runtime.provider } : {}),
    ...(runtime.model ? { model: runtime.model } : {}),
  };
}

async function disposePooled(): Promise<void> {
  if (!pooled) return;
  const loop = pooled.loop;
  pooled = null;
  await loop.dispose?.().catch(() => {});
}

export async function borrowClientAgentLoop(runtime: DefaultAgentRuntime): Promise<AgentLoop> {
  const key = runtimeKey(runtime);
  if (pooled?.key === key) return pooled.loop;

  await disposePooled();
  const assembly = await createDefaultRuntimeAssemblyRegistry().createExecutionRuntime({
    backend: {
      name: runtime.backend,
      options: runtimeOptions(runtime),
    },
  });
  if (!assembly.loop) {
    throw new Error("client agent backend did not create an agent loop");
  }
  pooled = { key, loop: assembly.loop };
  return assembly.loop;
}

export async function invalidateClientRuntimePool(): Promise<void> {
  await disposePooled();
}
