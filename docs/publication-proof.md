# Event-driven publication implementation

This change attaches deterministic source publication to the existing Gateway. It is source work, not installed or live Discord proof. Context interpretation and a bounded reference on human replies remain required before sidecar completion.

## Router plan

- Objective: publish scoped source changes without generating native inference turns.
- Domain or lane: Discord Gateway publication.
- Scope: publication custody, source observation, sending, and automatic-post exclusion.
- Likely files: `src/publication/store.js`, `src/publication/publisher.js`, `src/state.js`, `src/discord.js`, `src/cli.js`, `test/publication.test.js`.
- Architectural pattern: Gateway plus a publication workflow coordinator and its persistence owner.
- Pattern rationale: the Gateway already owns network requests, reconnect and shutdown. The existing snapshot reader owns source selection. Publication records belong in the existing SQLite database.
- Blast radius: `createSurfaceConsumer.handleMessage` and `intakeMessage` both enter `SurfaceState.acceptDiscordMessage`, which excludes durable publication identities before native acceptance. `recoverInbound` uses `intakeMessage`, covering backfill. Gateway startup attaches the publisher, reconnect schedules a fresh read, and shutdown stops it. `sendTransportReceipt` preserves its public interface and shares bounded auxiliary-message transport with publications. Native dispatch, reply custody and acknowledgments retain their existing contracts. CLI status exposes publication state counts and processed/successful timestamps without loading a second store.
- Lifecycle matrix: described below.
- Risks: duplicate sends after uncertain completion, stale source drafts, outdated binding generations, source-watch feedback, and silently treating unreadable data as current.
- Validation level: owning project suite, real file replacement and SQLite reopen, independent adversarial review, and behavior-removing negative controls.
- Why this belongs here: the same Gateway must own outbound Discord custody and exclusion from its inbound recovery path.
- Expected output: independently reviewed source and local behavioral proof. Live installation and both-provider acceptance are separate gates.

## Lifecycle and policy

| Event or state | Handling |
| --- | --- |
| First startup | One scoped source pass after Gateway recovery, using the fixed 500 ms burst window. A repeated start on a running Gateway does not attach another publisher. |
| Atomic registry replacement | Watch the parent directory. A burst does not reset its timer, so continuous file events cannot postpone processing indefinitely. |
| Publication database writes | Compare binding identities/readiness only. Unchanged bindings do not trigger Python source reads. |
| Routine cooldown | Preserve the newest processed snapshot separately from the successful-send timestamp. One one-shot timer flushes after the remaining 60 seconds. |
| Explicit failure before delivery | Preserve pending custody. Retry no earlier than 60 seconds after the failed attempt. On expiry, read the current source and replace superseded drafts before sending. No successful timestamp exists before an actual success. |
| Uncertain delivery or crash during send | Retain an unknown post and stop later sends for that owner. Never infer failure from a timeout or blindly resend after Discord nonce retention might have elapsed. A matching bot echo or recovered history event can establish its message ID. Unknown custody without that readback remains unresolved and visible in the ledger. |
| Source expiry | Schedule the source timestamp plus 30 minutes. Reread at expiry, publish the stale distinction under normal cadence, and preserve the original review timestamp. |
| Unreadable source after a previous observation | Replace the old pending content with a source-unavailable publication. No old draft is flushed as current. A subsequent source event or startup retries the bounded source read. |
| Missing or wrong-owner initial record | Do not manufacture a board for an unrecorded owner. If a previously recorded source loses its context, publish the missing-field state. |
| Disconnect or recovery | Retain drafts and reject sends while Gateway readiness is false. Recovery schedules another scoped read. |
| Binding handoff or unbind | Compare channel, guild, vendor, native session, conductor, repository and generation before accepting a draft and before sending. Old records remain historical custody and cannot authorize the successor's publication. |
| Shutdown or failed request cancellation | Close file watchers, clear burst and expiry/cooldown timers, abort reads and sends, and await their bounded completion. An operation that might have written remains unknown. |
| Terminal navigation, native session account switch | These do not own the Gateway resource. Account changes alone do not replace the native binding. |

The retry timer starts after an explicitly rejected or unsent request. Its guarded data remains in the publication ledger after failure. Missing successful timestamps mean no previous success, not a zero-time success. Unknown requests do not acquire a retry timer. Model output does not participate in this implementation yet.

Publication schema is an additive namespace in the existing state database, recorded as `publication-schema=1`. Once recorded, missing publication tables fail opening rather than being silently recreated and losing the deduplication record. Historical post identities are retained. No retention cleanup is introduced in this change.

## Proof boundary

