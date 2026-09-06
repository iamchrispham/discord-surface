# Discord decision interactions roadmap

Status: proposed implementation plan. This PR changes documentation only. No decision buttons, canonical-owner facade, or decision notification path are implemented by it.

## Outcome

An operator away from the computer can answer a conductor's specific question in its Discord channel and see whether the answer was saved, recognized, and acted upon. Preserve the existing persistent Codex or Claude session. Reuse the canonical question/answer owner behind the Telegram decision flow.

Pilot one concise question message with conductor-defined buttons, including Research. Show the recommendation and reason, each choice's consequence, and the existing scope and expiry. Do not infer missing recommendations. Exact replies are a fallback if buttons fail the interaction deadline or phone usability test, not another interface to build upfront. Native polls do not remove the need for canonical single-answer settlement, correlation, or withdrawal handling.

The conductor supplies the question, permitted choices, target and authority. Spark or Luna may later explain recorded context. Neither owns approvals, obligations, choices, or execution. Research retains its existing meaning: investigate within existing authority, never approve the proposed action. A later approval requires a new question occurrence. Preserve the existing TTL and first valid canonical answer policy.

## Evidence boundary

Repository inspection is pinned to main [`1f95869f1f9ff11250c338919f0d586f2a9ee79f`](https://github.com/iamchrispham/discord-surface/tree/1f95869f1f9ff11250c338919f0d586f2a9ee79f), September 6, 2026.

- [Gateway](https://github.com/iamchrispham/discord-surface/blob/1f95869f1f9ff11250c338919f0d586f2a9ee79f/src/discord.js): the existing client registers `messageCreate`, with no `interactionCreate` handler found. Reuse this client and installed `discord.js`.
- [Native delivery](https://github.com/iamchrispham/discord-surface/blob/1f95869f1f9ff11250c338919f0d586f2a9ee79f/src/native.js): Codex queues to an existing task. Claude uses HTTP over its bound Unix socket. Current prompts and reply markers belong to chat messages.
- [Claude Monitor](https://github.com/iamchrispham/discord-surface/blob/1f95869f1f9ff11250c338919f0d586f2a9ee79f/src/claude-monitor.js): `createMonitorMcp` checks `state.getMessage` and rejects events without matching accepted chat custody. A decision is not already a supported event type.
- [Binding and recovery](https://github.com/iamchrispham/discord-surface/blob/1f95869f1f9ff11250c338919f0d586f2a9ee79f/src/state.js): handoff is explicit and refuses unresolved message custody. Interrupted dispatch becomes uncertain, not automatically safe to repeat.

External source inspected locally: canonical skills `phone-notify/scripts/tg-ask.sh`, `tg-producer-enqueue.mjs`, `tg-ack-settlement.mjs`, `tg-question-generation.mjs`, and the generation-aware answer reader in `telegram-local-api`. This is supplied integration evidence, not a versioned API in this repository. The owning skills maintainer must verify its current source before implementation.

Registration currently writes the question and then queues Telegram delivery. Settlement uses the producer lock and claim/archive/answer records, but its exported function is not a complete validated public boundary. Some checks and recovery remain in transport-specific callers. The proposed facade below does not exist yet.

PR 1 at `c26c00d1d348207070253a68981c9cf7185e50e8` and PR 3 at `e47465e3f36eb599223e545f87dc8e3cd6f02254` were open when this plan was drafted. Their APIs are not assumed on the inspected main. Recheck merged capabilities before implementation. Rust work and measurements remain deferred.

## Contract and ownership

**D1. One question authority.** Identify an occurrence by `(qid, question_generation)`. The canonical owner alone accepts answers. Discord stores authenticated requests, canonical-result references and delivery progress in its existing SQLite database. It never manufactures canonical answer files or establishes a second winning answer.

**D2. Separate recipient identities.** Keep the canonical lane/run target and its explicit conductor mapping distinct from provider, native UUID and binding generation. Account login changes do not create sessions or alter question identity. A reused `qid` does not revive old controls.

**D3. Small supported facade.** The canonical producer/settlement owner exposes registration, occurrence lookup, settlement, result lookup and resumable change enumeration. Prefer a short-lived tokenless command invoked with preserved argument boundaries if the inspected owner supports that shape. No direct import of an incompletely validated `settle` function. No new permanent service merely to wrap it.

The authenticated transport verifies the operator and Discord context. Under the existing producer lock, the facade independently verifies the occurrence, allowed key, registered target/authority, expiry, withdrawal and conflict state. Caller-supplied menus or labels cannot grant authority. The owner completes interrupted valid claims under the original policy. Discord-only registration must not implicitly queue Telegram delivery.

**D4. Decision custody, shared transport.** Add a narrowly scoped decision-notification path in the existing database and Gateway. Share queue-command invocation and Unix HTTP primitives. Extend the same Claude listener with a decision-specific envelope and custody validation. Use canonical settlement references and explicit decision recognition. Do not fabricate a Discord message ID or pass a button through ordinary chat reply markers.

This notification tells the existing conductor to consume the canonical answer using both `qid` and `question_generation`. The existing answer consumer remains the sole action owner. There is no second execution path for Discord answers.

**D5. Applicability before activation and execution.** Before settlement and notification, validate the presented occurrence, current binding and any canonical required-head constraint. A displayed head is not automatically an enforceable constraint. The authority owner must state its meaning. The action consumer revalidates at execution admission and uses the existing action mechanism to enforce the required revision and authority.

If context changes after saving, retain the historical answer and report "saved; not applied because context changed." The current authorized conductor reconciles applicability. Changed meaning or authority requires withdrawal/reissue, not silent reinterpretation. An unchanged question can survive explicit authority-preserving handoff with the same question generation and refreshed controls. Old binding-specific controls become stale. Never automatically rebind unresolved submitted work. Decision custody must participate in existing handoff guards.

**D6. Status follows evidence.** Use these distinct observations:

- Callback received or deferred: "Checking selection." No durability claim.
- Canonical owner confirms completed answer: "Selection saved." An intermediate claim or local intent is insufficient.
- Current native owner explicitly acknowledges the exact settlement: "Recognized by conductor."
- Authorized consumer reports operation admission: "Action started."
- Correlated result with outcome evidence: "Completed."

Queue acceptance, socket `202`, unrelated transcript activity and generic final messages cannot advance these statuses. Missing evidence remains unknown.

## Crash and lifecycle responsibilities

There is no transaction spanning canonical filesystem records and Discord SQLite. Every boundary needs replay against the same occurrence and winning answer.

- **Presentation send uncertain.** Gateway owns durable intent and exact scoped publication reconciliation. A missing response does not justify blind resend. A failed message edit does not change the canonical answer.
- **Local selection intent, no known acceptance.** Gateway persists authenticated provenance, occurrence, selected key and request identity before invoking settlement. Replay uses that request. The canonical owner returns the winner or applies current validation. Local intent neither reserves a choice nor extends TTL.
- **Claim written, answer incomplete.** Canonical producer/settlement owner recovers claim, archive and answer materialization under its lock. It cannot choose a different answer because the original operation crashed.
- **Canonical answer saved, local receipt absent.** Canonical records retain a recoverable delivery obligation. The owner exposes it through bounded resumable enumeration. Gateway imports the canonical winner, even when its local selection lost a race.
- **Local receipt saved, wake not attempted.** Gateway commits the settlement reference and pending decision notification in one SQLite transaction. Restart resumes that notification.
- **Submission might have occurred.** Native delivery owner retains submitted/uncertain custody and reconciles native evidence. No blind execution retry.
- **Expiry, withdrawal, reused occurrence or stale control.** Owner validation refuses new acceptance. Historical answers remain intact. Expiry does not turn Research or silence into approval.
- **Handoff, account switch or concurrent start.** Account rotation leaves identity alone. Explicit handoff preserves applicability and unresolved-work guards. Use the existing singleton and ownership controls.
- **Gateway shutdown, listener stop or failed transport.** Preserve pending/uncertain records and release the resources owned by that process. Restart must not duplicate handlers, abandon accepted answers or create a replacement native session.

Bounded catch-up must enumerate existing canonical records, including incomplete advertisement work, without skipping unfinished records. Gateway advances a durable source checkpoint only in the transaction that commits the corresponding imports. Yield between pages and resume from durable progress. Startup/rearm catch-up alone is insufficient if a wake hint can be lost while processes remain alive.

### Silent notification loss: required amendment

Do not call the proposed seam gap-free until this mechanism is implemented and tested. The existing long-lived `phone-notify` outbox dispatcher is the proposed delivery owner only if its maintainer verifies that it can accept the responsibility. No reliable-watcher assumption and no second daemon.

Record the stable settlement/event identity and outstanding delivery obligation in the producer's locked claim/recovery sequence before publishing the completed answer. The running dispatcher must take ownership and arm an acknowledgment deadline before the initial push, without depending on a later filesystem event. Incomplete ownership transfer after a producer crash belongs to canonical recovery.

An outstanding-work deadline retries the same unacknowledged event. Bound batch size, concurrency and attempt duration using verified existing retry/backoff/escalation policy where applicable. These are retries of identified work, not periodic discovery scans. With no outstanding work, no retry timer remains. Exhaustion retains unresolved delivery and routes recovery to its owning agent through existing policy. Human-grade failures retain the phone path. Missing dispatcher or policy support is a pre-activation gap, not permission to invent a numerical default.

Gateway sends an import ACK only after one SQLite transaction persists the deduplicated canonical settlement reference, decision-notification intent and import receipt/contiguous checkpoint. Before ACK it also admits the committed intent to the existing notification worker. A scheduling failure cannot be acknowledged. A duplicate import must recheck notification ownership, not return success solely because a row exists. Lost ACK causes retransmission of the same event and reuse of the same notification identity. This ACK proves durable import, not native recognition or execution. No cross-store atomicity is claimed.

Exact falsification test: commit one answer, drop the initial push, suppress watcher callbacks, and keep both processes alive with no further questions, rearm or restart. Advance only the configured acknowledgment deadline. Require import of the same canonical winner and admission of its notification. Repeat while dropping the import ACK and require one import/notification identity despite retransmission. Deliberately disable deadline arming: the first test must fail. This amendment does not change the three-PR order.

## Implementation checklist

These are three proposed PR boundaries with owner responsibilities, not a claim that another maintainer has accepted an assignment. Existing authority covers ordinary reversible work. This documentation PR does not deploy the feature.

### PR A. Canonical facade and recoverable delivery obligation

Owner: canonical `phone-notify` producer/settlement maintainer. This prerequisite belongs in the owning skills repository, not a copied implementation here.

- [ ] Expose validated occurrence-scoped registration, settlement and readback using the existing lock and canonical records.
- [ ] Separate canonical registration from selected notification routes. Preserve existing Telegram behavior.
- [ ] Recover incomplete registration and claim/archive/answer work. Expose bounded durable progress for delivery, including interrupted advertisement.
- [ ] Establish the acknowledged delivery mechanism required by the final stress test before activating a new answer surface.
- [ ] Test real temporary owner records: different-answer race, Telegram/Discord race, reused `qid`, invalid key/authority, expiry and withdrawal. A duplicate observes the same winner. Discord-only registration creates no Telegram outbound entry.
- [ ] Interrupt each durable-write boundary and recover through actual owner code. A valid original claim must not become another choice.
- [ ] Negative controls: remove generation/menu validation or skip interrupted materialization. The relevant test must fail on canonical state or effects.

### PR B. Decision notification custody and consumer boundary

Owners: Discord native-transport maintainer and the existing conductor answer-consumer maintainer.

- [ ] Add the separate decision notification/custody path, sharing existing transport primitives and persistent native sessions.
- [ ] Add exact decision recognition and consumption identity without creating a competing action consumer.
- [ ] Include current-owner checks, applicable-head enforcement and handoff participation before any answer handler is enabled.
- [ ] Test real SQLite plus queue-command and Unix-socket fixtures for framing, custody, recovery and unchanged chat behavior. Fixtures do not prove a real native idle wake.
- [ ] Observe consumer admission and harmless fixture effects for replay, Research, account versus session change, head changes, handoff races, and restart before/after submission.
- [ ] Negative controls: remove consumption deduplication, execution-time applicability enforcement or exact-owner checks. Catch duplicate effects or stale admission.
- [ ] Kill the consumer after its effect but before outcome recording. Require existing action-specific idempotency or authoritative reconciliation before that action class qualifies for unattended recovery.

### PR C. Buttons, durable bridge and finite phone pilot

Owner: Discord Gateway maintainer, using PR A and PR B.

- [ ] Publish the canonical question with durable correlation and uncertain-send reconciliation. Add one `interactionCreate` handler to the existing Gateway, not per-message collectors.
- [ ] Validate operator, application-owned message, guild/channel, presentation reference, occurrence and key. Resolve authority from canonical data.
- [ ] Promptly defer as checking, persist intent, settle through PR A and import into PR B. Unknown settlement never displays as saved. Discord requires an initial response within three seconds and interaction tokens expire after 15 minutes. Keep durable status independent of that token. [Discord interaction specification](https://docs.discord.com/developers/interactions/receiving-and-responding).
- [ ] Exercise every crash boundary above and more than one catch-up page. Verify bounded reads, committed checkpoints, canonical winner, notification counts and actual fixture effects.
- [ ] Test foreign, stale, expired and withdrawn clicks, conflicting selections, callback failure, uncertain publication, failed edits and silent lost wake hints. Missing a UI deadline must not undo or repeat an accepted answer.
- [ ] Negative controls: advance checkpoint before import, omit notification intent, equate deferral with saved, or dispatch the losing answer. Tests must detect the wrong state or side effect.
- [ ] Run the phone-side evidence gate below before retiring any old route.

Buttons carry an opaque reference to durable presentation data, not embedded executable instructions. Use the installed dependency and platform components. Do not truncate a canonical choice menu to fit a row. [Discord component specification](https://docs.discord.com/developers/components/reference).

## Phone-side evidence gate

For each existing Codex and Claude conductor, record a normal choice and Research from the phone, including actual idle and busy delivery. Record a restart after acceptance but before notification and an explicit authority-preserving handoff. No new native session is part of the test.

- [ ] Phone notification visibly arrives with correct question, scope, recommendation and consequences. Server publication alone is insufficient.
- [ ] Callback timing satisfies Discord's documented deadline. Record click-to-save and save-to-recognition durations separately. Do not invent a latency percentile target from a handful of samples.
- [ ] Exactly one canonical winner is observed for the occurrence, with explicit correct-owner recognition and a verified permitted outcome. Research does not approve.
- [ ] Replay, restart and handoff show no lost answer, wrong-owner admission or duplicate action in the tested cases. Preserve exact question generation, settlement/message references, native identity, binding generation and outcome evidence in the proof record.
- [ ] Drop the wake hint without restarting either process or sending another question. Recovery must complete without operator intervention.
- [ ] Compare process count, bounded catch-up reads and memory observations against the existing Gateway baseline. No model invocation per click, second Gateway, new native executor or recurring full-history scanner.

Keep human-grade phone paging until notification, correlation and custody pass for that route. Any temporary dual presentation uses the same canonical occurrence and is limited to the named pilot. Retire old routes explicitly and individually, with restoration that cannot replay accepted decisions. Unrelated notification routes stay unchanged. Existing authority does not require another confirmation for routine reversible implementation steps.

## Remaining limit and falsifier

The hardest action failure is an effect committed just before the consumer crashes without recording its outcome. Unique answers and deduplicated delivery do not guarantee exactly-once effects. Kill at that boundary, then restart through the actual consumer. A second effect falsifies a no-duplicate-action claim. If the outcome cannot be determined, surface uncertainty and recover through the action's owner. Keep that action class off automatic recovery until its own idempotency or reconciliation is demonstrated. Do not create a generic executor to hide this gap.

Richer cards, model-written decisions, broad approval dashboards, additional answer interfaces and language migration are deferred. This roadmap establishes no measured productivity gain or production reliability result.

## Adversarial review record

Pro drafted the plan in the existing research conversation under `DISCORD-DECISION-ROADMAP-0906`. The parent checked local owner sources and applied five sequential lenses: user need, empirical proof, mechanism, resource cost and status accuracy. This was not five independent model reviews.

The same Pro conversation revised the plan under `DISCORD-DECISION-CHALLENGE-0906`, accepting six objections:

- C1: exported settlement is not a complete public validation boundary. Name canonical recovery ownership and separate route publication.
- C2: saving and waking cross stores. Name durable obligations, import transactions and replay responsibility without claiming distributed atomicity.
- C3: chat custody cannot represent a decision unchanged. Separate the envelope and correct fixture versus live-wake claims.
- C4: move minimum fencing before activation and revalidate at execution. Preserve accepted history when applicability changes.
- C5: reuse Research, TTL and conflict policy. Remove unnecessary re-ratification and competing interface prototypes.
- C6: reduce six slices to three implementation PRs and one finite provider-specific phone gate.

The second challenge, `DISCORD-DECISION-FINAL-STRESS-0906`, exposed silent notification loss while both processes remain alive. Pro withdrew its established gap-free claim and added the acknowledged-delivery amendment above. The parent also required duplicate imports to recheck worker ownership after failed scheduling. Existing dispatcher support remains unverified, so the documentation records a prerequisite and falsifier rather than a solved mechanism. The consumer-after-effect crash limitation remains.

Validation for this documentation PR: locally verify cited repository symbols and external-owner seams, check relative Markdown targets and whitespace, and confirm the diff contains only this roadmap and its README link. No runtime tests, live decision interactions, phone notification proof, or route cutover are claimed.
