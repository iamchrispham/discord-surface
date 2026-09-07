# Sidecar experiment: shelved

The operator shelved the model interpretation experiment on September 6, 2026. Preserve the implementation for possible extraction into a future fleet overview in Discord #general. Do not continue model comparisons or activate automatic interpretation as part of the current milestone-delivery work.

## Preserved implementation

- Bounded source snapshots and explicit missing, stale and empty field handling.
- Deterministic publication, delivery history, ownership checks and reference forwarding.
- Distinct durable-save and actual native-recognition acknowledgments.
- Bounded subscription runner and experimental contextual interpretation.

These components are candidates for reuse, not independently approved libraries or proof that fleet interpretation works. Keep native-session authority and delivery custody with their existing owners when extracting them.

## Evidence and limits

The code parent ee77ebf0489292246bd3cd658e0ede14d021e6b1 passed the local owning suite: 233 tests across seven registered files, zero failed or skipped. This documentation-only change does not rerun or transfer that test claim to a different runtime implementation.

A pinned earlier candidate, 9c7b830b0fd126c5f35f2cf45a5ee2957474fc94, was exercised in existing Codex and Claude sessions. Both produced message-specific native acknowledgment and correct replies, with both reaction types read back in Discord. Codex also answered a human-authored test reply to an automatic board with its exact historical publication reference. These scoped checks do not prove all publication, compaction or lifecycle behavior. The later delivered-history input is source-only.

Both automatic publication policies were disabled after the bounded pilot. Interpretation was never enabled. The reviewed model outputs did not meet semantic acceptance. No claimed quota savings, successful model selection or full product completion follows from this work.

## Active work

Milestones remain conductor-authored. The separate milestone-post change supplies explicit idempotent sends and follow-ups. A conductor can append a landing, blocker or ruling during the work turn that establishes it, using facts already in context. Routine round details remain in the beacon and PR body. Human-grade events keep the established phone path.

The future fleet overview is deferred, including its source-coverage and semantic tests. Cross-agent Discord wakeup remains separately deferred. If Node is retained, the operator requires TypeScript before further feature expansion. This note does not authorize a Rust cutover or change live bindings, native sessions or service ownership.
