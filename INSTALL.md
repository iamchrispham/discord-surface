# Install on a new host

This guide is for the agent performing installation. Preserve the host's existing native sessions. Installing the package does not bind a session or prove delivery.

## Release and prerequisites

Use the exact release commit or package supplied by the release owner. Record its full commit and package SHA-256. Do not substitute the latest branch while following a frozen handoff. This guide has no default release.

Required: Git, npm, Node >=22.13.0 and <23, access to this private repository or its release package, and an existing authenticated native Codex or Claude session. Runtime dependencies are pinned by `package-lock.json`. No globally installed compiler is needed at runtime.

Before runtime setup obtain the intended guild, operator, category and channel IDs from the release owner, plus a securely provisioned bot secret file. Never copy another host's state database, native UUID, binding generation, transcript or token into a report. Coordinate with the existing Gateway owner before connecting another host to the same guild. Local singleton locks do not coordinate across hosts.

## Build and inspect the package

Before either full gate, obtain the host's supported admission executable from
its owner and set `APERTURE_GATE_ADMISSION_COMMAND` to its absolute path. It
must support `--full-gate`, `--holder`, `--max-wait` and `--ticket`. Set
`APERTURE_GATE_TIME_LEFT_S` to the caller's remaining seconds and
`APERTURE_GATE_SLOWEST_RUN_S` to the measured full execution allowance. The
defaults are 7200 and 3600 seconds. Both wait and execution must fit the caller.
Exit 98 with one `APERTURE-GATE-INDETERMINATE` line means no verdict. The
`setup` and `queue-missing` reasons require admission setup repair before retry.
The `cleanup` reason requires the gate's owned process group or scratch directory
to be inspected and cleaned before retry. `capacity` means reschedule later with
the same ticket so admission retains the queue arrival. `interrupted`, `stale`
and `timeout` do not establish a package or test pass. A raw body exit 98
without the marker is the command result, not a no-verdict result.

In a new checkout, replace `RELEASE_COMMIT` with the full commit supplied by the release owner, then select it:

```sh
git clone https://github.com/iamchrispham/discord-surface.git
cd discord-surface
git checkout --detach RELEASE_COMMIT
node --version
npm ci
python3 -I scripts/full-gate/supervisor.py -- npm test
python3 -I scripts/full-gate/supervisor.py -- npm run package-smoke
npm pack
```

These commands can be entered separately from the repository root. Stop on the first nonzero exit and save the exact command and redacted error. The supervisor requires `NODE_OPTIONS` to be unset, tracks Linux descendants when subreaper and pidfd support are available, and compares the source fingerprint after they exit. Unsupported hosts return no verdict. Add support for another host only when its supervisor accounts for every descendant before the final fingerprint. `npm test` runs the registered build, typecheck and test suite after admission. `package-smoke` creates an isolated installation and imports the package without starting the Gateway. Passing it proves packaging on that host, not native transport support.

Install the resulting tarball into a dedicated prefix with `npm install --prefix <absolute-prefix> <absolute-tarball>`. The CLI is `<absolute-prefix>/node_modules/discord-surface/src/cli.js`. Resolve that absolute path and use it consistently for all callers on this host. Compare the installed package with the frozen artifact before configuring it.

## OS boundary

- macOS: the existing runtime uses `lockf`, POSIX process inspection, signals and Unix sockets. Follow the configuration and attachment steps below after verifying these prerequisites.
- Linux: build/package checks are a useful starting point, but runtime qualification is not established. The CLI invokes BSD-style `lockf -t ... -k` for binding and Gateway singleton locks. A Linux `flock` executable is not a drop-in replacement. Stop before bind/start if the required command and semantics are absent. Do not rename a binary or call internal unlocked commands to bypass this.
- macOS: full-gate execution uses one temporary user-session launchd job. It requires an isolated resource coalition, readable task counters, and process-identity-safe signaling. Missing capabilities return no verdict before test or package work starts.
- Windows: full-gate execution needs a supported process-ownership supervisor and otherwise returns no verdict. Standalone build and typecheck can report compiler compatibility. Native runtime installation is not qualified. POSIX locking, process identity, permissions, signals and socket behavior need a supported implementation before live setup. PowerShell syntax changes alone do not resolve those dependencies. WSL is a separate Linux environment and cannot be treated as proof of delivery to a Windows-native session.

The receiving agent should report the first concrete missing prerequisite with OS, architecture, Node version and exact error. Do not create replacement executors or weaken identity/locking checks to get past it.

## Configure on a compatible host

Use a fresh private state directory. On POSIX systems:

