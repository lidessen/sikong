# 0024 - Grounded acceptance gates: worker submits evidence, lead decides

Status: Accepted (revised 2026-06-06)
Date: 2026-06-05

## Context - what the dogfood proved

A single hard task (the chiling operator console) failed repeatedly, and smaller
tasks showed the same pattern in subtler forms:

- A worker requested a transition even though the requirement was not met.
- Workers did the easy part, dropped the hard part, and still wrote convincing
  completion prose.
- Verification claims were sometimes static review or fabricated evidence rather
  than commands that actually ran.
- Generic green tests did not prove that the requested behavior was implemented.

The root cause is not only that completion was self-reported. It is that sikong
had no explicit acceptance handoff between the worker who did the work and the
lead who owns whether the work is good enough.

The previous design tried to solve this with an engine/verifier worker that ran
machine checks and generated a verdict/correction loop. Dogfood made that feel
too heavy for the current product shape. The simpler, more durable boundary is:
the worker submits evidence; the lead reviews it and records the acceptance
decision.

## Decision

Completion gates are grounded in explicit evidence plus an explicit lead decision.
The engine records and enforces the decision; it does not independently judge the
work.

### 1. Acceptance expectations as data

A task/stage can carry structured `AcceptanceCheck[]` expectations authored by
the workflow, lead, client, or delegating parent. These are review criteria, not
engine-executed code:

- `command`: the command the worker should run and report, including exit code
  and relevant output;
- `fileExists`: the artifact/path the worker should cite;
- `grep`: the pattern expectation the worker should address;
- `projectGate`: shorthand for the project's standard verification evidence,
  normally typecheck plus tests.

The worker cannot mutate these expectations after task creation.

### 2. Worker submits evidence

At an acceptance-bearing stage, the worker uses `submit_evidence` to record a
structured evidence bundle:

- a concise summary;
- command evidence with command, exit code, output, and pass/fail claim;
- changed files and artifact paths where useful.

The worker may still request a transition, but evidence plus a transition request
does not complete the gate. It only tells the lead: "this is ready for review."

### 3. Lead accepts or rejects

Only the lead/engine source can record `acceptance_decision`:

- `accepted` records `acceptance.accepted`;
- `rejected` records `acceptance.rejected`.

The `acceptancePassed` guard is true only after the latest decision in the
current stage is `accepted`. A worker cannot accept its own work. A rejection
keeps the task open so the lead can re-wake, adjust instructions, decompose,
escalate effort, or stop.

### 4. Keep the loop simple

There is no separate automatic verifier worker, no engine-side verdict event, and
no built-in correction loop. Those may be added later if lead review becomes the
bottleneck, but they are not part of this decision.

For now, sikong keeps the authority boundary clear:

- worker: do the work and submit evidence;
- lead: review evidence against the brief and decide pass/fail;
- engine: persist the events and enforce that `done` requires lead acceptance.

## Why this is the high-leverage fix

- It directly removes self-acceptance while keeping the mechanism small.
- It turns vague completion prose into reviewable evidence.
- It keeps subjective/product judgment with the lead instead of pretending all
  acceptance can be reduced to machine checks.
- It still supports deterministic project checks, but as evidence for review
  rather than an automatic verdict.

## Relationship to other ADRs

- Strengthens **0015** by requiring adversarial verification evidence before lead
  acceptance.
- Makes **0016** safer because promotion still needs explicit lead approval.
- Aligns with **0025** phase gates: each phase boundary can ask the lead to accept
  or reject the evidence before moving on.
- Refines **0027**: task-level acceptance checks are lead-authored review
  criteria, not engine-run verifier inputs.

## Consequences

- Completion means the lead accepted the submitted evidence, not that the worker
  claimed success.
- The current CLI/API surface needs commands for evidence submission and lead
  decisions.
- If the lead wants extra certainty, they can run commands themselves or require
  richer evidence before accepting.
- The abandoned automatic verifier/correction-loop design remains a future
  option, but it is no longer the accepted default.
