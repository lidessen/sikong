#!/usr/bin/env python3
"""Quick efficiency stats from recent dogfood runs."""

# Recent runs from bash-170 to bash-173 (4 M5 push cycles)
runs = [
    # bash-170: max steps, failed
    {"spec": {"in": 1777, "out": 799, "cache": 0}, "exec": None, "ver": None},
    # bash-171: full cycle, passed
    {"spec": {"in": 113, "out": 697, "cache": 1664},
     "exec": {"in": 36243, "out": 6233, "cache": 572288},
     "ver": {"in": 5809, "out": 2065, "cache": 21504}},
    # bash-172: full cycle, passed
    {"spec": {"in": 113, "out": 863, "cache": 1664},
     "exec": {"in": 11636, "out": 3695, "cache": 70912},
     "ver": {"in": 4614, "out": 1902, "cache": 19840}},
    # bash-173: full cycle, passed
    {"spec": {"in": 113, "out": 767, "cache": 1664},
     "exec": {"in": 66774, "out": 4178, "cache": 768128},
     "ver": {"in": 7955, "out": 2879, "cache": 53504}},
]

total_tokens = 0
total_cost = 0.0
cycle_count = 0

print(f"{'Cycle':>6} {'Specify':>20} {'Execute':>20} {'Verify':>20} {'Cache%':>8} {'Time':>8}")
print("-" * 82)

for i, r in enumerate(runs):
    if r["exec"] is None:
        # failed run
        s = r["spec"]
        spec_tok = s["in"] + s["out"]
        print(f"  #{i+1:>3}  {spec_tok:>8,}t ({s['in']:>5,}+{s['out']:>4,})  {'(max steps)':>20}  {'(max steps)':>20}  {'--':>7}  {'--':>7}")
        continue

    s = r["spec"]
    e = r["exec"]
    v = r["ver"]
    spec_tok = s["in"] + s["out"]
    exec_tok = e["in"] + e["out"]
    ver_tok = v["in"] + v["out"]
    cache = s["cache"] + e["cache"] + v["cache"]
    active = spec_tok + exec_tok + ver_tok
    cache_pct = cache * 100 // (cache + active) if (cache + active) > 0 else 0
    total = spec_tok + exec_tok + ver_tok

    total_tokens += total
    cost = (e["in"] * 0.15 + e["out"] * 0.60 + s["in"] * 0.15 + s["out"] * 0.60 + v["in"] * 0.15 + v["out"] * 0.60) / 1_000_000
    total_cost += cost
    cycle_count += 1

    time_str = {0: "89s", 1: "122s", 2: "114s"}.get(i, "??s")
    print(f"  #{i+1:>3}  {spec_tok:>8,}t ({s['in']:>5,}+{s['out']:>4,})  {exec_tok:>8,}t ({e['in']:>5,}+{e['out']:>4,})  {ver_tok:>8,}t ({v['in']:>5,}+{v['out']:>4,})  {cache_pct:>6}%  {time_str:>7}")

print("-" * 82)
print(f"\nPassed cycles: {cycle_count}/4")
print(f"Total tokens:  {total_tokens:,}")
print(f"Total cost:    ${total_cost:.3f}")
print(f"Avg cost/cycle: ${total_cost/max(cycle_count,1):.4f}")
print(f"Avg tokens/cycle: {total_tokens//max(cycle_count,1):,}")

# Running six-month totals
print()
print("=== All-Time (this session, ~50+ cycles) ===")
print(f"Estimated total tokens: ~30M")
print(f"Estimated total cost:   ~$15-20")
print(f"Estimated time:         ~90 minutes wall clock")
print(f"Estimated commits:      ~50")
print(f"Cost per commit:        ~$0.35")
