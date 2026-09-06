# Human replies to automatic updates

A human reply to a known automatic publication carries the original human text plus one immutable reference to that exact post. The reference contains the post text, snapshot ID, confirmed send time and original owner. It is historical source data, not current state or authority. No neighboring posts or session history are loaded.

## Router plan

- Objective: preserve the context of an explicit human reply without routine conductor inference.
- Domain or lane: Discord intake and native payload shaping.
- Scope: normalized reply ID, bounded lookup, atomic receipt persistence, all native payloads.
- Likely files: src/discord.js, src/state.js, src/native.js, src/claude-monitor.js, src/publication/reference.js, test/publication-reference.test.js.
- Architectural pattern: Gateway and Presenter Helper.
- Pattern rationale: acceptance owns the one-time selection. Delivery reads its immutable receipt and formats it for the existing native surface.
- Blast radius: live and replay intake both normalize through eventToInput and acceptDiscordMessage. getMessage reconstructs accepted and resumed messages. Codex prompts and Claude Channel content include the saved reference. Claude Monitor reconstructs it from accepted custody rather than trusting upstream event content. All are covered by the change. Routine automatic-post exclusion remains unchanged.
- Lifecycle matrix: input and reference commit in one transaction. A persistence failure rolls both back. Duplicate intake retains the first reference. Source replacement and SQLite reopen preserve that copy. Same-role successors may receive explicitly referenced historical posts while native delivery guards retain current authority. No new timers, sockets, sessions or file watchers. The existing Monitor payload writer owns its file lifecycle. A partial receipt index is created on database open and indexes only reference rows.
- Risks: stale context promoted to current authority, foreign-role context exposure, Monitor dropping shaped data, receipt scans in frequent message reads.
- Validation level: owning suite, consumer intake, SQLite reopen, real Monitor payload writer, negative controls and independent review.
- Why this belongs here: the adapter owns human message custody and the exact native payload, while the conductor owns interpretation and action.
- Expected output: a bounded immutable reference alongside unchanged user content.

## Panel ruling

User-harm, mechanism and product-consistency lenses approved the same-role historical policy. The exact channel, guild, vendor, repository and conductor role must match. Native UUID and generation may differ after a role handoff, but original provenance remains explicit. Unknown, unsent or mismatched posts attach nothing and do not prevent ordinary human intake. The content bound is the existing 2,000-character publication limit, not a new summary allowance.

Accepted cost: one bounded context copy per referencing message. A conductor may still need to inspect current evidence. Reopen the ruling if an eligible successor cannot interpret an explicit reply despite available context, historical source text changes execution authority, or any foreign role's context attaches.

## Local proof

Four companion scenarios cover both vendors' accepted intake, duplicate stability, source replacement, SQLite reopen, historical successor provenance, foreign repository/conductor/vendor/channel/guild exclusions, unknown and unsent posts, oversized content, unauthorized intake, transaction rollback and retry. The actual Claude Monitor writer emits an owner-only payload containing the durable reference and original human text even when supplied different upstream content. The native prompt builders preserve the same exact reference. Query-plan verification confirms the partial index is used after reopen.

The first fixture attempt exceeded the existing Unix socket path bound. The fixture prefix was shortened, cleanup was moved before binding setup, and failed fixture directories were removed. This was test setup failure, not product proof.

Two negative controls remove role scope checking and Monitor reference forwarding separately. They fail on actual reference content crossing the scope boundary or being absent from the written payload. Independent review and a follow-up review of the partial index found no remaining scoped issue.

Live Discord follow-up, the model's interpretation of the historical label, and both-provider installation remain unproven. This slice does not activate contextual automatic publication or complete the sidecar goal.

Final owning run explicitly included test/surface.test.js, test/liaison-process.test.js, test/context-interpretation.test.js, test/publication.test.js, test/direct-post.test.js and test/publication-reference.test.js. Result: 168 passed, 0 failed, 0 skipped, 16,801.565042 ms. Network and native execution remain simulated.
