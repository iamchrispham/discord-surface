# Spark sidecar roadmap

Runtime constraint: [runtime research and finite Rust-first checklist](runtime-language-research.md). This adds a measured migration trial, not completed implementation or permission to replace the live service. Existing sidecar acceptance remains open.

Status: final stress test reconciled. Implementation in progress. Goal active in Codex task `01a0701c-5714-7671-a455-db7d67f9fa78`.

## Outcome

Provide useful automatic progress and owed-item context in the existing conductor channels without invoking `/cs`, creating a conductor inference turn for each update, or feeding routine summaries back into the conductor. Keep Spark and Luna as sidecars. Preserve all existing native sessions and the conductor's conversation, decisions and execution authority.

Replace repetitive routine receipt text with distinct signals for durable save and actual native acknowledgment. Completion of this goal means the accepted behavior is implemented, locally validated, installed and exercised through the existing two-provider pilot. A roadmap, passing fixture or generated preview alone is not completion.

Basis: [research and operator refinements](spark-sidecar-research.md), [verbatim independent opinions](spark-sidecar-pro-verbatim.md). Local source starts at clean `main` `0c6bbe54a77a34c5d59d4994a364a57d0a74d106`. The implementation worktree was created from that verified local trunk before a remote existed. The operator subsequently authorized the private repository https://github.com/iamchrispham/discord-surface. Main preserves that transport base, and sidecar work is published through a draft PR.

## Invariants

- I1 Every incoming human message still reaches its bound conductor through the existing transport. Sidecar processing never gates routing, acknowledgment, reply, custody, permissions or execution.
- I2 Routine snapshots, Spark output and Luna checks run outside the persistent conductor session. No per-digest review request, hidden summary reinjection, substitute executor or copied-session execution.
- I3 Reuse `/cs` underlying sources and existing progress calculations. Preserve repository, vendor, conductor, native UUID and generation. Preserve whether an item is owed by the operator or owed to the operator. Do not create or clear obligations through model output.
- I4 Recorded intent, rationale and next steps stay attributed to their source. Unknown, stale or missing evidence remains visible. A source reference existing does not prove its semantic interpretation.
- I5 A model can propose meaning or a bounded warning. It cannot declare task success, close an owed item, select an account, invent acceptance, or decide that a required update can be suppressed.
- I6 A saved reaction reflects committed intake. An agent acknowledgment reflects a real message-specific action from the current native owner. Queue success, endpoint 202, generic activity and a turn boundary are not recognition. Neither signal means completion.
- I7 A failed sidecar, slow model or failed reaction does not undo saved input or delay native work. Existing required notifications retain their path.
- I8 Subscription authentication only. No account changes, API fallback, paid-credit/overage work or new model provider. Compare Luna low and medium as alternatives, not an assumed performance hierarchy.

## S0 Scope, stress test and source ownership

- [x] S0.1 Re-read the accepted research, current adapter head, `/cs` source contract and the active goal. Registry query found no current `discord-surface` lane owner beyond this task's historical worktrees.
- [x] S0.2 Run the five-lens internal roadmap review and one independent Pro pass in the existing research conversation. Reconcile factual disagreements against actual source. Revise this roadmap before implementation.
- [x] S0.3 Create one fresh `cpham/` worktree and a single-writer implementation plan. Enumerate all consumers and lifecycle exits for the actual chosen files. Do not edit installed `main` or other agents' skill files in place.

## Final stress-test ruling

Pro returned READY TO BUILD with five contract corrections. Exact response: [final review](spark-sidecar-roadmap-pro-verbatim.md). Accepted: durable publication identity and exclusion through reload/backfill, field-level producer contracts, real normal-processing acknowledgment, bounded coalescing/restart/failure behavior, and conditional model activation. No new design panel or approval step. Local source review confirms each gap. The implementation worktree is `work/spark-sidecar-build`, branch `cpham/spark-sidecar`, based on 0c6bbe5. The first slice is quiet acknowledgments with its enumerated router plan in `work/spark-sidecar-roadmap/ack-router-plan.md`.

## Source-contract consultation

TM confirmed no deterministic current owed field existed. The corrected proposal is `_conductors[canonical conductorId]` inside the existing `pr-lanes.json`, with repository, vendor, nativeId, generation, updated, owed_by_operator, owed_to_operator, intent and next. A singular global `_conductor` would collide across owners. Missing fields mean not recorded; empty arrays mean explicit none. The source is stale after 30 minutes. Only a real conductor review refreshes the context timestamp, never an unrelated PR push. The adapter remains read-only.

