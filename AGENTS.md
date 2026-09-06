# Discord surface

This adapter binds Discord channels to existing native sessions. Preserve native session identity, binding generations and accepted-message custody. A queue receipt, transport acknowledgment and final response are distinct evidence.

Use Node 22.5 or newer. Run `npm test` for the owning suite. Tests use isolated state and fake providers. They do not prove live Discord delivery or native owner execution.

The current installation uses host-specific dependency and skill paths described in README.md. Runtime state and credentials belong outside the repository. Do not commit tokens, session transcripts, SQLite databases or socket files.

Development enters through feature branches and PRs. Mark incomplete behavior as draft and preserve the distinction between source, installed and actually loaded versions. Current sidecar work and acceptance are tracked in `docs/spark-sidecar-roadmap.md`.
