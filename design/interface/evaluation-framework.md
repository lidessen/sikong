# Evaluation Metrics Framework

**Status:** Draft (+) — 2026-06-22

**Governs:** `src/task_run/*` metrics collection, `src/cli.rs` eval/metrics commands, `evals/benchmarks/*.yaml`

**Layer:** L1 — Command & Interface

---

## Purpose

The existing eval framework (`design/eval-framework.md`) provides a live evaluation system for functional correctness — it runs scenarios through the engine and judges whether the execution shape was appropriate. This document adds a **metrics layer** on top: quantitative performance measurement across iterations, enabling comparison of engine versions, prompt changes, provider choices, and runtime profiles.

The metrics framework answers:

- Is this engine version faster or more token-efficient than the last?
- Which runtime profile (`general` vs `code`) is more cost-effective for a given task class?
- How much does prompt caching reduce cost in practice?
- What is the quality-adjusted cost per iteration?
- How do different providers (DeepSeek, Kimi) compare on the same task?

---

## (a) Key Metrics Per Iteration

Every metrics-collecting run records the following computed metrics, derived from raw agent-run records (`AgentRunRecord`), the `EngineReport`, and the judge verdict.

### Metric Definitions

| #   | Metric                          | Formula                                                                                                                           | Unit              | Purpose                                                                                                    |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| M1  | **Token Efficiency**            | `(total_input_tokens + total_output_tokens) / max(content_chars, 1)`                                                              | tokens/char       | How many tokens the engine spends per character of final accepted artifact. Lower is better.               |
| M2  | **Time Efficiency**             | `total_duration_ms / max(content_chars, 1)`                                                                                       | ms/char           | Wall-clock speed per character of output. Lower is better.                                                 |
| M3  | **Cost Efficiency**             | `(input_tokens * input_price + output_tokens * output_price + cache_creation_tokens * cache_write_price) / max(content_chars, 1)` | $/char            | Estimated monetary cost per output character. Uses configurable price constants (see §Price Constants).    |
| M4  | **Quality-Adjusted Efficiency** | `M3 * (1 - quality_bonus)` where `quality_bonus = 0.0` if judge fails, `0.25` if judge passes                                     | $/char (adjusted) | Cost efficiency penalized when the judge rejects the result, or rewarded when it passes.                   |
| M5  | **Cache Effectiveness**         | `sum(cache_read_tokens) / max(sum(input_tokens) + sum(cache_read_tokens), 1) * 100`                                               | %                 | What fraction of prompt tokens were served from cache. Higher means better reuse.                          |
| M6  | **Comparative Baseline Delta**  | `M1_current - M1_baseline` (similarly for M2, M3, M4)                                                                             | varies            | Absolute difference from a stored baseline for the same scenario + provider + runtime profile combination. |

### Raw Data Sources

Each computed metric derives from fields already present in the engine's `AgentRunRecord`:

```
AgentRunRecord {
    duration_ms: u128,
    usage: Option<AgentTokenUsage> {
        input_tokens, output_tokens, active_tokens,
        total_tokens, cache_read_tokens, cache_creation_tokens
    }
}
```

And the final artifact:

```
EngineReport {
    artifact_text: Option<String>,
    agent_runs: Vec<AgentRunRecord>,
    status: NodeStatus
}
```

Plus the judge verdict:

```
TaskRunSplitJudgement {
    passed: bool,
    findings: Vec<String>,
    evidence: Vec<String>
}
```

### Per-Operation vs Per-Task Aggregation

Metrics are computed at two levels:

- **Per-operation:** Each `AgentRunRecord` produces its own M1–M6 values, keyed by `(node_id, operation)`. This tells you whether `Specify`, `Plan`, `Execute`, `Combine`, or `Verify` is the bottleneck.
- **Per-task (aggregate):** Summed across all `agent_runs` in the report. `M1` uses `sum(input_tokens + output_tokens)` over all runs; `M2` uses `sum(duration_ms)`. `M5` uses aggregate cache-read over aggregate input + cache-read.

---

## (b) Standardized Performance Test Scenario Definition

A performance test scenario extends the existing eval YAML format with a `benchmark` section.

