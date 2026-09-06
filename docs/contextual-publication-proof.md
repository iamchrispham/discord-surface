# Contextual automatic publication

Selected automatic publication now runs the bounded Luna-low interpreter outside the deterministic publication drain. The board does not wait for model completion. A useful current result becomes one separately labeled note under the same successful-send cadence. Quiet, invalid, interrupted and superseded interpretations add no message.

## Router plan

- Objective: add useful contextual publication without generating routine conductor turns.
- Domain or lane: Gateway publication and optional inference.
- Scope: one inference slot, durable attempt state, context delivery custody and wakeup.
- Likely files: src/publication/context.js, store.js, publisher.js and test/publication.test.js.
- Architectural pattern: Workflow Coordinator with separate inference and delivery custody.
- Pattern rationale: the existing interpreter owns process limits and schema validation. The publisher owns source identity, cadence and Discord delivery.
- Blast radius: source staging queues interpretation once per owner/source sequence. Context claim uses persisted state. Completion checks the source sequence and owner before adding a context post. The shared pending selector prioritizes boards and requires a context note's originating board to be delivered. Unknown context delivery blocks further context but does not block newer boards. Existing echo exclusion and human references apply to both post kinds. Native input routing is unchanged.
- Lifecycle matrix: detailed below.
- Risks: optional inference delaying boards, stale output, repeated inference after restart, and uncertain optional delivery silencing deterministic status.
- Validation level: owning suite, delayed and cancelled model scenarios, restart scenarios, actual bounded child-process integration, negative controls and independent review.
- Why this belongs here: the same Gateway owns publication policy and cadence. No second message scheduler or native conductor session is introduced.
- Expected output: board first, then at most one current contextual note for its source occurrence.

## Panel ruling and lifecycle

User-harm, mechanism and product-consistency lenses approved a useful late note taking the next eligible cadence slot without another source event. Waiting indefinitely for a new event would strand useful context. Accepted cost: one additional optional note per source occurrence, sharing the existing one-publication-per-minute routine limit. New deterministic evidence has priority. The note is labeled as a possible connection and carries evidence references, not action authority.

One publisher-owned slot launches inference outside the drain. Other selected bindings can publish their boards while waiting. The interpreter's existing 32 KiB input, 8 KiB result and 60-second execution bounds remain unchanged. It uses subscription authentication and disables tools. These are process-local bounds within the existing single Gateway owner, not a new machine-wide scheduler.

Source or binding changes cancel active stale work. Completion cannot add a note for a different source sequence, owner or disabled role. The normal send drain rereads sources before sending pending content. Source expiry disqualifies inference work and retains deterministic stale-source behavior. No result revives a superseded pending post.

The attempt is claimed durably before launch. Ready results atomically create a post in the existing ledger. Result-before-send restart retains pending custody and remaining cadence. Sent notes do not resend. An abandoned running attempt becomes interrupted at startup and is not automatically inferred again. Accepted cost: the interrupted optional note may be lost until a new source occurrence. Deterministic status remains available.

An uncertain optional send remains unknown and is never blindly retried. New boards remain eligible. Context notes wait behind both their originating board and unresolved contextual custody. A confirmed echo schedules the existing drain. Shutdown marks the worker closed, aborts its bounded child, removes existing subscriptions/timers and awaits outstanding work. No separate recurring timer or source poller is added.

Reopen the ruling if current useful context misses its cadence opportunity without a new source event, repeated restarts create model or message duplicates, historical interpretation revives after a source change, or model work delays a deterministic board.

## Pre-install schema boundary

This candidate extends the unpublished publication-v1 schema with post kind, originating board ID and interpretation attempt rows. It is not an upgrade path for a database created by an earlier unpublished candidate. Those databases fail the existing DDL compatibility check. A read-only production check confirmed no publication-schema marker and no publication tables. Recheck this before rollout. No live database was opened through the candidate or changed during this work.

## Local evidence

All six registered files ran serially: test/surface.test.js, test/liaison-process.test.js, test/context-interpretation.test.js, test/publication.test.js, test/direct-post.test.js and test/publication-reference.test.js. Result: 174 passed, 0 failed, 0 skipped, 18,062.4405 ms.

The 24 publication checks include delayed interpretation with an immediate board, useful result wakeup without a source event, supersession, shutdown, unknown context isolation, result-before-send restart, sent-result restart, interrupted attempts and two selected bindings sharing one interpreter slot. A real bounded child process writes schema-valid output, which passes the actual interpreter and becomes a contextual publication. The child exits and its temporary directory is removed.

Independent adversarial review found no remaining concrete issue. Two negative controls remove completion wakeup and optional-uncertainty isolation separately. The former must fail awaiting the context note. The latter must fail awaiting the newer board.

Network and model responses in these checks are controlled. A real prospective Luna trial, interpretation quality, live Discord publication and both-provider rollout remain required. This implementation does not close the sidecar goal.
