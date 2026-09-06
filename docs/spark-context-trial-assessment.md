# Context sidecar experiment

Initial choice: Luna low for source-grounded contextual interpretation. Operator accepted this direction after the first comparison. Spark remains limited to lower-consequence receipt conversion, labels and short summaries of explicit facts. Neither model owns routing, custody, execution or new operator obligations. This trial does not install automatic publication.

## Method

Six retrospective windows were reconstructed from archived task artifacts. Fields and receipt timestamps were selected by each cutoff. Expected judgments were saved before inference and withheld from every model. The expected-file SHA-256 is `69c2181e0328c376f251fb7f78cac800160359e8d52f29a4a3a3cc5908c712b8`.

The same evidence packet went to Spark low, Luna low and Luna medium through the existing bounded subscription runner. A fourth run gave Luna low the original evidence plus Spark's proposals to test correction. All runs were sequential and ephemeral. No conductor queue, Discord post or production state change occurred. Recorded child PIDs were absent after completion. Event logs contain no tool execution items.

This is a small diagnostic corpus, not a prospective or blinded quality benchmark. Several source artifacts already contain human interpretation. The results establish concrete failures and a provisional role choice, not a general model ranking or a reliability percentage.

## Measured batches

Each elapsed time covers one batch of six windows, including local process startup. It is not per-message latency. Model names and efforts are requested settings, not independently server-attested identities. Token counts below are the emitted `turn.completed.usage` fields. No API price or quota-saving estimate is inferred.

- Spark low: 5.763 seconds, 21,900 input tokens, 2,524 output tokens, including 1,608 reported reasoning output tokens.
- Luna low: 15.439 seconds, 25,565 input tokens, 690 output tokens, including 224 reported reasoning output tokens.
- Luna medium: 19.773 seconds, 25,565 input tokens, 894 output tokens, including 365 reported reasoning output tokens.
- Luna low checking Spark: an additional 20.549 seconds, 26,538 input tokens, 875 output tokens, including 285 reported reasoning output tokens. This follows the Spark call, so it is not a faster substitute for direct Luna low.

All four batches completed, parsed, returned the six requested window IDs in order and cited only IDs present in their respective windows. Reference validity was a structural check, not semantic proof.

## Source-grounded assessment

W1, missing response custody: Spark incorrectly told the operator to reconcile a response that belonged to the native conductor. It also called the later modal request a newer `/cs` request. Luna medium likewise assigned reconciliation to the operator. Direct Luna low correctly connected missing response custody to the held request without reallocating that work to the human. The checker removed Spark's explicit human assignment but described the known ordering as a conflict and blurred a sent receipt with request delivery.

W2, recovery: all variants distinguished the completed reply flow from the modal audit announced in the reply. Direct Luna low most clearly connected the two recovered messages to the remaining business-work evidence gap. Its phrase “not complete” should be rendered as “completion not evidenced at this cutoff” when absence is the only evidence. A reply announcing work does not prove that work finished.

W3, stale empty obligations: the models preserved the stale-source and automatic-publication limits, but direct Luna low and medium classified this known limitation as requiring review. That is an unnecessary escalation in this corpus. Spark and the checker also associated the conductor's owed fields too closely with the four selected lane records. The owed record is scoped to the conductor, not an asserted four-lane obligation census. Staleness must remain visible without inventing a human task.

W4, idle wake: all variants retained the key connection: an existing Claude session woke without restart, while integrated Discord and reply custody were not proved by that probe. Spark unnecessarily classified this explicit proof boundary as requiring review.

W5, fixture outage: all variants correctly avoided a production restart from an isolated stopped-state fixture. Both direct Luna variants and the checker retained the production connection's `unverified-live` limit. Spark omitted that limit.

W6, completed arithmetic control: Spark, direct Luna low and the checker stayed quiet. Luna medium manufactured an additional transport-status update despite the explicit absence of a new question or obligation.

## Ruling and remaining work

Use direct Luna low as the initial contextual sidecar candidate. Do not build a mandatory Spark-to-Luna chain or a low-to-medium retry ladder. Keep deterministic source facts and ordinary publication available independently of model completion. Spark's prior receipt-selection role remains narrower and does not establish that its free prose is safe to publish.

Before automatic activation, the implementation still needs bounded source packets, publication deduplication, stale-generation rejection, model deadline and cancellation ownership, exclusion of automatic posts from native intake, and live two-provider proof. Treat missing/stale evidence as uncertainty, not an automatic review request. Validate the selected behavior on a fresh observation window during live acceptance, since this corpus has already informed the choice.

The CLI emitted two nonfatal warnings in every run: `Under-development features enabled: skip_host_skill_discovery` and `Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill`. The runner requested disabled skill discovery, but the latter warning contradicts a claim of full skill-context isolation. Input counts include substantial harness overhead. Inspect this before enabling routine calls rather than claiming these runs were minimal-context inference. Tool execution remained absent in the captured event stream.

Raw packet, frozen judgments, answers, process receipts and bounded event logs remain beside this report. They are local evidence, not repository test fixtures or live status.

## Follow-up probes

Changing the experiment's disabled-skill selectors from paths to names, and including symlinked skills, removed the skill-budget warning on a repeat of the same six-window packet. Luna low reported 19,621 input tokens instead of 25,565, a reduction of 5,944. Elapsed time was 16.472 seconds, so this does not establish a speed improvement. The unstable-feature warning remained. These two configuration changes were tested together, so this probe does not isolate which one caused the reduction or establish that all skill context disappeared. The installed runner remains unchanged and needs the narrower correction before routine inference.

A fresh three-case holdout then tested actual image delivery versus byte fidelity, channel movement versus native-session replacement, and Node I/O improvement versus memory/language claims. Frozen expectations preceded inference. Luna low retained each required distinction and no prohibited claim appeared in manual source review. It completed the three-case batch in 12.287 seconds with 17,434 input tokens and 450 output tokens, including 142 reported reasoning output tokens. This supports the provisional selection. Three easy retrospective cases are not a general accuracy guarantee.

The holdout remains at `outputs/spark-context-holdout` locally. Its H3 cutoff is a report label, not an independently captured telemetry time; that case tests interpretation of the saved report, not event-order reconstruction. No inference from that timestamp is included in the assessment. All experiment children exited and both experiment parent commands completed.