Local inspection corrected two supplied assumptions: `lane-progress.py` does not yet skip underscore dictionaries, and `round-close.sh` writes head/trigger/round/optional phase but not next/state_note/updated. TM acknowledged adoption and installed the scoped record plus shared reader compatibility. A read-only adapter check at 5a8b644 accepted the live exact-owner/generation record, retained both empty owed lists as explicit none, and correctly marked its 11:35pm Pacific review timestamp stale when checked at 12:10am. Wrong-generation metadata was rejected. Board helper checks distinguished missing, empty and stale values and rejected another vendor/native ID. The adapter selected four matching lanes in that observation, not an asserted full fleet census. Source adoption proof: [receipt](spark-sidecar-source-adoption-proof.json). Future producer behavior and automatic publication remain unproven. The snapshot is still a preview.

## S1 Artifact snapshot and event source

- [ ] S1.1 Build a bounded, reusable snapshot from the selected conductor's existing `/cs` records: scoped beacon/queue, matching lane records, existing progress ladder, owed items, and already-written relevant context. Resolve sources by repository/vendor authority and exact binding. Record file/source references, observation time and source freshness. Missing fields do not become invented facts. Map each required field to its actual producer, path, event, revision and source timestamp. Distinguish empty, missing, stale and explicit clearance. An omitted record does not prove completion. Historical log entries do not override a current explicit field. An unavailable owed-item source leaves the full contextual outcome incomplete.
- [ ] S1.2 Reuse an existing pure source loader or renderer where it fits. The current Discord board reads `pr-lanes.json` and the shared progress ladder, but also accepts conductor-written `--fleet`/`--owed` prose and fetches titles. Do not merely invoke it and claim a complete independent `/cs` clone. Move only a genuinely shared data boundary if required, with its owner coordinated.
- [ ] S1.3 React to changes in declared local sources or existing result events without polling full native sessions. Coalesce events and retain the latest eligible snapshot. Native turn completion is an opportunity to inspect a change, not an instruction to post. Watch known directories where atomic file replacement requires it.
- [ ] S1.4 Render useful deterministic updates independently of a model: meaningful changes, current owed items, recorded next step and uncertainty. Publish only under the selected conductor's standing policy. Proposed reviewed default: a fixed 500 ms burst window (continuous events cannot postpone it) and at most one routine publication per conductor per 60 seconds, measured from the last successful publication. Retain the newest eligible snapshot during cooldown and schedule only a one-shot flush. With no prior publication, publish after coalescing. Existing mandatory alerts and message acknowledgments bypass this routine-update cadence. Accepted cost: up to one minute of routine-update delay. Reopen if updates are stale/excessive or required notifications are delayed. Revalidate timer ownership during implementation.
- [ ] S1.5 Keep publication in the existing Gateway ownership boundary. Save enough state to avoid duplicate routine posts on restart, distinguish last processed from last successfully published, and reject a stale binding generation before sending. A failed send does not silently advance the delivered-update cursor. Restore pending content and remaining cooldown on reload, distinguish retry timing from successful-send timing, and use one scoped startup/rearm read. Source expiry is a one-shot event so unchanged stale sources cannot appear fresh indefinitely.

Evidence: source-level negative controls for wrong repository/vendor, swapped owed-item direction, missing/stale data, no-change events, concurrent updates and stale-generation publication. Exercise real watched-file changes and ordinary restart behavior. Do not use label-only tests as proof.

## S2 Quiet saved and native-agent acknowledgments

- [ ] S2.1 Replace the routine saved-text reply with a durable-save reaction on the original Discord message, preserving actual send outcome and existing intake semantics. Provide one short legend in the operator guide. Keep paused/unavailable conditions distinguishable without inventing agent activity.
- [ ] S2.2 Add a narrow current-owner acknowledgment path for both Codex and Claude. The native owner emits an exact message-ID/generation acknowledgment during its normal handling of that input. Reuse the existing authenticated/local reply-custody boundary where appropriate. No separate acknowledgment-only conductor turn and no acknowledgment from Spark or Luna.
- [ ] S2.3 Display the agent acknowledgment only after verifying that event. Provisional symbols: inbox for saved and eyes for native acknowledgment. Document that missing eyes means recognition unverified. A later substantive response remains the conductor's reply.
- [ ] S2.4 Prove the signals independently: saved while the native owner has not acknowledged, then acknowledged by the original owner, then ordinary reply. Duplicate/stale/foreign acknowledgments must not create a false eyes signal. Failed reaction delivery must not alter execution state.