```yaml
# evals/benchmarks/token-efficiency-baseline.yaml
id: token-efficiency-baseline
task: |
  Read design/recursive-agent-engine.md and summarize the control/execution
  split in three paragraphs. Do not modify any files.
expectation: |
  The agent must produce a three-paragraph summary grounded in the document.
  Passing requires correct identification of Rust (control) and Bun (execution)
  layers. This is a simple atomic task; the engine should not decompose it.
workspace:
  provider: current-file-system
  read_scope:
    - design/recursive-agent-engine.md
benchmark:
  category: comprehension
  min_tolerance_tokens: 200
  max_tolerance_tokens: 6000
  min_tolerance_ms: 2000
  max_tolerance_ms: 60000
  min_content_length: 100
  tags:
    - baseline
    - token-efficiency
```

### Benchmark Fields

| Field                            | Type     | Required | Description                                                                                                   |
| -------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `benchmark.category`             | string   | yes      | Semantic category: `comprehension`, `code-gen`, `design`, `review`, `routing`, `planning`                     |
| `benchmark.min_tolerance_tokens` | integer  | no       | Floor below which token count is suspiciously low (may indicate degenerate output).                           |
| `benchmark.max_tolerance_tokens` | integer  | no       | Ceiling above which token count triggers a warning in reports.                                                |
| `benchmark.min_tolerance_ms`     | integer  | no       | Suspiciously fast run floor.                                                                                  |
| `benchmark.max_tolerance_ms`     | integer  | no       | Suspiciously slow run ceiling.                                                                                |
| `benchmark.min_content_length`   | integer  | no       | Minimum acceptable artifact character count.                                                                  |
| `benchmark.tags`                 | string[] | no       | Free-form labels for filtering and grouping: `baseline`, `regression`, `smoke`, `nightly`, `provider-a-vs-b`. |

### Baseline Scenario Library

The following built-in scenarios form the initial benchmark suite:

| ID                         | Category      | Task Shape                             | Expected Size |
| -------------------------- | ------------- | -------------------------------------- | ------------- |
| `bm-comprehend-design-doc` | comprehension | Summarize a design doc                 | small         |
| `bm-codegen-small-fn`      | code-gen      | Write a single Rust function from spec | small         |
| `bm-design-review`         | review        | Review a design doc for gaps           | medium        |
| `bm-route-simple-qa`       | routing       | Route a simple Q&A task                | tiny          |
| `bm-plan-medium-task`      | planning      | Plan a medium implementation task      | medium        |
| `bm-execute-file-read`     | comprehension | Read and report on a specific file     | tiny          |

---

## (c) Structured Tracking Format

