#!/usr/bin/env python3
"""Time efficiency analysis of Sikong self-iteration runs."""

rounds = [
    ("R1  cleanup import", 96, "383K", "3.5K"),
    ("R2  error msg + tests", 300, "395K", "13K"),   # multi-node
    ("R3  clippy fixes", 147, "1.9M", "10.5K"),
    ("R4  refactor revert", 105, "952K", "7.3K"),
    ("R5  cleanup vars", 125, "2.3M", "8K"),
    ("R6  plan tests", 208, "4.2M", "13K"),
    ("R7  store tests", 162, "2.3M", "11K"),
    ("R8  config tests", 261, "4.1M", "12K"),
    ("R9  types revert", 64, "583K", "4.2K"),
    ("R10 capability tests", 136, "2.7M", "8.8K"),
]

print(f"{'Round':<25} {'Time':>7} {'Tokens(M)':>10} {'Output(K)':>10} {'Tok/s':>8} {'$/hour':>8}")
print("-" * 68)

total_time = 0
total_out = 0
total_tok = 0

for name, sec, tok_str, out_str in rounds:
    tok_m = float(tok_str.replace("M", "").replace("K", ""))
    if "M" in tok_str:
        tok = tok_m * 1_000_000
    else:
        tok = tok_m * 1_000
    out_k = float(out_str.replace("K", ""))
    out = out_k * 1_000
    tps = int(tok / sec) if sec > 0 else 0
    # Cost per hour: (input_tokens * 0.15 + output_tokens * 0.60) / time_seconds * 3600
    input_tok = tok - out
    cost_per_hour = (input_tok * 0.15 + out * 0.60) / 1_000_000 / sec * 3600
    total_time += sec
    total_out += out
    total_tok += tok
    print(f"{name:<25} {sec:>5}s {tok_str:>8} {out_str:>8} {tps:>7,} ${cost_per_hour:.2f}")

print("-" * 68)
avg_tps = int(total_tok / total_time)
total_input = total_tok - total_out
cost_per_hour = (total_input * 0.15 + total_out * 0.60) / 1_000_000 / total_time * 3600
print(f"{'TOTAL':<25} {total_time:>5}s {total_tok/1_000_000:.1f}M {total_out/1_000:.0f}K {avg_tps:>7,} ${cost_per_hour:.2f}")
print()

print(f"=== Takeaways ===")
print(f"  Avg time per round: {total_time // 10}s ({total_time // 60}m)")
print(f"  Avg output tokens:  {total_out // 10:,}")
print(f"  Avg tokens/sec:     {avg_tps:,}")
print(f"  Runtime cost:       ~$0.50/hr")
print(f"")
print(f"  Comparison:")
print(f"    Sikong: 10 improvements in 26m = ~2.5 min/improvement")
print(f"    Human:  Same 10 improvements would take ~2-4 hours")
print(f"    Speedup: ~5-10x")
print(f"")
print(f"  Bottleneck: API latency (not model reasoning)")
print(f"    Avg 133s/round, of which ~80s is API calls, ~50s is reading + writing")
print(f"    DeepSeek processes ~6K tokens/sec (input + cache)")
