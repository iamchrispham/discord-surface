# Runtime direction after adversarial research

Decision: use Rust as the provisional compiled target and test one bounded vertical slice against an improved Node implementation. Do not require a Go port first. No migration, resource savings, or production readiness has been demonstrated.

The operator prioritizes continuous memory and CPU cost while many native conductors run, and reliable operation away from the computer through Discord. Source remains small enough to consider changing foundations: 5,683 physical production lines and 3,872 test lines at 68f7fae60b246058224b9f11f7b417b8f515d447. Counts include comments and blanks.

## Evidence and disagreements

The [test measurement](discord-test-memory.json) observed 352.0 MiB sampled aggregate process-tree RSS with five Node processes at the peak sample. All 123 owning tests passed. This is neither a daemon footprint nor a V8-only measurement. The separate production Gateway observation was 146.4M physical footprint and a 1.1G lifetime peak. Their measurement windows and metrics differ. The peak's cause remains unknown.

The [controlled observer probe](transcript-allocation-probe.json) invoked the actual observer against an unchanged 32 MiB transcript with its cursor at EOF. Three accelerated observations reread 96 MiB. Sampled process RSS reached 148,389,888 bytes, heapUsed 5,104,584 bytes and external memory 70,093,417 bytes. This proves avoidable historical reads and allocation in that path. It does not explain the production peak or select a language.

Five internal lenses considered mechanism, counterarguments, evidence, economics and measurement limits. Three completed external Pro rounds are retained: [first answer](runtime-pro-first-verbatim.md), [unattended-service reframe](runtime-pro-reframe-verbatim.md), and [Rust challenge](runtime-pro-rust-challenge-verbatim.md). Pro first favored optimized Node with Go as challenger, then Go as the intended foundation. Its final answer withdrew Go-first because simpler maintenance and iteration were unmeasured expectations for this repository. Model agreement is not performance evidence.

Locally rechecked findings: whole-file header, cursor and observer reads in src/native.js, all-history message hydration in src/state.js and scheduling in src/discord.js, retained notification promises in src/claude-monitor.js, and a waiting Node launcher in src/cli.js. These are concrete resource mechanisms, not individually measured leak causes. The Discord SDK has a default per-channel message cache limit, so absence of an adapter override is not proof of an unlimited cache. SQLite WAL mode was not established.

Rust removes mandatory tracing GC and offers checked ownership and exhaustive protocol states. It does not automatically cancel detached tasks, reap child processes, bound queues, remove retained files, or resolve uncertain external dispatches. Those requirements apply to every candidate. Artifact retention must preserve unresolved custody and live resources. Existing adjacent Rust tooling is useful context, not measured reuse or maintainer expertise.

## Finite checklist

- [ ] R1 Fix historical transcript reads in Node through a separate PR. Preserve cursor compatibility, byte boundaries, cancellation and existing custody behavior. Pro may author the patch, but local tests and independent review establish acceptance. No new polling policy or unrelated feature work belongs in this fix.
- [ ] R2 Build a dependency-complete Rust smoke test with the chosen Discord/TLS, SQLite and MCP stack. Exercise the existing Monitor notification and reply-command contract with isolated state. Cap build concurrency and measure cold build and warm edit/test costs separately. Do not start another production Gateway.
- [ ] R3 Implement one custody path: intake, durable acceptance, a fixture native queue command, bounded observation and durable reply. Keep production native sessions external and untouched. No full Go port or speculative orchestration framework.
- [ ] R4 Compare the fixed behavioral cases against Node: duplicates, stale generations, revocation, cancellation, interrupted submission, restart and reply ambiguity. Check durable outcomes, not only final arithmetic text. Perform one ordinary generation/cancellation change to expose actual review and iteration costs.
- [ ] R5 Run matched idle, burst, growing-transcript and recovery workloads plus a bounded soak on the same Mac. Record process topology, physical footprint, separately labeled aggregate RSS, CPU, latency, bytes read and retained-resource growth. Include concurrent build pressure. Do not invent an approved resource budget.
- [ ] R6 Publish the slice report. Continue Rust parity only if measured benefits and integration costs support it. Both-provider parity, sleep/wake recovery and exclusive rollback-safe cutover remain later deployment requirements.

Accepted cost: one small Node repair and one Rust slice before committing to a full migration. Reopen the Rust preference if its contracts require substantial scope expansion or a permanent Node bridge that removes the intended benefit, or if repeated matched runs show no persistent-footprint advantage while CPU, build contention or actual maintenance effort worsens. A repairable defect is a fix requirement, not automatic evidence against a language. Mixed results need a concrete trade-off decision. A Rust failure does not establish Go as the winner.

The sidecar goal remains active and incomplete. Its publisher, model experiments, source-producer adoption and installed two-provider proof are not replaced by this runtime investigation. No production service was restarted during research.

## Primary references

- [Go GC trade-offs and soft memory limit](https://go.dev/doc/gc-guide)
- [Rust ownership](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)
- [Tokio task handle behavior](https://docs.rs/tokio/latest/tokio/task/struct.JoinHandle.html)
- [Cargo build concurrency](https://doc.rust-lang.org/cargo/commands/cargo-build.html)
- [Node memory accounting](https://nodejs.org/api/process.html)
- [Official MCP SDK tiers](https://modelcontextprotocol.io/docs/2026-07-28/sdk)
