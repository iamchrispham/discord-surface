# Direct conductor milestone posting

## Router plan

- Objective: let an existing conductor announce a milestone without an inbound message or sidecar inference.
- Domain or lane: explicit conductor outbound delivery.
- Scope: `post` and `claude-post`, existing binding lookup, receipt custody, shared Discord transport and splitting.
- Likely files: `src/conductor-post.js`, `src/cli.js`, `src/discord.js`, `src/state.js`, a focused companion test and README usage.
- Architectural pattern: Workflow Coordinator with Gateway reuse.
- Pattern rationale: the command resolves authority and claims delivery in the existing SQLite transaction boundary. The shared transport owns the HTTP request. The receipt journal owns durable outcomes. Automatic board coalescing does not own explicit milestones.
- Blast radius: both CLI aliases are gated by native ID, generation, configured guild and the active conductor binding. Every split part rechecks the same authority. Live intake and recovered history enter `SurfaceState.acceptDiscordMessage`, whose own-post predicate must exclude durable sent identities. Gateway auxiliary sends keep their public contract when transport is extracted. Native dispatch, native replies, Monitor listeners, sidecar selection and Telegram delivery remain deferred because this command neither invokes nor reconfigures them.
- Lifecycle matrix: before first send, stale generation, inactive/missing/ambiguous binding and invalid text are refused. Concurrent identical commands are serialized at the receipt claim. Sent parts survive process exit and are skipped on repeat. A crash, timeout or cancellation after claim leaves uncertain custody and prevents blind resend. Definite HTTP rejection permits a later explicit retry. Handoff between parts prevents new requests from the predecessor, while an already initiated request may settle only its original record. Normal completion closes SQLite and removes signal handlers. No persistent watcher, timer, session or service is introduced.
- Risks: an uncertain request must not be treated as failed, a second part must not cross handoff, and an explicit milestone must not be coalesced away by routine snapshots.
- Validation level: owning suite plus actual CLI/SQLite tests, simulated HTTP failures, independent diff review and one live milestone readback.
- Why this belongs here: it closes the missing outbound operation in the existing adapter without turning a milestone into fabricated inbound work.
- Expected output: a usable command and receipt with exact binding identity and returned Discord message IDs. Record source and installed versions separately.

## Operator acceptance

Unprompted conductor communications are landings, blockers and rulings the operator may want to override. Round detail stays in beacons and PR bodies. Human-grade events still page the phone. Spark/Luna are optional context interpreters, not dependencies of conductor announcements.

Telegram retirement is a separate staged task. This change sends no Telegram copy and disables no phone path.

## Command contract

Required options: `--native-id`, `--generation`, `--text-file`. `--state-dir` and `--db` preserve the existing CLI defaults and overrides. `claude-post` requires a Claude binding. Generic `post` works for the selected bound vendor. If a native session has multiple matching channels, require `--channel-id` rather than guessing. Use the existing `splitReply` function and native reply text limit.

The same invocation identifies the same milestone for retry. An explicit request ID may identify a distinct event with identical text. Reusing an explicit ID with different content must be rejected. Sending state without a confirmed result is uncertain, never an automatic retry license.

## Proof status

Implementation complete in isolated branch from main `0c6bbe5`. No sidecar tables or activation are included. Live delivery remains pending until the command receipt and Discord readback are recorded.


## Local validation and independent review

The final owning command explicitly ran `test/surface.test.js` and `test/direct-post.test.js`, serially on Node 22.23.2: 131 passed, 0 failed, 0 skipped, 9,613.307584 ms. The direct suite includes real executable invocations against fixture SQLite with bounded fake HTTP, and rejects any native child-process work. Network simulation is not live delivery proof.

Independent review of the isolated tracked and untracked diff found a trailing-newline split defect. Corrected by rebalancing a final blank suffix with a preceding visible character when the size limit permits exact preservation. Direct posting rejects remaining blank layouts before creating custody or sending anything. The two transport regressions and separate boundary/surrogate probes passed, and the reviewer closed the finding with no further concrete defect.

Three independent negative copies removed generation checks, durable deduplication, and conservative server-error classification. Each failed an actual network-call assertion, reporting two requests where one was required. Temporary copies were removed. The baseline source was not mutated.

A partial result reports its confirmed `messageIds` plus overall `status`, and the executable exits nonzero unless all parts are sent. Repeating an unchanged command is the explicit retry for definite unsent failures. Interrupted attempts remain in flight while their owner is live, or unknown after a dead owner is observed. No watchdog, periodic poll or automatic resend is introduced.

The request deadline starts immediately after initiating the HTTP operation. At expiry it aborts that operation and preserves uncertain receipt custody. Missing outcome data never means success or permission to send again. Binding changes stop new parts while allowing an already initiated response to settle only its original receipt.