```sh
mkdir -m 700 -p "$HOME/.config/discord-surface"
chmod 600 /absolute/path/to/discord.env
node /absolute-prefix/node_modules/discord-surface/src/cli.js configure \
  --state-dir "$HOME/.config/discord-surface" \
  --guild-id DISCORD_GUILD_ID --operator-id DISCORD_USER_ID \
  --secret-file /absolute/path/to/discord.env \
  --codex-category-id CODEX_CATEGORY_ID --claude-category-id CLAUDE_CATEGORY_ID
```

The secret file contains `DISCORD_TOKEN=...`. Provision it securely, never echo it or include it in a transcript. The placeholders above must come from the intended deployment, not from an example host.

## Attach the existing native owner

Use the provider-specific ordinary-session sections in [README.md](README.md). Run binding commands inside the existing session's own native command context. Do not manufacture caller environment variables.

Codex uses `ordinary-bind --state-dir <state> --channel-id <existing-channel>`. It verifies the native caller against its transcript. Active-turn Discord steering additionally requires a qualified route and native hook approval. A binding alone does not provide that capability.

Claude uses `ordinary-claude-bind` with the exact current transcript and a short owner-only socket path, followed by `claude-monitor` in that session's native Monitor tool. Ordinary Claude binding also depends on the local caller-identity integration at `~/.claude/hooks/session-chat-binding.mjs`, which this package does not install. If absent, obtain the supported integration from its owner instead of fabricating caller identity. Channels are an alternative only for a session already launched with the native opt-in.

After the Gateway owner authorizes this host to consume the intended guild, use the public `start --state-dir <state>` entrypoint and inspect `status --state-dir <state>`. Do not start a second consumer as a workaround. Keep all Gateway-aware CLI paths on the same installed release.

The peer MCP requires native caller identity on every invocation. A generic `codex mcp add` only saves server configuration; it does not prove that an already-running session loads the tools or passes its session identity to the MCP process. Do not add a static session UUID to that configuration. Use the installed `mcp --provider codex|claude --state-dir <state>` command only through a native integration that supplies the current caller identity and reloads the tools into that same session. If either capability is unavailable, leave peer MCP unregistered on that host.

After a qualified integration loads the tools, call `peer_list()` in the bound native session. Every `peer_send` needs a ready caller with exactly one ready enrolled child. A new request also needs one ready child at its recipient; a result using `reply_to` follows the recorded return route. Registration and a transport `sent` receipt do not prove native pickup or a correlated result. See [README.md](README.md#authenticated-peer-mcp) for tool arguments and result evidence.

Verify peer adoption in the bound native session. Updating a launcher does not refresh an existing MCP server set, and a long-lived shell may retain an old launcher function. Before the next normal resume, open a fresh shell or reload the launcher's documented initialization. Do not restart solely to pass an adoption check or hand-edit generated configuration as a durable fix.

At that attachment, verify the generated configuration uses the intended installed peer CLI. Confirm `peer_list`, `peer_send` and `peer_result` are exposed in the same session. Record the native session UUID from the qualified native integration's caller-identity evidence described above, and record the generation and child route from `peer_list()`. Then prove a signed request and correlated result through an existing recipient. A ready listener or working ad-hoc CLI does not prove peer adoption.

Peer MCP registration does not steer an active Codex turn. The adapter's Codex intake uses `codex queue --thread`, which delivers a follow-up on a later turn. Active-turn steering needs a separately qualified route to the owning native app-server.

Before a planned release cutover boots out the Gateway, inspect the active state with the same release's `status --state-dir <state>` entrypoint. Check `readiness.intakeWatermarks` and `readiness.threadEnrollments` for every state other than `ready`, including `pending`, `gap`, and `unavailable`. Record each affected channel or thread ID with its boundary detail and bounds, and distinguish retryable holds from terminal permission or identity failures. A non-ready route remains held and non-dispatchable after startup; do not clear it to make the cutover appear ready.

## Essential live check and return receipt

1. Send one real instruction to the bound channel. Record its Discord ID, actual native pickup and acknowledgment. A transport receipt alone does not prove pickup.
2. Reply through the received wrapper's exact reply path. Verify the reply in Discord and its source-message correlation.
3. Post one requested milestone from that same native owner using a stable dedupe key. Verify the visible message and receipt.

Return OS/architecture, Node version, full source commit, package hash, installed CLI path, prerequisite results and these three outcomes. Identify implementation, package checks and live proof separately. Keep credentials and transcript contents out of the report. On failure retain the existing session and accepted custody, and report the exact failed boundary. No replay, rebind or executor restart is implied by this guide.
