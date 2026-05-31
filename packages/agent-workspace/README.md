# agent-workspace

The coordination layer over [`agent-loop`](../agent-loop) — **scope TBD (placeholder).**

Intended direction: a persistent substrate where multiple `agent-loop`
tasks/agents collaborate — shared state/filespace, a chronicle (event log), and
multi-agent orchestration (delegation, channels) — with `runTask` from
`agent-loop` as the single-agent execution primitive.

Today it only re-exports `agent-loop`'s task primitives so there's one import
surface as the real API lands:

```ts
import { runTask } from "agent-workspace";
```

## License

MIT
