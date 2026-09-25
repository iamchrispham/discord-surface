# Install on a new host

This guide is for the agent performing installation. Preserve the host's existing native sessions. Installing the package does not bind a session or prove delivery.

## Release and prerequisites

Use the exact release commit or package supplied by the release owner. Record its full commit and package SHA-256. Do not substitute the latest branch while following a frozen handoff. The starting release for this guide is `22f1a3f81e035ffd993c53e79259254b0346f028`.

Required: Git, npm, Node >=22.13.0 and <23, access to this private repository or its release package, and an existing authenticated native Codex or Claude session. Runtime dependencies are pinned by `package-lock.json`. No globally installed compiler is needed at runtime.

Before runtime setup obtain the intended guild, operator, category and channel IDs from the release owner, plus a securely provisioned bot secret file. Never copy another host's state database, native UUID, binding generation, transcript or token into a report. Coordinate with the existing Gateway owner before connecting another host to the same guild. Local singleton locks do not coordinate across hosts.

## Build and inspect the package

In a new checkout, select the frozen commit:

```sh
git clone https://github.com/iamchrispham/discord-surface.git
cd discord-surface
git checkout --detach 22f1a3f81e035ffd993c53e79259254b0346f028
node --version
npm ci
npm run build
npm run typecheck
npm run package-smoke
npm pack
```

These commands can be entered separately in a POSIX shell or PowerShell. Stop on the first nonzero exit and save the exact command and redacted error. `package-smoke` creates an isolated installation and imports the package without starting the Gateway. Passing it proves packaging on that host, not native transport support.

Install the resulting tarball into a dedicated prefix with `npm install --prefix <absolute-prefix> <absolute-tarball>`. The CLI is `<absolute-prefix>/node_modules/discord-surface/src/cli.js`. Resolve that absolute path and use it consistently for all callers on this host. Compare the installed package with the frozen artifact before configuring it.

## OS boundary

- macOS: the existing runtime uses `lockf`, POSIX process inspection, signals and Unix sockets. Follow the configuration and attachment steps below after verifying these prerequisites.
- Linux: build/package checks are a useful starting point, but runtime qualification is not established. The CLI invokes BSD-style `lockf -t ... -k` for binding and Gateway singleton locks. A Linux `flock` executable is not a drop-in replacement. Stop before bind/start if the required command and semantics are absent. Do not rename a binary or call internal unlocked commands to bypass this.
- Windows: use the build/package steps to report compatibility. Native runtime installation is not qualified. POSIX locking, process identity, permissions, signals and socket behavior need a supported implementation before live setup. PowerShell syntax changes alone do not resolve those dependencies. WSL is a separate Linux environment and cannot be treated as proof of delivery to a Windows-native session.

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

Before a planned release cutover boots out the Gateway, inspect the active state with the same release's `status --state-dir <state>` entrypoint. Check `readiness.intakeWatermarks` and `readiness.threadEnrollments` for `state: gap`, and record each affected channel or thread ID with its gap bounds. A gap remains held and non-dispatchable after startup; do not clear it to make the cutover appear ready.

## Essential live check and return receipt

1. Send one real instruction to the bound channel. Record its Discord ID, actual native pickup and acknowledgment.
2. Reply through the received wrapper's exact reply path. Verify the reply in Discord and its source-message correlation.
3. Post one requested milestone from that same native owner using a stable dedupe key. Verify the visible message and receipt.

Return OS/architecture, Node version, full source commit, package hash, installed CLI path, prerequisite results and these three outcomes. Identify implementation, package checks and live proof separately. Keep credentials and transcript contents out of the report. On failure retain the existing session and accepted custody, and report the exact failed boundary. No replay, rebind or executor restart is implied by this guide.
