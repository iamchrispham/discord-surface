# Context interpretation integration

Scope: source-to-interpreter integration in the sidecar branch. Not installed and not an automatic Discord publisher.

`snapshot --interpret` feeds the existing selected-conductor snapshot into the subscription-authenticated Luna-low runner. The ordinary Spark receipt command retains its model and behavior. The deterministic snapshot remains separate from optional advisory prose. Packet data is bounded at 32 KiB, answer reads at 8 KiB and execution at 60 seconds. The fixed prompt adds a small constant overhead beyond packet bytes. Concurrency is one interpretation per process, not a machine-wide semaphore. Successful and failed inference both refresh source data. Superseded interpretations and changed bindings are discarded.

The process deadline begins when the child runner starts. At expiry or cancellation the runner terminates its child group, then removes its temporary directory. The producer still owns registry fields. Inference never advances transport custody or publishes a message. Missing/wrong-owner source data returns unavailable before spawning. A missing source after inference replaces the preview with unavailable rather than retaining a fresh-looking old record. Abrupt process kill is outside the graceful cleanup claim.

## Executed local checks

The registered companion uses the actual snapshot reader, public CLI and real child processes with a substituted model command. It checks model routing, direction preservation, input/output bounds, source references, process-local concurrency, child termination, cleanup, valid quiet output, superseded drafts and fresh deterministic fallback after provider failure.

Owning command: `node --test --test-concurrency=1 test/surface.test.js test/liaison-process.test.js test/context-interpretation.test.js` using Node 22.23.2 on macOS. The final completed run reported 130 tests, 130 pass, zero failures or skips in 17.340 seconds. All three named test files were registered and executed.

Independent review found one defect: provider failure retained the pre-inference snapshot. Its actual-CLI reproduction changed intent during a failing child and received the old intent. Fixed by refreshing after every attempted interpretation, retaining the provider failure reason. The reviewer independently reran that scenario and the focused suite, finding no remaining mechanism blockers.

Two isolated negative controls preserved imports and disabled only the behavior under test. Removing known-source validation failed the foreign-evidence assertion. Restoring success-only refresh failed the public CLI assertion for intent recorded during provider failure. Temporary copies were removed.

## Real model diagnostic

Read the TM binding through a read-only SQLite connection and captured the selected source once. Saved the deterministic baseline, source packet and judgment criteria before inference. No native session transcript, queue, Monitor input, Discord send or shared-source write was used.

The first actual Luna-low run took 10.920 seconds. Structural validation passed, but the summary said one round was dispatched after its preceding gate, although the source only recorded a dispatched round and a running gate. It also summarized more lanes than its references supported and treated planned re-verification as queued work. This failed semantic review and was not published.

The prompt was corrected to select one useful association, support every claim with references and avoid inventing temporal or causal order. A corrective repeat on the same frozen input took 9.065 seconds. It connected the recorded release blocker to its listed round/gate steps and explicitly withheld completion. This is a diagnostic correction, not an independent holdout or general accuracy result. Its usefulness is modest: a concise connection among existing fields, not newly discovered evidence. The actual model identity is requested, not server-attested. Both child processes exited.

Raw artifacts remain local in `outputs/context-integration-trial/`. Provider usage was not captured in this integration run. Earlier comparative trial usage remains separate. No quota savings, live delivery, absent conductor turns, or general semantic safety is proved here. Automatic publication, fresh prospective checks and both-provider live acceptance remain open.
