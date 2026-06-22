#!/usr/bin/env python3
"""Calculate token cost from dogfood run outputs."""

# Data collected from 10 autonomous-iteration runs (all JSON output)
# Format: (input, output, cache_read) - from the agent-loop result lines
runs = [
    # Round 1: cleanup unused import
    {"input": 28555, "output": 3657, "cache": 351872, "active": 32212},
    # Round 2: error message + tests (multi-node)
    {"input": 74489, "output": 4409, "cache": 290944, "active": 78898},  # child 2
    {"input": 37925, "output": 6214, "cache": 357632, "active": 44139},  # child 3
    {"input": 5391, "output": 2063, "cache": 36864, "active": 7454},     # child 4
    # Round 3: clippy fixes
    {"input": 42498, "output": 10527, "cache": 1856128, "active": 53025},
    # Round 4 retry: refactor revert
    {"input": 44359, "output": 7281, "cache": 951808, "active": 51640},
    # Round 5: cleanup vars/continues
    {"input": 73782, "output": 8042, "cache": 2334848, "active": 81824},
    # Round 6: plan_from_scope tests
    {"input": 107092, "output": 13165, "cache": 4236544, "active": 120257},
    # Round 7: task_board::store tests
    {"input": 82113, "output": 10971, "cache": 2267008, "active": 93084},
    # Round 8 retry: config.rs tests
    {"input": 105943, "output": 12367, "cache": 4114048, "active": 118310},
    # Round 9 retry: types.rs restoration
    {"input": 50422, "output": 4238, "cache": 582528, "active": 54660},
    # Round 10: CapabilityProfile/Budget tests
    {"input": 95399, "output": 8834, "cache": 2725760, "active": 104233},
]

total_input = sum(r["input"] for r in runs)
total_output = sum(r["output"] for r in runs)
total_cache = sum(r["cache"] for r in runs)
total_active = sum(r["active"] for r in runs)

print(f"=== Token Usage: {len(runs)} runs ===")
print()
print(f"  Total input:       {total_input:>10,}")
print(f"  Total output:      {total_output:>10,}")
print(f"  Total (in+out):    {total_input + total_output:>10,}")
print(f"  Cache reads:       {total_cache:>10,}")
print(f"  Active tokens:     {total_active:>10,}")
print(f"  Cache hit rate:    {total_cache * 100 // (total_cache + total_active)}%")
print()

# DeepSeek v4 Flash pricing
# Input: $0.15/M tokens (cache hits: $0.015/M)
# Output: $0.60/M tokens

input_cost = total_input * 0.15 / 1_000_000
cache_cost = total_cache * 0.015 / 1_000_000
output_cost = total_output * 0.60 / 1_000_000

print(f"=== DeepSeek v4 Flash Cost ===")
print(f"  Fresh input:  ${input_cost:.2f}")
print(f"  Cached input: ${cache_cost:.2f}")
print(f"  Output:       ${output_cost:.2f}")
print(f"  Total:        ${input_cost + cache_cost + output_cost:.2f}")
print()

# Per-run average
print(f"=== Per-Run Average ===")
print(f"  Avg input:   {total_input // len(runs):>6,}")
print(f"  Avg output:  {total_output // len(runs):>6,}")
print(f"  Avg cost:    ${(input_cost + cache_cost + output_cost) / len(runs):.2f}")
print(f"  Avg time:    ~120s")
print()

# Total time
times = [96, 300, 147, 105, 125, 208, 162, 261, 64, 136]
total_seconds = sum(times)
print(f"=== Total Wall Clock Time ===")
print(f"  Total: {total_seconds}s ({total_seconds // 60}m {total_seconds % 60}s)")
print(f"  Avg:   {total_seconds // len(runs)}s per run")
print()
print(f"=== Delivered ===")
print(f"  10 commits, 10 autonomous improvements")
print(f"  Tests added for: engine, task_board, config, types")
print(f"  Code quality: clippy fixes, unused imports, error messages")
print(f"  Self-healing: 2 build-breaking changes automatically reverted")