Evidence: targeted real-consumer tests plus one live message for each existing provider. Record exact message IDs, native IDs, generations, the native owner’s actual acknowledgment action and reaction readbacks. Submission receipts alone cannot close S2.

## S3 Spark meaning and Luna warning tier

- [ ] S3.1 Freeze a small set of real historical activity windows using only information present at each cutoff. Include useful, partial, irrelevant and conflicting evidence, plus ordinary low-information windows. Source judgments precede model output. Familiar synthetic failures remain separate regression cases.
- [ ] S3.2 Reuse the bounded subscription-authenticated Spark runner with tools disabled. Feed the snapshot and exact relevant source excerpts, not private reasoning or a whole session dump. Request optional source-linked associations between new evidence and an existing goal, question, decision or owed item. Permit no addition and preserve raw evidence.
- [ ] S3.3 Compare an artifact-only preview against the same snapshot with Spark interpretation. Preserve owner, scope, timing, policy-versus-event and uncertainty. Add source-supported explanatory language only to the extent verified by this experiment. Do not replace useful interpretation with mandatory facts and call the richer feature complete.
- [x] S3.4 On a predefined subset of harder scope distinctions or competing claims, compare one `gpt-5.6-luna` low check with one medium check. Both receive the original evidence, not merely Spark's paraphrase. Include unflagged controls. Record actual latency, input usage, quality and correction cost without API-dollar assumptions. Completed with the six-window diagnostic comparison and explicit limitations in the context-trial assessment.
- [ ] S3.5 Choose a bounded escalation policy from that evidence. Activation may select artifact-only, Spark alone, Luna alone, or Spark with one Luna setting. A rejected role must be reported as rejected, never claimed as delivered value. All requested model experiments remain required. Bound packet size, concurrency and deadline before activation. No self-confidence gate, serial low/medium/high retry ladder, mandatory conductor review, or new obligation generated merely by uncertainty. Model warnings remain advisory and grounded in existing `/cs` owed items or explicit conductor context. Important deterministic facts never depend on model agreement.

Evidence: actual model runs, structural rejection plus semantic source review, fair no-model baseline, independently checked known semantic failure controls, process exit/timeout proof using the existing runner. Report sample sizes and limits. Fix or narrow unsafe generated wording before live publication, while retaining the intended contextual value.

September 6 role ruling, accepted by the operator: direct Luna low is the initial contextual sidecar candidate. Spark remains on lower-consequence receipt conversion, labels and short explicit-fact summaries. Spark's six-window batch was faster but reassigned native recovery to the human. Luna medium produced extra noise on the quiet control. A mandatory Spark-to-Luna check added time without beating direct Luna low. Luna low retained the required distinctions in a fresh three-case holdout. These small retrospective trials do not establish broad accuracy or live publication. See the local `outputs/spark-context-trial/assessment.md` and the repository copy `docs/spark-context-trial-assessment.md`. Source-to-preview integration, inference bounds and automatic activation remain open. The experiment also found ignored or incomplete skill isolation; name-based selectors reduced input in a repeat, but the production runner is not yet corrected.

## S4 Integrated publication outside conductor context

September 6 implementation progress: `snapshot --interpret` now calls the reusable bounded Luna-low interpreter, retaining deterministic output and refreshing it even after model failure. The packet preserves exact snapshot identity, source references, owed-item direction and omitted-lane count. Only one interpretation runs per process. The output remains local and advisory. Six companion checks include the actual CLI and child processes; the owning suite includes 130 tests. The first real integrated trial invented event ordering despite valid source IDs. A corrected prompt and repeat on that frozen input removed that overclaim; this is a corrective diagnostic, not independent generalization evidence. See `docs/context-interpretation-proof.md`. Automatic publishing and fresh prospective semantic checks remain required.

Operator added Spark emoji selection as a possible small job. It may select presentation for an already recognized message. It must not infer durable save or native recognition, and the fixed saved/recognized pair does not require another model call.

- [ ] S4.1 Attach the sidecar to the existing selected conductor channels and source events. Automatic updates are visibly labeled and use the conductor-owned publication policy. Spark has no separate channel/session binding or authority to answer incoming messages.
- [ ] S4.2 Routine snapshots and interpretation produce no native `codex queue`, Claude Monitor input, conductor `/cs` invocation or review request. Verify normal input, replay and backfill paths all exclude automatic sidecar posts.
- [ ] S4.3 Continue deterministic publication if the optional model is slow, unavailable or returns unusable output. Model completion cannot revive a superseded snapshot. Dedupe the same warning across unchanged evidence without suppressing required status or alerts.
- [ ] S4.4 A real operator follow-up still reaches the conductor. A reply to a particular automatic post carries only a bounded reference to that requested artifact, preserving original human text without importing neighboring automatic history. If a meaningful warning requires native action under existing policy, send only the focused evidence needed. Routine caveats stay on the external status surface.
- [ ] S4.5 Verify binding handoff behavior: discard old-generation drafts, retain existing authority/custody rules, and resolve the successor's sources from its actual binding. Account changes alone do not change conductor identity. Preserve native sessions during installation.

