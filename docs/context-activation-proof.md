# Context activation policy

## Ruling and purpose

Automatic boards and model interpretation have separate activation. The existing role-scoped config stores a context boolean beside publication enablement, default false. No schema change or new scheduler is introduced. The CLI opts in with `publication enable --context`. The exact existing role policy owns both flags. This realizes roadmap S3.5's artifact-only trial option without claiming the contextual outcome complete.

Three panel lenses approved this boundary. User harm: prevent repetitive or unsupported optional notes while required deterministic facts still publish. Product consistency: conditional activation was already in the accepted roadmap. Mechanism: guard both inference and the final request boundary, including after asynchronous channel lookup. Accepted cost: an interrupted inference is terminal for that source revision. Re-enabling can wait for a new source. Reopen if useful associations are silently counted complete, boards or human work are blocked by the model policy, or an unstarted context request begins after disable.

## Consumers and lifecycle

- Queue creation, active-work eligibility and late-result acceptance require context opt-in.
- Pending-note selection and both Gateway checks before a request require context opt-in. Board eligibility remains independently enabled.
- The existing watched binding signature includes the context flag, so a policy-only database write triggers cancellation without a registry event.
- Missing flag and restart default to no context inference. Explicit choice persists under the same operator and role. Changing operator removes authorization.
- Disable during inference aborts the bounded child through the existing cancellation path. A late answer cannot create a note. The source and its attempt remain in existing custody.
- Disable with a pending or claimed-but-unstarted note prevents its request. A pre-request refusal is recorded as not_sent and keeps the note pending. No delivered cursor advances.
- A request already initiated retains its actual result. Disable cannot unsend it. Existing unknown-send and restart rules remain in force.
- Expiry and empty source fields retain their existing source rules. No new timeout or fallback was added. The policy takes effect from the committed configuration read, not from a new clock.
- Human input, native acknowledgment, direct milestone commands and their custody remain independent.

## Proof

Three new publication scenarios exercise the actual default, SQLite reopen, CLI opt-in, watched policy-file events, active inference cancellation, late result rejection, continued boards, hidden pending notes and asynchronous channel lookup. The lookup scenario records zero send calls after disabling a previously claimed context note.

Two isolated negative controls remove inference eligibility checks or the second Gateway policy check. The first starts an unexpected model in default mode. The second makes the request instead of rejecting. Both fail their behavior assertions. Temporary copies were removed.

Companion run: 27 publication tests pass. The serial owning runner explicitly included surface.test.js, liaison-process.test.js, context-interpretation.test.js, publication.test.js, direct-post.test.js and publication-reference.test.js: 177 passed, 0 failed, 0 skipped, 18.315 seconds. All network/model responses in these mechanism tests are controlled. No installation, live two-vendor publication or broad model quality is claimed.

## Model evidence

The prospective three-case trial remained mostly repetitive. A subsequent four-call paired baseline-aware prompt experiment failed to reduce repetition. The candidate's synthetic positive returned invalid-output with raw cause unretained. The original positive also had an uncited attribution error. That prompt patch was rejected and removed. Reports are in outputs/context-prospective-trial and outputs/context-baseline-trial under the owning workspace. Contextual activation remains off pending evidence of useful meaning. The full sidecar goal remains active.
