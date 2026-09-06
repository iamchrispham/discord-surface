# Discord surface

This adapter binds Discord channels to existing native sessions. Preserve native session identity, binding generations and accepted-message custody. A queue receipt, transport acknowledgment and final response are distinct evidence.

Use Node 22.5 or newer. Run `npm test` for the owning suite. Tests use isolated state and fake providers. They do not prove live Discord delivery or native owner execution.

The current installation uses host-specific dependency and skill paths described in README.md. Runtime state and credentials belong outside the repository. Do not commit tokens, session transcripts, SQLite databases or socket files.

Development enters through feature branches and PRs. Mark incomplete behavior as draft and preserve the distinction between source, installed and actually loaded versions. Current sidecar work and acceptance are tracked in `docs/spark-sidecar-roadmap.md`.

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