Evidence: fake-provider negative controls plus live sidecar publications through each selected vendor channel. Match dispatched native work and source events to demonstrate zero routine sidecar-induced conductor turns in that observed window. Current bot-source rejection is supporting evidence, not complete replay proof.

## S5 Installation, operating proof and closeout

- [ ] S5.1 Independent adversarial review of the final feature diff. Resolve real findings without creating another review loop. Run the owning suite at the actual installation head and the meaningful negative controls for changed behavior.
- [ ] S5.2 Install locally and perform any required coordinated Gateway/Monitor code reload through the existing owners. Retain native conductor UUIDs, bindings, child lanes, account selection and accepted work. Record installed and actually loaded heads separately.
- [ ] S5.3 Exercise the full pilot: a real source change produces a useful automatic update, an unchanged event produces no redundant message, an owed-item/evidence association retains its meaning, any activated Luna tier handles a bounded discrepancy (a rejected tier retains experiment evidence and an explicit disposition), native recognition is visible, and a user follow-up reaches the original conductor normally. Source and fixture tests cannot substitute for this live chain.
- [ ] S5.4 Report observed conductor turns/context growth, model overhead, corrections and warnings. Offline answerability or estimated avoided turns are not causal proof that the operator would otherwise have invoked `/cs`. Label the observation window and remaining limitations rather than requiring an invented savings percentage.
- [ ] S5.5 Update the local operator guide, source references and this checklist. Clean test processes/fixtures. Keep intended production services running. Complete the goal only after the requirement-by-requirement audit has evidence for every active item.

## S6 Shared agent channel, after Spark

Operator requested September 6, 2026. Deferred until the Spark sidecar is delivered. This milestone does not expand the current Spark completion gate.

- [ ] S6.1 Provide a shared Discord channel for collaboration across vendors and operating systems, while retaining dedicated conductor channels and persistent native identities.
- [ ] S6.2 Reuse existing binding and delivery ownership. Identify the participating conductor, vendor and host explicitly. A shared channel must not create replacement sessions or dispatch every message to every agent.
- [ ] S6.3 Support directed requests, replies and handoffs in the shared conversation with durable recipient and correlation records. Distinguish a saved message from actual agent recognition. Keep collaborative messages distinct from execution authority.
- [ ] S6.4 Prove a real cross-vendor exchange on two operating systems, followed by delivery across a conductor's binding change. Verify the intended recipient receives the message once, replies reach the shared channel, and native session history remains intact. A same-machine fixture does not close cross-OS proof.

Routing syntax and host transport remain design work for this milestone. Start from existing coordination facilities, then implement the smallest missing boundary.

## Explicit exclusions

No new coordination framework, second obligation store, full-session polling, general code investigation/fixing, terminal `/rc` control, autonomous model authority, per-message approval loop, billing/API/overage expansion or broad failure campaign. Decision breadcrumbs, steering-message interpretation and polished decision briefs remain possible later extensions, not extra active lanes.

## Lifecycle checks owed by the implementation plan

Account for no source yet, source removed or atomically replaced, native owner busy/idle, duplicate/concurrent source events, Gateway start/stop/restart, model completion after newer evidence, model failure/timeout/cancellation, ordinary send failure, stale generation/successor pickup and listener stop failure. Reuse existing guarantees. Add only the focused checks needed by changed resources, with explicit deferred cases where a broader campaign is outside this goal.

## Completion evidence index

S2 implementation candidate: `d5d75f3`, [local acknowledgment proof](spark-sidecar-ack-proof.json). 121 owning tests passed, independent review clear after the shutdown fix, restored-defect negative control failed as intended. Not installed and no live recognition claim. S2 checklist stays open until live evidence.

S1 read-only snapshot prototype: [local proof](spark-sidecar-snapshot-proof.json). 123 owning tests passed after the repositoryless-lane exclusion fix, independent review clear, negative control failed as intended. Automatic publishing and actual producer adoption remain pending.

Each checked implementation item must link to exact source/test/live evidence and its head. Keep failed trials and corrections visible. Do not mark a proposed mechanism as deployed.