### Core Metrics Record (JSON Schema)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "IterationMetrics",
  "type": "object",
  "properties": {
    "schema_version": {
      "type": "integer",
      "description": "Schema version for forward compat. Current: 1.",
      "const": 1
    },
    "run": {
      "type": "object",
      "description": "Run identification metadata.",
      "properties": {
        "timestamp": { "type": "string", "format": "date-time" },
        "scenario_id": { "type": "string" },
        "engine_version": { "type": "string", "description": "Git commit hash or semver." },
        "provider": { "type": "string", "enum": ["deepseek", "kimi", "mock"] },
        "runtime_profile": { "type": "string", "enum": ["general", "code"] }
      },
      "required": ["timestamp", "scenario_id", "engine_version", "provider", "runtime_profile"]
    },
    "judgement": {
      "type": "object",
      "properties": {
        "passed": { "type": "boolean" },
        "findings": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["passed"]
    },
    "artifact": {
      "type": "object",
      "properties": {
        "content_length": { "type": "integer" },
        "status": { "type": "string" }
      },
      "required": ["content_length", "status"]
    },
    "per_operation": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "node_id": { "type": "integer" },
          "operation": { "type": "string" },
          "metrics": { "$ref": "#/$defs/MetricSet" }
        },
        "required": ["node_id", "operation", "metrics"]
      }
    },
    "aggregate_metrics": {
      "$ref": "#/$defs/MetricSet"
    },
    "baseline_delta": {
      "type": "object",
      "description": "Difference from stored baseline if one exists.",
      "properties": {
        "token_efficiency": { "type": "number" },
        "time_efficiency": { "type": "number" },
        "cost_efficiency": { "type": "number" },
        "quality_adjusted_efficiency": { "type": "number" },
        "cache_effectiveness": { "type": "number" }
      }
    }
  },
  "required": [
    "schema_version",
    "run",
    "judgement",
    "artifact",
    "per_operation",
    "aggregate_metrics"
  ],
  "$defs": {
    "MetricSet": {
      "type": "object",
      "properties": {
        "token_efficiency": { "type": "number", "description": "tokens per char (M1)" },
        "time_efficiency": { "type": "number", "description": "ms per char (M2)" },
        "cost_efficiency": { "type": "number", "description": "USD per char (M3)" },
        "quality_adjusted_efficiency": {
          "type": "number",
          "description": "adj. USD per char (M4)"
        },
        "cache_effectiveness": { "type": "number", "description": "cache hit ratio (M5)" }
      },
      "required": [
        "token_efficiency",
        "time_efficiency",
        "cost_efficiency",
        "quality_adjusted_efficiency",
        "cache_effectiveness"
      ]
    }
  }
}
```

### Price Constants

Cost efficiency depends on configurable per-provider price constants, stored in `~/.sikong/metrics.yaml`:

```yaml
# ~/.sikong/metrics.yaml
metrics:
  price_constants:
    deepseek:
      input_per_token: 0.000000014 # $0.014 / 1M input tokens
      output_per_token: 0.000000028 # $0.028 / 1M output tokens
      cache_write_per_token: 0.000000011 # $0.011 / 1M cache creation tokens
    kimi:
      input_per_token: 0.000000016
      output_per_token: 0.000000032
      cache_write_per_token: 0.000000013
    mock:
      input_per_token: 0.0
      output_per_token: 0.0
      cache_write_per_token: 0.0
  baseline_dir: "~/.sikong/metrics-baselines/"
```

### Structured Log Format (Streaming Variant)

For streaming or append-only logging (e.g., CI runs, development-log), use a compact JSONL format with one metrics record per line:

```jsonl
{
  "ts": "2026-06-22T10:00:00Z",
  "sid": "bm-comprehend-design-doc",
  "ver": "abc1234",
  "prov": "deepseek",
  "prof": "general",
  "passed": true,
  "clen": 2450,
  "m1": 2.1,
  "m2": 8.3,
  "m3": 0.000042,
  "m4": 0.000031,
  "m5": 67
}
```

Fields:

| Field    | Alias                       | Source                                        |
| -------- | --------------------------- | --------------------------------------------- |
| `ts`     | timestamp                   | run.timestamp                                 |
| `sid`    | scenario_id                 | run.scenario_id                               |
| `ver`    | engine_version              | run.engine_version                            |
| `prov`   | provider                    | run.provider                                  |
| `prof`   | runtime_profile             | run.runtime_profile                           |
| `passed` | —                           | judgement.passed                              |
| `clen`   | content_length              | artifact.content_length                       |
| `m1`     | token_efficiency            | aggregate_metrics.token_efficiency            |
| `m2`     | time_efficiency             | aggregate_metrics.time_efficiency             |
| `m3`     | cost_efficiency             | aggregate_metrics.cost_efficiency             |
| `m4`     | quality_adjusted_efficiency | aggregate_metrics.quality_adjusted_efficiency |
| `m5`     | cache_effectiveness         | aggregate_metrics.cache_effectiveness         |

---

## (d) CLI Command Interface Design

### New Commands

#### `siko eval metrics <scenario>`

Run one or more scenarios and compute metrics.

```bash
# Run metrics for a built-in benchmark scenario
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics bm-comprehend-design-doc

# Run all benchmarks in the baseline library
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics --all

# Run benchmarks filtered by tag
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics --tag baseline

# Run with specific provider/runtime for A/B comparison
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics bm-codegen-small-fn \
  --provider deepseek --runtime general

# Output as JSON (default is terminal table)
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics bm-comprehend-design-doc --json

# Save to a metrics log file (appends JSONL)
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics bm-comprehend-design-doc \
  --log ~/.sikong/metrics-log.jsonl

