# Discord Surface

## Repository boundaries

This adapter connects Discord channels to existing native agent sessions. Preserve
session identity, binding generations, durable message custody, and existing CLI
contracts. Do not create replacement sessions as a delivery recovery shortcut.

## Ownership and file growth

- `src/cli.js` is the command entrypoint. Keep argument parsing and orchestration
  here. Put domain behavior with its existing owner rather than adding it inline.
- `src/state.js` owns SQLite persistence and binding/message transitions.
  `src/discord.js` owns Gateway integration. `src/native.js` owns native delivery
  and transcript observation. `src/direct-post.js` owns outbound post orchestration.
- These are existing large modules, not templates for new files. When a change adds
  a distinct responsibility, use a nearby domain-named companion. Preserve the
  public facade and move only the behavior needed for that change. Do not perform
  an unrelated whole-file rewrite to satisfy this document.
- Around 300 lines or several independent reasons to change is a review trigger,
  not a hard cap. Split by ownership, not line count. Avoid catch-all utilities,
  speculative interfaces, and a new barrel for a single tiny helper.
- Keep new scenarios in focused test files. Do not grow `test/surface.test.js`
  with unrelated scenarios. Register new suites in the explicit `npm test` list.

## TypeScript migration

Keep the supported Node runtime and CommonJS command/import contracts. Extend the
existing strict TypeScript build one owner at a time, retaining compatibility
facades where needed. Include new TypeScript owners and type tests in the relevant
`tsconfig` file lists. Do not hand-edit generated `dist/` output. A language
migration is not authorization to redesign delivery or change persisted formats.

## Validation and delivery proof

- Start with the owner test, for example `node --test test/direct-post.test.js`.
  Run `npm run build` first when the test consumes generated TypeScript output.
- `npm test` builds, typechecks, and runs the explicitly registered suites serially.
  Use it as the final behavior gate. Use `npm run package-smoke` for packaging or
  module-loading changes. Documentation-only changes need path/command and diff
  checks, not invented runtime assertions.
- Use disposable databases, temporary transcript roots, and simulated transport
  for automated tests. Never use live credentials, production databases, native
  sessions, or the shared Gateway as test fixtures.
- For custody changes, cover duplicate delivery, stale ownership, interruption,
  restart, and unknown outcomes where affected. A saved receipt, native owner
  acknowledgment, Discord acceptance, and user-visible delivery are separate facts.
- Prove regressions fail without the fix. Exercise the public lifecycle entrypoint
  when a mock would bypass the disputed behavior. Report the tested head and actual
  registered suite list. Local/package proof does not establish cross-OS or live
  Discord behavior.
- Use the repository's configured Aperture reviewer/fixer routing. Never push or
  edit a branch while its managed fixer is active. Merge only with current-head
  review and disposition of remaining findings, never because an iteration cap
  elapsed.

## Aperture command and reference resolution

In this document, `apt` means the Aperture CLI, never Debian's package manager.
Resolve its installed executable and check its help output for Aperture commands
before invoking it. If PATH resolves a different tool, use the `apt` executable
at the root of the actual Aperture checkout. Do not assume a checkout location.
If Aperture is unavailable, report that prerequisite rather than running the
system package manager or claiming the check passed.

The managed block's `docs/contracts/aperture-run-jobs/external-lane-registry-v0.md`
reference is relative to the Aperture checkout, not this repository. Read that
file there when evaluating a conflict override. If the checkout or contract is
unavailable, retain the conflict and report the missing prerequisite. Do not
copy that contract into this repository or bypass the conflict.

## Managed guidance

Keep repository-specific rules above this section. The block below belongs to
`apt setup` and can be replaced on reconciliation.

--- APERTURE BEGIN ---
## Aperture Agent Implementation Guidance

This block is managed by `apt setup`. Edit Aperture guidance in the Aperture runtime, then rerun setup instead of hand-editing this block.

- Keep implementation surfaces narrow enough that agents can read the owner module without reconstructing the whole subsystem.
- Split large mixed-responsibility files by real ownership, not by arbitrary line count.
- When a TypeScript file grows into several domains, split it into an owner directory with a barrel export instead of continuing to add unrelated contracts to one file.
- Prefer focused companion tests near the owner behavior; keep broad umbrella tests as final confirmation, not the default edit loop.
- Once an active finding, owner path, companion test, or exact failing command is known, avoid broad route/search/read work unless new evidence justifies expansion.
- Valid expansion evidence includes failing validation that points elsewhere, a type error pointing to a declaration, a review finding naming a secondary path, or a companion test/callsite needed to verify the owner change.
- Review findings do not redefine product scope. Before adding a new behavior guarantee, timer, retry or fallback, state transition, or repair for review-added code, map it to an original ticket or plan acceptance criterion or a concrete user harm.
- If neither exists, simplify or remove the unnecessary review-added mechanism, or stop for explicit operator disposition; do not mutate only to obtain a clean review. A lifecycle matrix enumerates risk but does not authorize new product guarantees.
- Use typed finite vocabularies for control-plane states, modes, policies, statuses, receipt kinds, and packet modes instead of scattered raw strings.
- In TypeScript, prefer exported `as const` value objects plus derived union types over hardcoded string unions or repeated raw string comparisons.
- Treat receipts as evidence, not success: context delivery, profile rendering, lesson retrieval, and Codemap facts do not by themselves prove behavior improved.
- Keep proof-boundary language precise. Selected, forced, rendered, exposed, adopted, helpful, and cost-saving are separate claims.
- Before launching alongside external agents, inspect the default `~/.codex/work-control/workers/*.json` lane registry with `apt doctor` or `apt --list-worktrees --json`; live conflicts warn and fresh gated conflicts refuse launch.
- Use `--allow-external-lane-conflict` only after operator review; see `docs/contracts/aperture-run-jobs/external-lane-registry-v0.md` for the read-only registry contract.
- Start validation with owner and companion checks. Run final gates after focused checks, and report broad-suite coverage only when that exact broad suite ran.
- When an agent pass needed broad context or broad validation, improve the repo shape, fix-card hint, companion test, typed vocabulary, or validation command that would make the next pass narrower.
--- APERTURE END ---