The companion suite uses actual SQLite files, actual parent-directory file notifications, actual bounded Python snapshot reads, and Gateway transport with a fake Discord HTTP response. It does not contact Discord or start a native provider. Negative controls remove source events, automatic-post exclusion and correct successful-cursor handling separately. Those controls must fail behavioral assertions, not imports or fixture setup.

Still required: richer contextual interpretation with prospective semantic evidence, bounded human reply references, installed-version verification, real Discord readbacks and absence of native inference across observed live automatic updates. `/cs` continues through its shared renderer and is not implemented by this publisher.

## Independent review disposition and final local evidence

Independent review found no remaining scoped blocker after the corrections below. The final owning run explicitly included `test/surface.test.js`, `test/liaison-process.test.js`, `test/context-interpretation.test.js` and `test/publication.test.js`: 149 passed, 0 failed, 0 skipped, 15,689.807709 ms. Network responses remain simulated. This is not installation or live Discord proof.

- Publication is explicitly selected through `publication enable|disable` for the current channel/native/generation. Selection lives in the existing config store and is scoped to operator, guild, vendor, conductor and repository. A successor for the same role retains selection. A changed operator or guild does not inherit it. Enumeration, stage, claim and pre-network checks honor selection. The accepted cost is requiring one explicit enable per selected role, avoiding unrequested automatic publication in other bindings. A selected successor failing to retain the policy reopens this choice.
- Disabling prevents future requests. A request already initiated may still finish. Its actual response settles only the historical owner whose request began, never the successor's successful cursor. Handoff remains available. Unknown historical custody remains visible in status after rebind.
- A watcher error closes that subscription and rearms it with bounded one-shot backoff. Source reads resume once the subscription is established. Failure does not start periodic source polling. Shutdown clears rearm timers and closes subscriptions. Empty or unavailable sources keep their existing missing/unavailable meaning, and pending delivery custody remains in SQLite throughout.
- Versioned table validation checks the stored DDL, including nullability, primary keys, unique identities and finite-state constraints. Missing constraints fail opening. This schema has not been installed in production.
- Human messages cannot be mistaken for automatic publications merely by sharing a nonce. Known Discord publication message IDs still exclude replay when the bot flag is absent.
- The real bounded Python reader was blocked on a FIFO and cancelled during shutdown. It settled before its existing three-second deadline. An arbitrary injected promise that ignores the reader contract does not justify adding another shutdown timer.
- A Gateway transport test held an actual fake HTTP response across rebind. It proved request initiation occurred before handoff and only the old owner's success cursor advanced afterward. No post-handoff request was initiated.

Direct conductor milestone publication and Telegram retirement are recorded separately in the roadmap. The separate post and claude-post commands provide explicit milestones through the same receipt journal. Automatic publication selection does not gate those commands.

## Combined milestone integration check

The sidecar branch now carries the reviewed PR 3 splitter correction and direct-post preflight. A trailing file newline cannot become a blank outbound part. A whitespace layout that cannot produce valid Discord parts is rejected before creating custody or starting a request. The text file remains owned by its caller. No retry timer or background resource starts on this guard.

The combined owning run explicitly included `test/surface.test.js`, `test/liaison-process.test.js`, `test/context-interpretation.test.js`, `test/publication.test.js` and `test/direct-post.test.js`: 163 passed, 0 failed, 0 skipped, 16,344.92425 ms. Three direct-post negative controls removed generation enforcement, uncertain-send preservation and confirmed-send deduplication separately. Each failed on two actual fixture network requests where one was expected. These are local simulated-network checks, not installed sidecar proof.

## Echo settlement wakeup correction

Independent combined review reproduced a newer pending snapshot remaining silent after a bot echo resolved an older uncertain send. The database watcher intentionally observes binding changes only, so custody settlement had no wakeup path. PublicationStore now emits a local event after echo settlement, and the publisher schedules its existing drain. Ordinary successful HTTP sends do not emit this event. The existing burst and cadence bounds remain in force.

Lifecycle: the Gateway-owned publisher attaches one settlement listener and removes it on stop before aborting work. The event adds no new timer or retry policy. No pending snapshot means the scheduled read produces no extra message. A concurrent drain retains its existing dirty flag. A binding change still fences staging and sending. Delivery confirmation sets the successful timestamp, so the normal cooldown starts at settlement. If the source is absent or unavailable, its current missing/unavailable rules apply. SQLite retains the queued and historical data after any stop or refusal. The regression uses actual file replacement, SQLite, the ordinary consumer echo path, no manual drain after settlement, and checks both cooldown and listener removal. Removing the settlement event must fail on the missing second send.

Final combined run after the echo correction: the same five explicitly registered files passed 164 tests, 0 failures, 0 skips, 16,518.954167 ms. Independent re-review closed the finding. Its restored-defect control timed out awaiting the second publication. These results supersede the pre-correction combined count above.