# Route-only mode for metrics (stops after Plan, measures route cost)
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics bm-route-simple-qa --route-only
```

**Flags:**

| Flag              | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `--scenario`      | Scenario ID (positional).                                                   |
| `--all`           | Run all built-in benchmark scenarios.                                       |
| `--tag`           | Filter built-in benchmarks by tag.                                          |
| `--provider`      | Provider override (`deepseek`, `kimi`).                                     |
| `--runtime`       | Runtime profile override (`general`, `code`).                               |
| `--json`          | Print full structured JSON (IterationMetrics schema).                       |
| `--log <path>`    | Append compact JSONL to the given path.                                     |
| `--route-only`    | Stop after root route decision (no execution).                              |
| `--save-baseline` | Store aggregate metrics as the baseline for this scenario+provider+runtime. |

#### `siko eval metrics-compare <scenario>`

Compare current run metrics against a stored baseline.

```bash
# Compare against stored baseline
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics-compare bm-comprehend-design-doc

# Compare two specific runs by log entry index
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics-compare \
  --from-log ~/.sikong/metrics-log.jsonl --entry-a 0 --entry-b 3

# Tabulate a comparison matrix across providers
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics-compare bm-codegen-small-fn \
  --providers deepseek,kimi --runtimes general,code
```

**Flags:**

| Flag                     | Description                                                 |
| ------------------------ | ----------------------------------------------------------- |
| `--scenario`             | Scenario ID (positional).                                   |
| `--baseline-dir`         | Override baseline directory.                                |
| `--from-log`             | Read metrics from a JSONL log file instead of running live. |
| `--entry-a`, `--entry-b` | Index entries in a log file to compare.                     |
| `--providers`            | Comma-separated provider list for comparison matrix.        |
| `--runtimes`             | Comma-separated runtime profile list for comparison matrix. |
| `--json`                 | Print structured comparison output.                         |

#### `siko eval metrics-list`

List stored benchmarks, baselines, and log entries.

```bash
# List all benchmark scenarios
cargo run -- eval metrics-list

# List stored baselines
cargo run -- eval metrics-list --baselines

# Show summary of metrics log
cargo run -- eval metrics-list --log ~/.sikong/metrics-log.jsonl
```

**Flags:**

| Flag           | Description                                     |
| -------------- | ----------------------------------------------- |
| `--baselines`  | Show stored baselines instead of scenario list. |
| `--log <path>` | Summarize a metrics log file.                   |
| `--json`       | Print structured output.                        |

### Integration with Existing Commands

The existing `eval task-run-split` and `dogfood run` commands gain optional `--metrics` and `--metrics-log` flags:

```bash
# Existing eval with metrics output
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval task-run-split \
  --scenario simple-qa --json --metrics

# Dogfood with metrics logging
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- dogfood run \
  --scenario simple-qa --log --metrics --metrics-log ~/.sikong/metrics-log.jsonl
