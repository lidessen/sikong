{
  "task_id": "20260622-121500-sikong-v2",
  "goal": "Run 5 rounds of autonomous self-iteration using the dogfood loop, applying the correct principle: any level can be changed but with proportional care. Engine changes (D2) need stronger evidence than CLI changes (D1). Interface changes need stronger evidence than doc changes (D5).",
  "scope": "5 sequential dogfood runs. Each run chooses its own improvement direction. Observer records what was changed and at which layer.",
  "non_goals": [
    "Do NOT pre-constrain what can or cannot be changed",
    "Do NOT artificially restrict engine modifications",
    "Do NOT fix individual round failures unless the loop breaks entirely"
  ],
  "principles": {
    "layer_care": "Engine changes (D2 Arch) require stronger evidence than CLI changes (D1 Interface) than doc changes (D5 Meta). This is proportional care, not prohibition.",
    "evidence_standard": "An engine change should demonstrate: (a) specific problem evidence, (b) why this approach, (c) test coverage. A doc change needs: (a) what's inaccurate, (b) correction.",
    "verification": "cargo build and cargo test must pass regardless of layer changed. Engine changes additionally benefit from focused eval scenarios."
  },
  "success_criteria": [
    "At least 3 of 5 rounds produce commits (any status)",
    "At least 1 round demonstrates parallel decomposition (the 人民史观 pattern)",
    "All rounds complete without manual intervention",
    "Total tests remain green after all rounds"
  ],
  "verification_gates": [
    "cargo build must pass after each round",
    "Observer records what layer was changed before starting next round"
  ]
}