```

### Suggested Rust Types

```rust
// src/evaluation/metrics.rs (new module)

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct IterationMetrics {
    pub schema_version: u32,
    pub run: RunMetadata,
    pub judgement: JudgementSummary,
    pub artifact: ArtifactSummary,
    pub per_operation: Vec<OperationMetrics>,
    pub aggregate_metrics: MetricSet,
    pub baseline_delta: Option<MetricSet>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MetricSet {
    pub token_efficiency: f64,          // M1
    pub time_efficiency: f64,           // M2
    pub cost_efficiency: f64,           // M3
    pub quality_adjusted_efficiency: f64, // M4
    pub cache_effectiveness: f64,       // M5
}

impl MetricSet {
    pub fn compute(
        usage: &AgentTokenUsage,
        duration_ms: u128,
        content_length: usize,
        passed: bool,
        prices: &PriceConstants,
    ) -> Self { /* ... */ }
}
```

---

## (e) Report Format

### Terminal Table (Default)

When `--json` is not specified, `eval metrics` prints a formatted table:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Metrics: bm-comprehend-design-doc                                  │
│  Provider: deepseek  ·  Runtime: general  ·  Passed: ✓             │
├─────────────────────────────────────────────────────────────────────┤
│  Metric                          Value      vs Baseline   Unit     │
│  Token efficiency (M1)            2.10      +0.15         tok/char │
│  Time efficiency (M2)             8.30      -1.20         ms/char  │
│  Cost efficiency (M3)             0.000042  +0.000005     $/char   │
│  Quality-adj. efficiency (M4)     0.000031  +0.000004     $/char   │
│  Cache effectiveness (M5)        67.0%      +5.2%         %        │
├─────────────────────────────────────────────────────────────────────┤
│  Artifact: 2,450 chars · Status: Committed                         │
│  Operations: Specify(1), Execute(1), Verify(1), Commit(1)          │
│  Total tokens: 8,200 in · 4,100 out · 1,200 cache                  │
│  Total duration: 20.3s                                             │
└─────────────────────────────────────────────────────────────────────┘
```

### Per-Operation Breakdown (Table Variant)

`--per-op` flag adds a breakdown table:

```
┌───────────────────────────────────────────────────────────────────────┐
│  Per-Operation Breakdown                                              │
├─────────┬────────────┬──────────┬──────────┬──────────┬───────────────┤
│ Node    │ Operation  │ M1       │ M2       │ M3       │ Duration (s)  │
├─────────┼────────────┼──────────┼──────────┼──────────┼───────────────┤
│ 1       │ Specify    │ 0.45     │ 1.20     │ 0.000009 │ 2.9           │
│ 1       │ Execute    │ 1.50     │ 6.10     │ 0.000030 │ 14.9          │
│ 1       │ Verify     │ 0.12     │ 0.80     │ 0.000002 │ 2.0           │
│ 1       │ Commit     │ 0.03     │ 0.20     │ 0.000001 │ 0.5           │
├─────────┼────────────┼──────────┼──────────┼──────────┼───────────────┤
│ Total   │            │ 2.10     │ 8.30     │ 0.000042 │ 20.3          │
└─────────┴────────────┴──────────┴──────────┴──────────┴───────────────┘
```

### Comparison Table

`eval metrics-compare` prints a comparison view:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Comparison: bm-codegen-small-fn                                         │
│  A: deepseek/general (current)  ·  B: deepseek/general (baseline)       │
├────────────────────────────────┬────────────┬────────────┬───────────────┤
│  Metric                        │ A (this)   │ B (base)   │ Δ (A - B)     │
├────────────────────────────────┼────────────┼────────────┼───────────────┤
│  Token efficiency (tok/char)   │ 1.80       │ 2.10       │ -0.30 ✓       │
│  Time efficiency (ms/char)     │ 6.50       │ 8.30       │ -1.80 ✓       │
│  Cost efficiency ($/char)      │ 0.000036   │ 0.000042   │ -0.000006 ✓   │
│  Quality-adj. eff. ($/char)    │ 0.000027   │ 0.000031   │ -0.000004 ✓   │
│  Cache effectiveness (%)       │ 72.0       │ 67.0       │ +5.0 ✓        │
├────────────────────────────────┴────────────┴────────────┴───────────────┤
│  Judgement: both passed                                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Provider Comparison Matrix

`eval metrics-compare --providers deepseek,kimi --runtimes general,code` prints a grid:

```
┌───────────────────────────┬──────────────────────┬──────────────────────┐
│  M1: Token Efficiency     │ deepseek             │ kimi                 │
├───────────────────────────┼──────────────────────┼──────────────────────┤
│  general                  │ 2.10 tok/char        │ 2.45 tok/char        │
│  code                     │ 1.95 tok/char        │ 2.30 tok/char        │
└───────────────────────────┴──────────────────────┴──────────────────────┘
```

### JSON Output

When `--json` is specified, `eval metrics` prints the full `IterationMetrics` JSON object (see §(c) schema). `eval metrics-compare --json` prints:

```json
{
  "comparison": {
    "scenario": "bm-codegen-small-fn",
    "a": { "run": {...}, "aggregate_metrics": {...} },
    "b": { "run": {...}, "aggregate_metrics": {...} },
    "delta": {
      "token_efficiency": -0.30,
      "time_efficiency": -1.80,
      "cost_efficiency": -0.000006,
      "quality_adjusted_efficiency": -0.000004,
      "cache_effectiveness": 5.0
    }
  }
}
```

---

## Implementation Sketch

### Module Structure

```
src/
  evaluation/
    mod.rs          — Re-exports, top-level MetricsEngine
    metrics.rs      — IterationMetrics, MetricSet, compute functions
    prices.rs       — PriceConstants, load/save from YAML
    baseline.rs     — Baseline storage, load/save/compare
    log.rs          — MetricsLog reader/writer (JSONL)
    report.rs       — Terminal table rendering, JSON serialization
    cli.rs          — CLI command handlers for eval metrics, metrics-compare,
                      metrics-list
```

### Dependencies

| Crate                               | Use                          |
| ----------------------------------- | ---------------------------- |
| `clap` (existing)                   | CLI argument parsing         |
| `serde` / `serde_json` (existing)   | JSON schema serialization    |
| `schemars` (existing)               | JSON Schema generation       |
| `config` (existing)                 | YAML price constants loading |
| `prettytable-rs` or custom `tabled` | Terminal table rendering     |

### Integration Points

1. **EngineReport → IterationMetrics:** Add a `From<(&EngineReport, &JudgementSummary, &PriceConstants)>` impl on `IterationMetrics`.
2. **Existing eval flow:** `run_task_run_split_eval_async` collects the engine report and judge verdict; add a post-processing step that calls `IterationMetrics::from(...)` when `--metrics` is set.
3. **Baseline storage:** Simple JSON files in `~/.sikong/metrics-baselines/<scenario_id>-<provider>-<runtime>.json`.
4. **Metrics log:** Append-only JSONL file. `MetricsLog::append(path, record)` and `MetricsLog::read(path) -> Vec<IterationMetrics>`.

### Price Constants Resolution

```
1. Default built-in prices (see §Price Constants)
   ↓ overridden by
2. ~/.sikong/metrics.yaml file
   ↓ overridden by
3. Environment variables:
   SIKONG_METRICS_PRICE_DEEPSEEK_INPUT
   SIKONG_METRICS_PRICE_DEEPSEEK_OUTPUT
   SIKONG_METRICS_PRICE_DEEPSEEK_CACHE_WRITE
   SIKONG_METRICS_PRICE_KIMI_INPUT
   ...
```

---

## Relationship to Existing Eval Framework

| Aspect  | Eval Framework (`eval-framework.md`)                   | Metrics Framework (this doc)                                    |
| ------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| Purpose | Functional correctness, execution shape                | Quantitative performance, cost, speed                           |
| Input   | YAML scenario + judge rubric                           | Same YAML scenario + price constants                            |
| Output  | `TaskRunSplitJudgement { passed, findings, evidence }` | `IterationMetrics { aggregate, per_operation, baseline_delta }` |
| Judge   | Separate agent-loop agent with `finish_eval`           | Reuses the same judge verdict for quality adjustment            |
| Storage | Artifact dir (optional), dev-log                       | Metrics log (JSONL), baseline dir (JSON)                        |
| Cost    | Token usage (raw)                                      | Estimated dollar cost (priced)                                  |
| Command | `eval task-run-split`                                  | `eval metrics`, `eval metrics-compare`                          |

The metrics framework **extends** rather than replaces the eval framework. A metrics run is an eval run plus post-processing. Metrics output is an optional sidecar on existing eval and dogfood commands.

---

## Appendix: Example Metrics Run End-to-End

```bash
# 1. Run a benchmark with metrics
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics bm-comprehend-design-doc \
  --provider deepseek --runtime general --json --save-baseline

# 2. After an engine change, run again
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics bm-comprehend-design-doc \
  --provider deepseek --runtime general --json --log ~/.sikong/metrics-log.jsonl

# 3. Compare with baseline
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics-compare bm-comprehend-design-doc

# 4. Run full benchmark suite
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics --all --tag baseline \
  --log ~/.sikong/metrics-log.jsonl

# 5. Tabulate provider comparison
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval metrics-compare bm-codegen-small-fn \
  --providers deepseek,kimi --runtimes general,code --json
```
